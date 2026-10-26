/**
 * Single source of truth for the dev-only `window.__openedulab` debug hook.
 *
 * The hook is installed by `main.tsx` only when `import.meta.env.DEV` is true, so that
 * local E2E runs can read the sanitised analytics ring buffer without a network endpoint.
 *
 * Declaring it once here — typed against the real service container — keeps the browser
 * app and the Playwright specs in agreement. Previously both `vite-env.d.ts` (`unknown`)
 * and `tests/e2e/m1.spec.ts` (a hand-written object type) augmented `Window`, which made
 * TypeScript reject the second declaration with TS2717 and left the spec's own reads
 * untyped (TS2339/TS7006). Do not re-declare `__openedulab` anywhere else: add fields to
 * `AppServices` and update this file if the surface ever grows.
 */
import type { AppServices } from './services';

declare global {
  interface Window {
    __openedulab?: { services: AppServices };
  }
}

export {};
