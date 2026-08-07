import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';
import { App } from './app/App';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing');

createRoot(container).render(
  <StrictMode>
    {/*
      Hash routing, not browser routing: GitHub Pages serves static files with
      no SPA fallback, so `/ctbx/settings` would 404 on reload. See spec §3.
    */}
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>
);
