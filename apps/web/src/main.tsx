import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
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
