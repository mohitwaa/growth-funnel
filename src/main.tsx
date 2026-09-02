import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { funnel } from './funnel';
import { ErrorBoundary } from './screens';
import { initTracking, track } from './tracking';
import './styles.css';

// Module scope runs once, so StrictMode's double mount cannot duplicate this.
initTracking();
track('funnel_start', { funnel_id: funnel.id }, { value: funnel.values.start });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
