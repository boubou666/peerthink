import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';

import { App } from './App.jsx';
import './styles/shell.css';
import './styles/canvas.css';

/**
 * Bootstrap. The only file that knows it is running in a browser —
 * everything below receives what it needs.
 *
 * HashRouter rather than BrowserRouter because the site is served from
 * GitHub Pages, which has no SPA rewrite. Swapping it is a one-line change
 * once this moves to a host that can serve index.html for any path.
 */
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
