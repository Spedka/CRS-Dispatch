import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import TvBoard from './TvBoard.jsx';
import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { installAuthFetch } from './auth.js';

// Attach the office Bearer token to every /api request (and bounce to login on
// a 401). Installed before anything renders. Harmless on /tv (no token).
installAuthFetch();

// No router in this app -- /tv is a second, completely separate mount that
// never touches App's state. Cloudflare's SPA fallback (wrangler.toml
// not_found_handling = "single-page-application") already resolves any
// unmatched path, including /tv, to this same index.html/bundle, so this
// pathname branch is the only piece needed to make /tv render something
// different -- the warehouse TV kiosk display (see TvBoard.jsx).
const isTv = window.location.pathname.replace(/\/+$/, '') === '/tv';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isTv ? <TvBoard /> : <App />}
  </React.StrictMode>
);

// injectRegister is off in vite.config.js so we control this ourselves --
// a dispatcher can leave this open for days, and the browser's own SW
// update check basically never fires for a standalone PWA that never
// navigates. Poll manually, only apply the update once the tab isn't
// actively being looked at, so a new SW never yanks the UI out from under
// someone mid-edit.
let updateReady = false;

const updateSW = registerSW({
  onNeedRefresh() {
    updateReady = true;
  },
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    setInterval(() => {
      registration.update();
    }, 60 * 1000); // check every minute
  },
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && updateReady) {
    updateSW(true);
    updateReady = false;
  }
});
