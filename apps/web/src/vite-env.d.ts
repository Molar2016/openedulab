/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENEDULAB_ANALYTICS?: string;
}

// The dev-only `window.__openedulab` hook is declared exactly once, in `./debug-hook.d.ts`.
// Declaring it in two places caused TS2717 (conflicting `Window` augmentations).
