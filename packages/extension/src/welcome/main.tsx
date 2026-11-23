import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../sidepanel/styles.css';
import './welcome.css';
import { WelcomeApp } from './WelcomeApp.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WelcomeApp />
  </StrictMode>,
);
