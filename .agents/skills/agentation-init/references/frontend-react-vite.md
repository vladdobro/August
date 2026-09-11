# React + Vite frontend integration

Use this pattern in the top-level app component.

```tsx
import { Agentation } from 'agentation';

function App() {
    const shouldEnableAgentation = import.meta.env.DEV;
    const agentationEndpoint = import.meta.env.VITE_AGENTATION_ENDPOINT || 'http://127.0.0.1:4747';

    return (
        <>
            {/* existing app layout, routes, providers */}
            {shouldEnableAgentation ? <Agentation endpoint={agentationEndpoint} /> : null}
        </>
    );
}
```

Implementation notes:
- Keep the mount at root scope so every route can be annotated.
- Use `import.meta.env.DEV` to avoid default production exposure.
- Keep endpoint configurable through `VITE_AGENTATION_ENDPOINT`.
