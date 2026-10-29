import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import GhostApp from './components/compact/GhostApp';
import { ThemeProvider } from './theme';
import './App.css';

// Compact Mode ghost window (AUG-156): same bundle, transparent overlay instead of the app.
const ghost = new URLSearchParams(window.location.search).get('ghost');

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  ghost === 'caption' || ghost === 'coin' ? (
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
