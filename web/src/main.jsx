import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import TvBoard from './TvBoard.jsx';
import './styles.css';

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
