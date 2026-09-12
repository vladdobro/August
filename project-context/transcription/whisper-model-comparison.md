# Сравнение моделей Whisper: large-v3-turbo vs q8_0

> Дата: 2026-09-12

## Текущая модель

**ggml-large-v3-turbo.bin** (~1,624 МБ) — Whisper Large V3 Turbo, whisper.cpp v1.8.4.

## Рекомендуемая альтернатива

**ggml-large-v3-turbo-q8_0.bin** (~874 МБ) — квантизованная версия той же модели (8-bit).

## Бенчмарки

| Параметр | large-v3-turbo (F16) | large-v3-turbo-q8_0 | Разница |
|---|---|---|---|
| Размер файла | 1,624 МБ | 874 МБ | **−46%** |
| Время обработки (тест) | 17 сек | 14 сек | **−18%** |
| Качество (WER) | baseline | ≈ идентично | без потерь |
| Потребление RAM | ~1.6 ГБ | ~0.9 ГБ | **−44%** |

## Что говорят

- **Георгий Герганов** (автор whisper.cpp): «The quality should be the same. Model size is almost half.» ([X/Twitter](https://x.com/ggerganov/status/1851326605127286860))
- **whisper.cpp Discussion #3074**: оба варианта делают одинаковые ошибки на сложном аудио, различия minor. ([GitHub](https://github.com/ggml-org/whisper.cpp/discussions/3074))
- **The Neural Base**: q8_0 — sweet spot внутри turbo: половина размера, выше скорость, без потери качества. ([Статья](https://theneuralbase.com/whisper/learn/beginner/whisper-large-v3-turbo-speed-vs-quality-tradeoff/))

## Другие варианты (для справки)

| Модель | Размер | Скорость* | Качество | Комментарий |
|---|---|---|---|---|
| tiny | ~75 МБ | ~32x RT | низкое | только для dev |
| base | ~142 МБ | ~16x RT | ниже среднего | dev/staging |
| small | ~466 МБ | ~6x RT | среднее | продакшн на слабом CPU |
| medium | ~1.5 ГБ | ~2x RT | хорошее | если turbo не подходит |
| large-v3 | ~3 ГБ | ~1x RT | лучшее | макс. точность, нужен GPU |
| **large-v3-turbo** ✅ | ~1.5 ГБ | ~3x RT | близко к large-v3 | текущий выбор |
| **large-v3-turbo-q8_0** 🎯 | ~0.9 ГБ | ~3.5x RT | ≈ large-v3-turbo | рекомендация |

\* RT = real-time; 6x RT означает 10 сек аудио → ~1.7 сек обработки.


## Вывод

Переход на q8_0 даёт ~46% экономии RAM/диска и ~18% ускорения без измеримой потери качества. Риск минимальный — замена одного файла модели.
