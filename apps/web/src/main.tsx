import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createAppServices } from './services';
import './styles.css';

const services = createAppServices({
  // Diagnostics are on by default; VITE_OPENEDULAB_ANALYTICS=0 disables the adapter for a
  // build that must not send anything at all.
  analyticsEnabled: import.meta.env.VITE_OPENEDULAB_ANALYTICS !== '0',
});

// Diagnostics are best effort: send whatever is queued before the page goes away.
window.addEventListener('pagehide', () => {
  void services.flushAnalytics();
});

if (import.meta.env.DEV) {
  window.__openedulab = { services };
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root element');
}

createRoot(container).render(
  <StrictMode>
    <App services={services} />
  </StrictMode>,
);
