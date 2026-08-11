import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

// The app is served from a GitHub Pages subpath, not the origin root.
// This value is load-bearing: it must match Taskfile.yml BASE_PATH, the PWA
// manifest scope/start_url, and the OAuth redirect URIs in the CIMD document.
// See tasks/spec.md §2 and §7.3.
export const BASE_PATH = '/ctbx/';

export default defineConfig({
  base: BASE_PATH,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png'],
      manifest: {
        id: BASE_PATH,
        name: 'ctbx — browser MCP chat',
        short_name: 'ctbx',
        description: 'Browser-only chat client for multiple LLM providers with remote MCP support.',
        start_url: BASE_PATH,
        scope: BASE_PATH,
        display: 'standalone',
        orientation: 'any',
        // Matches --color-surface (dark), so the splash and the status bar do
        // not flash a different colour than the app behind them.
        background_color: '#0b0d10',
        theme_color: '#0b0d10',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            // Separate art with a wider margin: Android crops this one to a
            // circle or squircle, and the "any" icons would lose their edges.
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        navigateFallback: `${BASE_PATH}index.html`,
        // The OAuth callback is a real static document that the popup navigates
        // to. Letting the SPA fallback answer for it would hand back the app
        // shell instead, and the authorization code would never be read.
        navigateFallbackDenylist: [/\/oauth\//],
      },
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'tests/unit/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**'],
    },
  },
});
