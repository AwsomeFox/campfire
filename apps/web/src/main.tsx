import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Self-hosted Inter (issue #433): load font faces before app CSS so typography
// works offline / without Google Fonts, and so we never emit a nested
// `@import url(https://fonts.googleapis.com/...)` inside generated stylesheets.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/inter/800.css";
// Display serif for brand/page-title moments (issue #676) — self-hosted like Inter (#433).
import "@fontsource/fraunces/600.css";
import "@fontsource/fraunces/700.css";
import "@fontsource/fraunces/800.css";
import App from "./App";
import { ensureDeferredInstallPromptCapture } from "./features/dashboard/deferredInstallPrompt";
import { initPwaRegistration } from "./lib/pwaUpdate";
import "./index.css";

// Register service worker with prompt reload / failure recovery handling (#515).
initPwaRegistration();

// Capture `beforeinstallprompt` for the document lifetime (issue #799). The
// install banner only mounts on the campaign dashboard; starting here means we
// do not miss the one-shot Chromium event before that route is visited.
ensureDeferredInstallPromptCapture();

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
