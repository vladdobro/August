# PraxisOS Hooks — диагностика ошибок при старте сессии

**Дата**: 2026-10-31  
**Окружение**: Windows 10 Pro 10.0.19045, Claude Code (Opus 4.6), PraxisOS с MCP  
**Проект**: D:\claude\August  
**Git**: 2.55.0.windows.5 (D:\Git)

---

## Ошибка 1: bash fatal error при SessionStart

### Сообщение

```
SessionStart:startup hook error
Failed with non-blocking status code: 0
[main] bash (1896) D:\Git\bin\..\usr\bin\bash.exe: *** fatal error - add_item ("\??\D:\Git", "/", ...) failed, errno 1
```

Появляется дважды (PID 1896 и 22428) — два bash-процесса падают одновременно.

### Что показало расследование

| Проверка | Результат |
|---|---|
| `D:\Git\etc\fstab` | Стандартный, валидный (cygdrive + /tmp) |
| `D:\Git\etc\mtab` | Symlink на `/proc/mounts` — норма |
| `D:\Git\etc\nsswitch.conf` | Стандартный |
| Конфликт DLL | Единственный `cygwin1.dll` — в `C:\Program Files\AmneziaVPN\cygwin\`, отдельная директория, не в PATH, не конфликтует |
| `bash.exe -c "echo ok"` (одиночный) | **Работает**, ~149ms |
| `curl` через bash к Praxis API | **Работает**, ~139ms |
| Praxis MCP `health` | `Praxis Local API v0.1.0 running. Claude CLI: available.` |

### Вывод

**Race condition в MSYS2 рантайме** при параллельном старте нескольких bash-процессов. PraxisOS запускает 3 SessionStart хука одновременно → 3 экземпляра `bash.exe` конкурируют за инициализацию shared memory для mount-таблицы → `add_item` падает с `errno 1` (EPERM).

Одиночный bash работает стабильно. Проблема воспроизводится только при параллельном запуске.

### Влияние

Некритично — `non-blocking status code: 0` означает, что Claude Code не блокируется на ошибке. Сессия стартует, хуки в итоге отрабатывают. Задержка ~8 секунд на ожидание.

### Возможные решения

1. **Последовательный запуск хуков** — стартовать SessionStart хуки один за другим, а не параллельно
2. **Не использовать bash** — вызывать curl напрямую (PowerShell `Invoke-WebRequest` или нативный curl.exe из `C:\Windows\System32`) вместо обёртки через bash
3. **Retry с задержкой** — если первый bash падает, подождать 100ms и повторить

---

## Ошибка 2: UserPromptSubmit hook timeout

### Сообщение

```
UserPromptSubmit hook [curl -s --connect-timeout 1 -m 2 -X POST -H "X-Praxis-Token: $PRAXIS_API_TOKEN" "http://127.0.0.1:7865/api/chat-console/question-hook?session_id=6b487ee1-abd1-42be-83e6-d1c0d9d43fda&state=clear"] timed out after 5s — output discarded.
```

Происходит **регулярно**, не только при старте.

### Что показало расследование

| Проверка | Результат |
|---|---|
| Прямой запрос к эндпоинту (PowerShell) | **153ms** — ответ 401 (ожидаемо с фейковым токеном) |
| Запрос через bash + curl | **139ms** — быстро |
| Praxis MCP сервер | Жив и отвечает |
| Хук в Claude Code settings.json | **Не найден** — регистрируется динамически через Remote Control |
| Хук в `.claude.json` | Не найден |
| Хук в PraxisOS `general.yaml` | Не найден |

### Вывод

Сервер отвечает за ~140ms, bash стартует за ~150ms — суммарно запрос занимает <300ms. Но Claude Code hook runner не успевает за 5 секунд. 

**Причина**: Claude Code event loop перегружен в момент вызова хука (MCP connect, RC init, подключение серверов). Child process хука не получает CPU-слот вовремя → 5-секундный таймаут Claude Code истекает до того, как curl даже начал выполняться.

**Контекст**: через Proxy (другая сессия, днём ранее) проблема не воспроизводилась — вероятно, стартовая нагрузка была ниже.

### Влияние

Хук `state=clear` сбрасывает UI-состояние в PraxisOS панели. Пропуск хука не ломает работу, но:
- Ошибка появляется регулярно (не только при старте)
- Засоряет лог сессии предупреждениями
- UI-состояние PraxisOS может не синхронизироваться

### Возможные решения

1. **Увеличить таймаут хука** при регистрации через RC (например, 10–15s вместо дефолтных 5s)
2. **Fire-and-forget** — не ждать ответа хука вообще; curl с `--max-time 2` и так ограничивает время запроса
3. **Не использовать bash-обёртку** — запускать curl напрямую как нативный процесс, минуя bash startup overhead
4. **Перенести логику из хука в MCP** — вместо UserPromptSubmit hook отправлять `state=clear` внутри MCP tool call (например, в начале `get_task` или `search_project_context`), избегая hook runner

---

## Общая рекомендация

Обе проблемы связаны с тем, что PraxisOS полагается на **bash shell hooks** в среде, где:
- MSYS2 bash нестабилен при параллельном запуске (race condition)
- Claude Code hook runner не гарантирует своевременный запуск child process при высокой нагрузке

Оптимальный путь — **минимизировать зависимость от bash**: использовать нативные HTTP-вызовы или перенести коммуникацию в MCP-слой, который уже стабильно работает (health check отвечает мгновенно).
