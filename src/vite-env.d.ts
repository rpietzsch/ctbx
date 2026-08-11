/// <reference types="vite/client" />

/**
 * `git describe --dirty --always` for the build, substituted by Vite's `define`
 * (see vite.config.ts). A literal at build time, not a runtime lookup.
 */
declare const __APP_VERSION__: string;
