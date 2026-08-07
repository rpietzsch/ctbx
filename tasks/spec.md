# ctbx — Specification

A browser-only, installable PWA chat client for multiple LLM providers, able to connect to
remote MCP servers (including OAuth-protected ones), served as static files from GitHub Pages.

- **Status:** implemented through M4, except where [backlog.md](backlog.md) marks a gap
- **Last updated:** 2026-08-07
- **Deployment target:** `https://rpietzsch.github.io/ctbx/`

---

## 1. Goals

| #   | Goal                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Installable, offline-capable PWA served entirely as static files from GitHub Pages. No backend, no serverless functions, no proxy.                                                                                            |
| G2  | Chat against multiple LLM providers, with OpenRouter as the primary/reference provider.                                                                                                                                       |
| G3  | Provider API keys live **only** in browser local storage. They are never transmitted anywhere except directly to the provider's own API.                                                                                      |
| G4  | Connect to multiple **remote** MCP servers simultaneously; expose their tools to the model in one conversation.                                                                                                               |
| G5  | Support OAuth for MCP servers using `.well-known` autodiscovery — the "Claude custom connector" flow: the user supplies a **name**, an **endpoint IRI**, and (optionally) a **client ID**, and everything else is discovered. |

### Non-goals (v1)

- Server-side anything: no accounts, no sync, no shared history, no hosted proxy.
- stdio / local MCP servers. A web page cannot spawn processes. Remote HTTP MCP only.
- Multi-user or team features.
- Fine-tuning, RAG pipelines, or document ingestion.
- Working around MCP servers or LLM providers that do not send CORS headers — see §9.1. These are
  reported to the user as a diagnosable error, not proxied around.

---

## 2. Hard constraints

These follow from G1 and shape most decisions below.

1. **Static hosting.** Only files. No request rewriting, no redirects, no server-side headers. In
   particular there is no SPA history fallback, and `Cross-Origin-Opener-Policy` /
   `Content-Security-Policy` cannot be set as HTTP headers (only via `<meta>`, which cannot express
   `frame-ancestors` or `COOP`).
2. **Subpath base.** The app is served from `/ctbx/`, not from the origin root. Every asset path,
   the service worker scope, the manifest `start_url`/`scope`, and all OAuth redirect URIs must
   account for this.
3. **Public OAuth client.** There is no confidential place to keep a client secret. All OAuth is
   authorization-code + PKCE with `token_endpoint_auth_method: "none"`.
4. **Same-origin browser sandbox.** Every outbound call — provider APIs, MCP endpoints, discovery
   documents — is subject to CORS. Anything the browser can't read, the app can't use.
5. **`localStorage` is readable by any script on the origin.** The key-storage requirement (G3) is
   therefore only as strong as the app's XSS posture. See §9.2 for the mitigations this buys.

---

## 3. Stack

| Concern     | Choice                                                          | Why                                                                                                                                        |
| ----------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Build       | Vite 7 + TypeScript (strict)                                    | Static output, `base` config for subpath, fast HMR.                                                                                        |
| UI          | React 19                                                        | Largest ecosystem for streaming chat UIs.                                                                                                  |
| Routing     | `react-router` `HashRouter`                                     | GitHub Pages has no SPA fallback; hash routing sidesteps deep-link 404s entirely without a `404.html` redirect hack.                       |
| LLM layer   | Vercel AI SDK v7 (`ai`) + per-provider packages                 | One `streamText` interface across providers; native tool-calling that maps cleanly onto MCP tools. Adding a provider ≈ adding one package. |
| MCP         | `@modelcontextprotocol/sdk` (official TS SDK), client half only | Protocol correctness, `StreamableHTTPClientTransport`, and the OAuth client machinery.                                                     |
| State       | Zustand + `persist` middleware                                  | Small, no context boilerplate, straightforward selective persistence.                                                                      |
| Styling     | Tailwind CSS v4                                                 | No runtime, no theme-provider indirection, dark mode via `prefers-color-scheme`.                                                           |
| PWA         | `vite-plugin-pwa` (Workbox, `injectManifest`)                   | Manifest generation + precache with a hand-written SW so we control what is _never_ cached (§8.2).                                         |
| Tests       | Vitest + Testing Library, Playwright (e2e), MSW (network mocks) | Vitest shares Vite's transform pipeline; MSW lets us test the OAuth and MCP flows without live servers.                                    |
| Task runner | [go-task](https://taskfile.dev) (`Taskfile.yml`)                | Single entry point for lifecycle/test/build; see §11.                                                                                      |

### 3.1 Why we own the MCP client

Earlier AI SDK majors shipped `experimental_createMCPClient`; it is not exported from `ai@7`, and it
was tools-only with no OAuth story regardless. We need the 401 → discovery → PKCE → token → retry
loop, plus `Mcp-Session-Id` handling and (later) elicitation. So: own the MCP client via the official
SDK, and adapt its `tools/list` output into AI SDK tool definitions (§6.3). The AI SDK stays
responsible for the model, not the transport.

### 3.2 Version notes (verified at implementation time)

The stack resolved to newer majors than this spec originally assumed. Points that mattered:

- **`ai@7`** — `streamText`, `stopWhen: stepCountIs(n)`, `tool()` and `jsonSchema()` are all present
  and re-exported from `ai`. v7 also has a native tool-approval mechanism (`needsApproval`,
  `toolApproval`), which we deliberately do **not** use; see §6.4.
- **`zod@4`** — `z.record()` with an enum key is now _exhaustive_. `z.partialRecord()` is what models
  "any subset of providers may be configured". Using `z.record` silently made every stored provider
  config fail validation and fall back to empty.
- **Tailwind v4** — `@theme { --color-surface: … }` generates the utility `bg-surface`. The v3-era
  arbitrary form `bg-[--color-surface]` generates _nothing at all_ and fails silently, leaving
  elements transparent with a `currentColor` border.

---

## 4. Architecture

```text
┌──────────────────────────── browser (origin: rpietzsch.github.io) ─────────────────────────────┐
│                                                                                                │
│  UI (React)                                                                                    │
│   ├─ /            chat        message list, composer, streaming, tool-call cards               │
│   ├─ /settings/providers      key entry, model picker, default model                           │
│   ├─ /settings/servers        MCP server list, add/edit, connect, auth status, tool inventory  │
│   └─ /oauth/callback.html     static popup landing page (not a React route)                    │
│                                                                                                │
│  Core                                                                                          │
│   ├─ conversation engine   streamText loop, tool execution, step limits, cancellation          │
│   ├─ provider registry     id → AI SDK model factory + key + headers                           │
│   ├─ mcp manager           one Client per configured server, lifecycle + tool aggregation      │
│   ├─ oauth client          discovery, PKCE, token store, refresh, step-up                      │
│   └─ storage               localStorage (keys, config) + IndexedDB (conversations)             │
│                                                                                                │
│  Service worker — app shell precache only. Never touches provider or MCP traffic.              │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
        │ direct fetch (CORS)                    │ direct fetch (CORS)              │ redirect
        ▼                                        ▼                                  ▼
  LLM provider APIs                        Remote MCP servers              OAuth authorization
  openrouter.ai, api.openai.com,           Streamable HTTP                 servers (user-agent
  api.anthropic.com, …                     + .well-known metadata          navigation)
```

Everything is client-side. The only "server" the app owns is the static file host, which
additionally serves one important document: the OAuth **client ID metadata document** (§7.3).

### 4.1 Source layout

```text
src/
  app/            routes, layout, error boundary
  chat/           message list, composer, streaming renderer, tool-call UI
  providers/      registry.ts, definitions/{openrouter,openai,anthropic,google}.ts
  mcp/            manager.ts, connection.ts, tool-adapter.ts, types.ts
  mcp/auth/       discovery.ts, pkce.ts, oauth-provider.ts, token-store.ts
  storage/        local.ts (keys/config), db.ts (IndexedDB conversations), migrations.ts
  engine/         conversation.ts (the streamText + tool loop), cancellation.ts
  ui/             primitives, theme
public/
  oauth/
    callback.html            static OAuth landing page
    client-metadata.json     CIMD document (§7.3)
  .nojekyll                  stops GitHub Pages' Jekyll from dropping _-prefixed asset dirs
  icons/                     PWA icons (192, 512, maskable)
```

---

## 5. LLM provider layer

### 5.1 Model

A **provider definition** is static code; a **provider configuration** is user data.

```ts
interface ProviderDefinition {
  id: 'openrouter' | 'openai' | 'anthropic' | 'google';
  label: string;
  keyUrl: string; // where the user gets a key
  keyPattern?: RegExp; // cheap client-side sanity check
  createModel(cfg: ProviderConfig, modelId: string): LanguageModel; // AI SDK model
  listModels(cfg: ProviderConfig): Promise<ModelInfo[]>;
  browserNotes?: string; // surfaced in the UI (e.g. Anthropic's CORS opt-in)
}

interface ProviderConfig {
  providerId: string;
  apiKey: string;
  baseUrl?: string; // override for gateways / self-hosted
  enabled: boolean;
}
```

The conversation engine only ever sees `LanguageModel` from the AI SDK, so provider differences stop
at the registry boundary.

### 5.2 Providers at launch

| Provider                 | Package                       | Browser specifics                                                                                                                                                                 |
| ------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenRouter** (primary) | `@openrouter/ai-sdk-provider` | CORS-enabled for browser use. Send `HTTP-Referer` + `X-Title` for attribution/leaderboards. `GET /api/v1/models` is unauthenticated → model picker works before a key is entered. |
| OpenAI                   | `@ai-sdk/openai`              | CORS-enabled.                                                                                                                                                                     |
| Anthropic                | `@ai-sdk/anthropic`           | Requires the opt-in header `anthropic-dangerous-direct-browser-access: true`. The UI must state plainly that this exposes the key to the page.                                    |
| Google                   | `@ai-sdk/google`              | Generative Language API; CORS-enabled.                                                                                                                                            |

OpenRouter is the recommended path in the UI precisely because one key reaches many models without
each vendor's browser caveats.

### 5.3 Model selection

- Model list per provider is fetched and cached (24 h, `localStorage`) with a manual refresh.
- Models are filtered to those advertising tool/function-calling when any MCP server is connected —
  a model without tool support silently ignoring 40 tools is a bad failure mode.
- The picker shows context window and per-token pricing where the provider exposes it (OpenRouter
  does for all models).

### 5.4 OpenRouter key provisioning (nice-to-have, M2)

OpenRouter offers a PKCE flow that mints a user-scoped key without the user visiting a dashboard:
redirect to `https://openrouter.ai/auth?callback_url=…&code_challenge=…&code_challenge_method=S256`,
then exchange the returned code at `POST /api/v1/auth/keys`. This reuses the same callback page and
PKCE helpers as MCP OAuth. _Verify the exact endpoint contract against current OpenRouter docs at
implementation time._

---

## 6. MCP integration

### 6.1 Transport

Streamable HTTP (`StreamableHTTPClientTransport`) is the only supported transport. Deprecated
HTTP+SSE servers are handled by fallback: if the initial `POST` to the endpoint returns 405/404,
retry as legacy SSE via `SSEClientTransport`. Session continuity uses the `Mcp-Session-Id` response
header, persisted per server so a reload can resume rather than re-initialize.

### 6.2 Server configuration

Exactly what G5 calls for — the whole form is three fields:

```ts
interface McpServerConfig {
  id: string;
  name: string; // user-facing label, e.g. "Corporate Memory"
  url: string; // endpoint IRI, e.g. https://mcp.example.com/mcp
  clientId?: string; // optional pre-registered client ID (§7.3 priority 1)
  scopes?: string[]; // optional override; normally discovered
  enabled: boolean;
  autoConnect: boolean;
}
```

Everything else — whether auth is needed at all, which authorization server, which endpoints, which
scopes — is discovered (§7.1). Adding an unauthenticated server means filling in two fields.

### 6.3 Tool adaptation

Each connected server's `tools/list` result is converted to AI SDK tools:

```ts
tool({
  description: mcpTool.description,
  inputSchema: jsonSchema(mcpTool.inputSchema), // pass MCP's JSON Schema through as-is
  execute: (args) => client.callTool({ name: mcpTool.name, arguments: args }),
});
```

Names are namespaced as `<serverSlug>__<toolName>` to avoid collisions across servers, and mapped
back on invocation. Tool inventories are refreshed on `notifications/tools/list_changed`.

### 6.4 Tool-call loop

- `streamText({ model, tools, stopWhen: stepCountIs(N) })`, `N` configurable, default 10.
- **Every tool call requires user approval by default.** The UI renders a card with server, tool,
  and arguments, and Approve / Approve-for-session / Reject. Per-tool "always allow" is opt-in and
  stored per server. This is the security boundary for prompt injection reaching real tools — it is
  not optional in v1.
- Tool results render collapsed, expandable, with a copy button. Errors surface as tool results so
  the model can react, and are also shown as an error state in the UI.
- Cancellation aborts the `streamText` `AbortSignal` and any in-flight tool calls.

---

## 7. MCP OAuth

This is the most intricate part of the app and the reason the spec is detailed here. It follows the
current MCP authorization specification (draft, post-2025-11-25), which supersedes the 2025-06-18
revision in one way that matters enormously for a static browser app: **Client ID Metadata Documents
are now the preferred registration mechanism, and Dynamic Client Registration is deprecated.**

### 7.1 Discovery chain

```text
1. Request the MCP endpoint without a token.
2. On 401:
   a. Parse WWW-Authenticate. If it carries resource_metadata="…", fetch that URL.
      Also capture the scope="…" parameter if present — it is authoritative for this operation.
   b. If absent (or unreadable — see §9.1), probe in order:
         https://host/.well-known/oauth-protected-resource/<path-of-mcp-endpoint>
         https://host/.well-known/oauth-protected-resource
3. From the Protected Resource Metadata (RFC 9728), read `authorization_servers[]`.
   Pick one (first supported; if several, let the user choose). Read `scopes_supported`.
4. Fetch authorization server metadata. For an issuer WITH a path component, try in order:
         https://as.example/.well-known/oauth-authorization-server/<path>
         https://as.example/.well-known/openid-configuration/<path>
         https://as.example/<path>/.well-known/openid-configuration
   For an issuer WITHOUT a path component:
         https://as.example/.well-known/oauth-authorization-server
         https://as.example/.well-known/openid-configuration
5. Validate: the document's `issuer` MUST equal the issuer used to build the URL. Reject otherwise.
   Record the issuer alongside the PKCE verifier for step 8.
```

### 7.2 Scope selection

1. Use the `scope` from the `WWW-Authenticate` challenge if present.
2. Otherwise use `scopes_supported` from the Protected Resource Metadata.
3. Otherwise omit `scope`.

On a runtime `403 insufficient_scope`, re-authorize with the **union** of previously requested scopes
and the challenged scopes (step-up), then retry the original request. Cap step-up attempts (3) per
server+operation to avoid loops.

### 7.3 Client registration — priority order

| Priority | Mechanism                              | In ctbx                                                                                                                                                             |
| -------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Pre-registration                       | The optional `clientId` field on the server config. Bound to the AS `issuer` that issued it; if the discovered AS changes, refuse to reuse it and surface an error. |
| 2        | **Client ID Metadata Document (CIMD)** | **The default.** Used when AS metadata advertises `client_id_metadata_document_supported: true`.                                                                    |
| 3        | Dynamic Client Registration            | Deprecated fallback, only if the AS metadata exposes a `registration_endpoint` and CIMD is unsupported. `application_type: "web"`.                                  |
| 4        | Prompt the user                        | Ask for a client ID (and, if truly unavoidable, guide the user to register one at the AS).                                                                          |

CIMD is close to ideal for this app: the client ID _is_ a stable HTTPS URL that we already host, it
requires no registration round-trip, and it is portable across authorization servers with no
re-registration. We serve at
`https://rpietzsch.github.io/ctbx/oauth/client-metadata.json`:

```json
{
  "client_id": "https://rpietzsch.github.io/ctbx/oauth/client-metadata.json",
  "client_name": "ctbx",
  "client_uri": "https://rpietzsch.github.io/ctbx/",
  "logo_uri": "https://rpietzsch.github.io/ctbx/icons/icon-192.png",
  "redirect_uris": [
    "https://rpietzsch.github.io/ctbx/oauth/callback.html",
    "http://localhost:5173/ctbx/oauth/callback.html",
    "http://127.0.0.1:5173/ctbx/oauth/callback.html"
  ],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none",
  "scope": ""
}
```

Two consequences worth stating explicitly:

- `client_id` inside the document **must** byte-match the URL it is served from. A change of
  repository name or GitHub user breaks every existing authorization. Treat this URL as an API.
- Listing the localhost callbacks lets **local development use the production client ID** — no
  separate registration for dev. Some authorization servers reject non-HTTPS redirect URIs for
  non-native clients; where that happens, fall back to a pre-registered client ID for dev.

### 7.4 Authorization request

- `response_type=code`, PKCE `S256` (`code_challenge` / `code_verifier` via WebCrypto).
- `resource=<canonical MCP server URI>` (RFC 8707) on **both** the authorization and token requests.
  Canonical form: no fragment, lowercase scheme/host, no trailing slash unless significant.
- `state`: 128 bits of `crypto.getRandomValues`, stored with the verifier and the expected issuer.
- Redirect URI: `https://rpietzsch.github.io/ctbx/oauth/callback.html`.

### 7.5 Callback handling

The callback is a **static HTML file**, not a React route — GitHub Pages will 404 on any path that
isn't a real file, and it must survive the app not being loaded.

Flow: the app opens the authorization URL in a **popup** (`window.open`). `callback.html` reads
`location.search`, `postMessage`s the result to `window.opener` (targeting the exact app origin),
and closes itself. If the popup was blocked, fall back to a full-page redirect, with the callback
page stashing the result in `sessionStorage` and navigating back to the app, which drains it on
boot. Both paths converge on the same handler.

**Validation before the code is sent anywhere** (RFC 9207):

| AS advertises `authorization_response_iss_parameter_supported` | `iss` present? | Action                                       |
| -------------------------------------------------------------- | -------------- | -------------------------------------------- |
| `true`                                                         | yes            | Compare byte-for-byte to the recorded issuer |
| `true`                                                         | no             | **Reject**                                   |
| `false`/absent                                                 | yes            | Compare byte-for-byte to the recorded issuer |
| `false`/absent                                                 | no             | Proceed                                      |

No URI normalization before comparison — no case folding, no default-port elision, no trailing-slash
fixups. On mismatch, do not act on or display `error`/`error_description`/`error_uri`. Also verify
`state` matches.

### 7.6 Tokens

- Stored in `localStorage` keyed by `(server id, AS issuer)`, alongside expiry and granted scopes.
- Refresh proactively at 80 % of lifetime and reactively on 401. Request `refresh_token` in
  `grant_types`; add `offline_access` to `scope` only if the AS lists it in `scopes_supported`.
- Never send a token to any origin other than the MCP server it was issued for. Audience binding is
  enforced client-side by keying the store on the canonical resource URI, so a token cannot leak
  across configured servers.
- Disconnecting a server clears its tokens; revocation is called if the AS exposes a
  `revocation_endpoint`.

### 7.7 SDK reliance — resolved

The M4-1 spike is done, against `@modelcontextprotocol/sdk@1.30.0`. Findings:

| Capability                                     | In the SDK?                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| Protected resource / AS metadata discovery      | Yes (`discoverOAuthProtectedResourceMetadata`, `buildDiscoveryUrls`)               |
| CIMD (URL-based client IDs, SEP-991)            | Yes, via `provider.clientMetadataUrl`, gated on `client_id_metadata_document_supported` |
| Scope selection strategy (SEP-835)              | Yes, same priority order as §7.2                                                   |
| PKCE and token exchange                         | Yes                                                                                |
| **RFC 9207 `iss` validation**                   | **No — no `iss` handling anywhere in `client/auth.js`**                             |

That last row is decisive. Without `iss` validation a mix-up attack can hand an authorization code
issued by one authorization server to a different server's token endpoint. Splitting the flow — SDK
for discovery, our own code bolted on for validation — would mean the SDK generating `state` and the
authorization URL while we try to reconstruct which issuer was expected. That reconstruction is
exactly the value the check depends on.

**Decision: own the flow.** §7.1–7.6 is implemented in `src/mcp/auth/` directly against `fetch`,
which is injectable and therefore fully unit-testable. The SDK is used for what it is
unambiguously best at: `StreamableHTTPClientTransport`, which accepts a bearer token through
`requestInit.headers`.

---

## 8. PWA & deployment

### 8.1 Build

- `vite.config.ts`: `base: '/ctbx/'`.
- `public/.nojekyll` — without it, GitHub Pages runs Jekyll, which drops directories starting with
  `_`. Silent, confusing asset 404s otherwise.
- Manifest: `id`, `name`, `short_name`, `start_url: '/ctbx/'`, `scope: '/ctbx/'`,
  `display: 'standalone'`, theme/background colors, 192/512/maskable icons.

### 8.2 Service worker

`injectManifest` strategy with a hand-written SW, because the caching rules matter:

- **Precache:** app shell (HTML, JS, CSS, icons, fonts).
- **Never cache, never intercept:** provider API calls, MCP endpoints, `.well-known` discovery
  documents, and OAuth endpoints. Serving a stale tool list or, worse, a cached token response is a
  correctness and security problem. The SW passes these straight through.
- **Navigation fallback:** app shell, with `/oauth/callback.html` explicitly excluded so an OAuth
  return is never served from cache.
- Update flow: `registerSW` with a visible "New version available — reload" prompt rather than silent
  `skipWaiting`, so a reload never lands mid-stream.

### 8.3 Offline behaviour

The shell, settings, and stored conversation history are fully available offline. Sending a message
requires the network and fails with a clear, non-destructive error — the composer keeps its content.

### 8.4 CI/CD

GitHub Actions: on push to `main`, run `task ci` (typecheck, lint, unit tests, build), then deploy
`dist/` with `actions/deploy-pages`. Pages configured for GitHub Actions as source (not branch).
PRs run `task ci` without deploying.

---

## 9. Security model

### 9.1 CORS is the defining constraint

A browser MCP client can only talk to servers that opt in. A compatible remote MCP server must send:

```text
Access-Control-Allow-Origin: https://rpietzsch.github.io    (or *)
Access-Control-Allow-Headers: Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version
Access-Control-Expose-Headers: WWW-Authenticate, Mcp-Session-Id
```

`Access-Control-Expose-Headers` is the one everybody forgets. Without `WWW-Authenticate` exposed the
app cannot read the `resource_metadata` hint or the `scope` challenge — hence the well-known probing
fallback in §7.1 step 2b, which makes such servers usable anyway. Without `Mcp-Session-Id` exposed,
sessions cannot be resumed.

The app ships a **connection diagnostic** that distinguishes network failure, CORS rejection, 401
needing auth, and protocol error, and tells the user which header the server is missing. Guessing at
"failed to fetch" is otherwise unsolvable for a user.

### 9.2 Key and token storage

Per G3, `localStorage` only. Honestly stated: this is readable by any JavaScript running on the
origin, so its safety rests entirely on there being no XSS and no third-party scripts. Therefore:

- Strict CSP via `<meta http-equiv>`: `default-src 'self'`; `connect-src` is necessarily broad
  (`https:`) since the user configures arbitrary endpoints; no `unsafe-inline` scripts; no CDN.
- Zero third-party runtime scripts. No analytics, no fonts from a CDN, no error reporters.
- Markdown rendering sanitizes HTML and never executes embedded scripts. Model output and, crucially,
  **MCP tool results** are untrusted input and are rendered as text, never as HTML.
- No key is ever written to a URL, log, or error report.
- A settings screen lists everything stored and offers per-item and global "forget".
- **Optional passphrase encryption** (M5): keys encrypted at rest with AES-GCM via WebCrypto, key
  derived by PBKDF2 from a user passphrase, unlocked once per session. This raises the bar against
  casual local inspection; it does not defeat XSS while the app is unlocked. The UI must say so
  rather than implying more.

### 9.3 Prompt injection

Tool results are attacker-controlled in the general case. Mitigations: mandatory approval for tool
calls (§6.4), server+tool shown on every call, no auto-approve by default, and no rendering of tool
output as active content.

---

## 10. UX surfaces

| Surface         | Contents                                                                                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chat**        | Conversation list (sidebar), message stream with token-level rendering, stop button, model badge, per-message token/cost readout, tool-call cards, retry/edit/branch.                                                                                |
| **Providers**   | Per-provider card: key field (masked, paste-friendly), validate button, model list, browser caveat notice, "forget key".                                                                                                                             |
| **MCP servers** | List with connection state (disconnected / connecting / needs-auth / connected / error), tool count, expandable tool inventory. Add/edit form: name, endpoint IRI, advanced → client ID, scopes. "Connect" triggers §7. "Diagnose" runs §9.1 checks. |
| **First run**   | One screen: pick OpenRouter, paste a key, start chatting. MCP is presented as an optional next step, not a prerequisite.                                                                                                                             |

Baseline accessibility: keyboard-navigable throughout, labelled controls, live region for streaming
output, visible focus, respects `prefers-reduced-motion` and `prefers-color-scheme`.

---

## 11. Tooling contract (`Taskfile.yml`)

All lifecycle operations go through go-task, so CI, local development, and documentation share one
vocabulary.

| Target                              | Does                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `task setup`                        | Install dependencies (`npm ci`) and Playwright browsers.                          |
| `task dev`                          | Vite dev server at `http://localhost:5173/ctbx/`.                                 |
| `task build`                        | Production build to `dist/`, including PWA assets.                                |
| `task preview`                      | Serve `dist/` locally at the real base path — the only faithful pre-deploy check. |
| `task test`                         | Vitest unit/component tests, single run.                                          |
| `task test:watch`                   | Vitest in watch mode.                                                             |
| `task test:e2e`                     | Playwright end-to-end tests (depends on `build`).                                 |
| `task typecheck`                    | `tsc --noEmit`.                                                                   |
| `task lint` / `task lint:fix`       | ESLint.                                                                           |
| `task format` / `task format:check` | Prettier.                                                                         |
| `task check`                        | `typecheck` + `lint` + `format:check` + `test`. The pre-push gate.                |
| `task ci`                           | `check` + `build` + `test:e2e`. What GitHub Actions runs.                         |
| `task clean`                        | Remove `dist/`, coverage, and caches.                                             |

---

## 12. Testing strategy

| Layer             | Coverage                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit              | Discovery URL construction (all five well-known permutations, path and no-path issuers), PKCE, `iss`/`state` validation truth table (§7.5) including every reject case, canonical resource URI derivation, scope union on step-up, tool name namespacing/round-trip. |
| Component         | Streaming renderer, tool-approval card, settings forms, key masking.                                                                                                                                                                                                 |
| Integration (MSW) | Full 401 → discovery → CIMD → token → authorized-call sequence against a mock MCP server; the no-`WWW-Authenticate` fallback path; token refresh; `insufficient_scope` step-up.                                                                                      |
| E2E (Playwright)  | First-run flow with a mocked provider, add-MCP-server flow, offline shell load, install-prompt presence.                                                                                                                                                             |
| Manual            | At least one real OAuth-protected MCP server and one unauthenticated one before each milestone is called done.                                                                                                                                                       |

Explicit rule: **no API keys in the repository, in tests, or in CI.** Integration tests use MSW;
manual verification uses locally entered keys.

---

## 13. Risks & open questions

| #   | Risk                                                                                            | Handling                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Remote MCP servers commonly lack browser CORS headers, making them unusable from a static page. | **Confirmed in the field.** Diagnostics name the specific missing header and the exact origin to allow (§9.1, `src/mcp/cors-remedy.ts`); well-known probing covers the most common omission. Still the single biggest adoption risk. |
| R2  | CIMD support in authorization servers is new and thin in the wild.                              | **Confirmed.** The first real server tested (Keycloak) reports `client_id_metadata_document_supported: false`, so the pre-registered client ID path (§7.3 priority 1) is doing the work, exactly as designed. |
| R3  | The pinned MCP TS SDK may not yet implement CIMD / RFC 9207 validation.                         | **Resolved, §7.7.** SDK 1.30.0 has CIMD but no `iss` validation at all. The flow is implemented in `src/mcp/auth/`; the SDK provides transport only. |
| R4  | `localStorage` key storage is XSS-fragile.                                                      | Strict CSP, zero third-party scripts, sanitized rendering, optional passphrase encryption — and honest UI copy (§9.2).                                                               |
| R5  | Anthropic direct-from-browser needs a header whose own name warns against it.                   | Supported, but OpenRouter is the recommended default; the caveat is shown at the point of key entry.                                                                                 |
| R6  | The CIMD `client_id` URL is effectively permanent; renaming the repo invalidates it.            | Documented in §7.3 and in the repo README.                                                                                                                                           |
| R7  | MCP spec is a moving draft.                                                                     | Pin the protocol revision, keep §7 as the single source of truth, re-verify against the spec at each milestone.                                                                      |

**Open questions**

1. Should conversation history be exportable/importable (JSON) in v1, or deferred? _Proposed:
   export in M5, import later._
2. Do we support MCP **resources** and **prompts**, or tools only in v1? _Proposed: tools in v1;
   resources/prompts tracked as post-v1._
3. Multiple concurrent authorization servers listed in one PRM — auto-pick first, or always ask?
   _Proposed: auto-pick when there is exactly one, ask otherwise._
4. Does the passphrase encryption option (§9.2) belong in v1 at all, given it cannot defeat XSS?
   _Proposed: yes, as opt-in, with honest copy._
