import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import GhostApp from './components/compact/GhostApp';
import CompactAssistantApp from './components/compact/CompactAssistantApp';
import CompactCopilotApp from './components/compact/CompactCopilotApp';
import { ThemeProvider } from './theme';
import './App.css';

// Compact Mode ghost window (AUG-156): same bundle, transparent overlay instead of the app.
const params = new URLSearchParams(window.location.search);
const ghost = params.get('ghost');
// AUG-199: compact Copilot / Assistant windows, same bundle (?panel=copilot|assistant); they follow the app theme.
const panel = params.get('panel');

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  panel === 'assistant' || panel === 'copilot' ? (
    <React.StrictMode>
      <ThemeProvider>
        {panel === 'assistant' ? <CompactAssistantApp /> : <CompactCopilotApp />}
      </ThemeProvider>
    </React.StrictMode>
  ) : ghost === 'caption' || ghost === 'coin' ? (
    <React.StrictMode>
      <GhostApp initialWidget={ghost === 'coin' ? 'ghost-coin' : 'ghost-caption'} />
    </React.StrictMode>
  ) : (
    <React.StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </React.StrictMode>
  ),
);
