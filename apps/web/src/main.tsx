import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
// Self-hosted Inter (issue #433): load font faces before app CSS so typography
// works offline / without Google Fonts, and so we never emit a nested
// `@import url(https://fonts.googleapis.com/...)` inside generated stylesheets.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/inter/800.css";
import App from "./App";
import "./index.css";

// Register the service worker that precaches the app shell so Campfire opens
// offline between sessions (see vite.config.ts). `autoUpdate` swaps in new
// builds silently on the next visit.
registerSW({ immediate: true });

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
