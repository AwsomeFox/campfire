/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Injected at build time by Vite's `define` (see vite.config.ts) from
// package.json's version field. Used by signed-out surfaces like the auth footer.
declare const __APP_VERSION__: string;
