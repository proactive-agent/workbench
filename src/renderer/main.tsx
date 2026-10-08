// Initialize browser mock before anything else (no-op in Electron)
import './lib/browser-mock';

// Initialize i18n before React
import '../shared/i18n';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/globals.css';
import dankMonoUrl from './assets/fonts/DankMono-Regular.otf';

// Register and load the bundled terminal font before the first render. Terminals draw on a canvas
// and measure their character cells when they open, which doesn't trigger web-font loading, so
// Dank Mono must be loaded by then (capped so a font problem can't block startup)
const dankMono = new FontFace('Dank Mono', `url(${dankMonoUrl}) format('opentype')`, { weight: '400' });
const fontsReady = Promise.race([
  dankMono.load().then((face) => {
    document.fonts.add(face);
  }),
  new Promise((resolve) => setTimeout(resolve, 1500))
]).catch(() => undefined);

void fontsReady.then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});
