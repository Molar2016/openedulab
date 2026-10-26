import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createAppServices } from './services';
import './styles.css';

const services = createAppServices({
  // Off by default: M1 has no analytics endpoint. A build may opt in explicitly.
  analyticsEnabled: import.meta.env.VITE_OPENEDULAB_ANALYTICS === '1',
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
