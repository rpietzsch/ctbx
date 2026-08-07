# ctbx — Backlog

Delivery is organised as **thin vertical slices**: every milestone ends with something deployed to
GitHub Pages that a user can actually use. Nothing is built "for later".

Companion document: [spec.md](spec.md) — section references below (§) point there.

**Legend** — Size: `S` ≈ half a day, `M` ≈ 1–2 days, `L` ≈ 3–5 days.
Status: ` ` todo, `~` partially done, `x` done **and covered by passing tests**, `-` dropped.

A ticket is only marked `x` when its behaviour is exercised by tests that pass. Tickets whose code
exists but is verified only by hand are `~`, with the gap named.

---

## Status as of 2026-08-07

`task check` passes: typecheck, lint, format, **324 unit tests across 17 files**. `task build`
produces a working bundle.

| Milestone            | State                                                              |
| -------------------- | ------------------------------------------------------------------ |
| M0 Skeleton          | Complete except CI, which has never executed (no git remote yet)    |
| M1 Chat              | Complete; streaming verified by hand, not by an automated test      |
| M2 Multi-provider    | Complete except the optional OpenRouter PKCE flow                   |
| M3 MCP without auth  | Complete; tool loop not yet exercised against a live server         |
| M4 MCP OAuth         | Discovery/PKCE/validation done and tested; token exchange blocked   |

**What is blocking end-to-end MCP verification.** Against the first real server
(`azpoc.eccenca.dev`, Keycloak), discovery, client resolution and the authorization redirect all
work. The token exchange is refused by the authorization server, not by ctbx: probing it directly
shows `403 {"error":"Invalid origin"}` for every browser origin tried and `400 invalid_grant`
(i.e. origin accepted) when no `Origin` header is sent at all. This is server-side configuration —
the app origin must be added to the Keycloak client's Web Origins. Separately, that MCP endpoint's
`Access-Control-Allow-Headers` omits `Mcp-Session-Id` and `MCP-Protocol-Version`, which will block
requests after the handshake even once the token flow works. Both are risk R1 in practice.

---

## M0 — Skeleton on Pages

_Exit criterion: an empty React app is live at `https://rpietzsch.github.io/ctbx/`, and `task ci`
passes locally and in Actions._

| #    | Status | Size | Task                                                                                                                                                            |
| ---- | ------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0-1 | x      | S    | **Scaffold.** Vite 7 + React 19 + TypeScript strict, `base: '/ctbx/'`, Tailwind v4, `public/.nojekyll`, HashRouter with four routes.                             |
| M0-2 | x      | S    | **`Taskfile.yml`** implementing every target in §11. `task check` is the pre-push gate and passes.                                                               |
| M0-3 | x      | S    | **Quality tooling.** ESLint (typescript-eslint + react-hooks), Prettier, Vitest + Testing Library, `tsc --noEmit` clean.                                         |
| M0-4 | x      | S    | **`.gitignore`**, `README.md` (incl. the §7.3 warning that the repo name is baked into the OAuth client ID), MIT `LICENSE`, `.markdownlint.json`.                |
| M0-5 | ~      | M    | **CI/CD.** `.github/workflows/ci.yml` written: `task check` + build + e2e on PR, deploy-pages on `main`. **Never executed** — the directory is not a git repo yet. |

**Gap:** M0-5 cannot be marked done until a first CI run is green. `git init`, a remote, and Pages
set to "GitHub Actions" as source are prerequisites.

---

## M1 — Chat that works (OpenRouter)

_Exit criterion: a user pastes an OpenRouter key and holds a real streaming conversation._

| #    | Status | Size | Task                                                                                                                       |
| ---- | ------ | ---- | ---------------------------------------------------------------------------------------------------------------------------- |
| M1-1 | x      | S    | **Key storage.** Versioned `localStorage` wrapper with migrations, quota fallback, secret classification. 22 tests.         |
| M1-2 | x      | M    | **OpenRouter provider** via `@openrouter/ai-sdk-provider`, with `HTTP-Referer` / `X-Title` attribution and key validation.  |
| M1-3 | x      | M    | **Model picker.** Unauthenticated `/models`, 24 h cache with stale-fallback and manual refresh. 13 registry tests.          |
| M1-4 | ~      | L    | **Chat UI.** Message list, composer, streaming, stop, markdown with HTML sanitized (12 tests). Streaming itself is untested. |
| M1-5 | ~      | M    | **Conversation persistence.** IndexedDB store, sidebar, restore on load. No automated coverage of the IndexedDB layer.      |
| M1-6 | x      | S    | **Error surfaces.** Nine distinct failure kinds, each with its own message and retryability. 17 tests.                      |
| M1-7 | x      | S    | **First-run screen.** Shown when no provider key is configured; routes to Providers.                                        |

**Gaps:** M1-4 and M1-5 need a component test for the streaming render path and a fake-IndexedDB
test for conversation round-tripping.

---

## M2 — Multiple providers

_Exit criterion: the same conversation UI works against OpenAI, Anthropic and Google._

| #    | Status | Size | Task                                                                                                                        |
| ---- | ------ | ---- | ----------------------------------------------------------------------------------------------------------------------------- |
| M2-1 | x      | M    | **Provider registry** (§5.1). No provider specifics leak past `resolveModel`.                                                |
| M2-2 | x      | S    | **OpenAI provider**, incl. `baseUrl` override; conservative tool-support inference. Response parsing tested.                 |
| M2-3 | x      | M    | **Anthropic provider** with `anthropic-dangerous-direct-browser-access`, and the caveat shown at the point of key entry.     |
| M2-4 | x      | S    | **Google provider**; `models/` prefix stripped, non-generative models filtered out.                                          |
| M2-5 | x      | M    | **Settings → Providers.** Masked key field, validate, model count, forget-key, per-provider browser notes.                   |
| M2-6 | x      | S    | **Per-conversation model**, switchable mid-thread and carried into new conversations.                                       |
| M2-7 |        | S    | **OpenRouter PKCE key provisioning** (§5.4). Not started; optional.                                                          |

Model-list parsing for all four providers is covered by 24 tests in `src/providers/parse.test.ts`.

---

## M3 — MCP without auth

_Exit criterion: connect to a public remote MCP server and have the model call its tools._

| #    | Status | Size | Task                                                                                                                                    |
| ---- | ------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| M3-1 | ~      | M    | **MCP client wiring** via `StreamableHTTPClientTransport`, session id persisted. Reaches a real server's 401 correctly; no automated test. |
| M3-2 | ~      | S    | **Legacy SSE fallback** on 405/404. Implemented, never exercised.                                                                        |
| M3-3 | x      | M    | **Server config + UI.** Name / endpoint IRI form with validation; optional client ID and scopes. 18 tests on the form logic.             |
| M3-4 | x      | M    | **Tool adapter** (§6.3). JSON Schema passed through, `slug__tool` namespacing with round-trip and collision tests. 29 tests.             |
| M3-5 | ~      | L    | **Tool-call loop** with mandatory approval. The approval gate is fully tested (9 tests); the `streamText` loop around it is not.         |
| M3-6 | x      | M    | **Connection diagnostics** (§9.1). `no-cors` probe distinguishes CORS from unreachable; remedies name the exact header. 15 + 12 tests.   |
| M3-7 | x      | S    | **Tool inventory UI**, expandable per server with descriptions.                                                                          |
| M3-8 | x      | S    | **Model filtering** to tool-capable models when servers are connected.                                                                   |

**Gaps:** M3-1/M3-2/M3-5 all need a mock MCP server to exercise. That is the same fixture M4-11
requires, so they should be done together.

---

## M4 — MCP OAuth

_Exit criterion: connect to an OAuth-protected MCP server given only a name and an endpoint IRI._

| #     | Status | Size | Task                                                                                                                                       |
| ----- | ------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| M4-1  | x      | S    | **SDK capability spike — done, §7.7.** SDK 1.30.0 has CIMD and scope selection but **no RFC 9207 `iss` validation at all**. Decision: own the flow. |
| M4-2  | x      | M    | **Discovery** (§7.1). `WWW-Authenticate` parsing, well-known probing fallback, all five AS-metadata permutations, issuer-match validation. 26 tests. |
| M4-3  | x      | S    | **PKCE + state.** WebCrypto S256, 128-bit state. Verified against the RFC 7636 Appendix B vector. 13 tests.                                 |
| M4-4  | x      | M    | **CIMD document** served at `public/oauth/client-metadata.json`, with localhost callbacks so dev shares the production client ID. 10 tests. |
| M4-5  | ~      | M    | **Callback page.** Static `callback.html`, popup + `postMessage` with full-redirect fallback. Implemented; no automated test.               |
| M4-6  | x      | M    | **Response validation** (§7.5). Full RFC 9207 truth table, no URI normalization, attacker-controlled error text never displayed. 26 tests.  |
| M4-7  | x      | M    | **Token exchange & store.** `resource` on both requests, binding by (server, issuer), refresh at 80 % lifetime, revoke on disconnect. 30 tests. |
| M4-8  | x      | M    | **Registration priority** (§7.3): pre-registered → CIMD → DCR → prompt, with AS binding enforced. 8 tests.                                  |
| M4-9  | ~      | S    | **Scope selection + step-up** (§7.2). Selection and union are tested; the runtime `403 insufficient_scope` retry path is not.               |
| M4-10 | x      | M    | **Auth UX.** Per-state actions, granted scopes, token expiry, and multi-line actionable failure messages.                                   |
| M4-11 |        | M    | **MSW integration tests.** Not started — unit tests use injected `fetch` doubles instead, so no full 401 → token → authorized-call sequence. |
| M4-12 | ~      | S    | **Manual verification.** Discovery, client resolution and the authorization redirect verified against a real Keycloak-protected server. Token exchange blocked by that server's Web Origins configuration; see "Status" above. |

---

## M5 — PWA polish

Not started. `vite-plugin-pwa` is installed but not wired up; there is no service worker, manifest or
icon set yet. M5-7 (data transparency) was pulled forward and is done — `Settings → Data` enumerates
every stored item without revealing values and offers per-item and global deletion.

| #     | Status | Size | Task                                                                     |
| ----- | ------ | ---- | -------------------------------------------------------------------------- |
| M5-1  |        | M    | **Service worker** (§8.2), never intercepting provider/MCP/OAuth traffic. |
| M5-2  |        | S    | **Manifest + icons.**                                                    |
| M5-3  |        | S    | **Update prompt**, never a silent `skipWaiting`.                         |
| M5-4  |        | S    | **Offline behaviour.**                                                   |
| M5-5  |        | S    | **CSP + hardening** (§9.2).                                              |
| M5-6  |        | M    | **Passphrase encryption** (opt-in).                                      |
| M5-7  | x      | S    | **Data transparency screen.** Done early; storage summary is tested.      |
| M5-8  |        | S    | **Conversation export.**                                                 |
| M5-9  |        | M    | **Accessibility pass.**                                                  |
| M5-10 |        | S    | **Lighthouse.**                                                          |
| M5-11 | ~      | S    | **E2E suite.** 10 Playwright specs written; the browser install was blocked, so they have never run. |

---

## Next up, in order

1. **M0-5** — `git init`, push, confirm one green CI run. Everything else is unverifiable at the
   integration level until this exists.
2. **M4-11 + M3-1/2/5** — one mock MCP server fixture unblocks four partially-done tickets at once.
3. **M5-11** — run the e2e suite that already exists.
4. **M4-12** — finish once the Keycloak client is reconfigured (Web Origins + redirect URI), and the
   MCP endpoint adds `Mcp-Session-Id` / `MCP-Protocol-Version` to its allowed headers.
5. **M5-1..M5-6** — the actual PWA work, which has not been touched.

---

## Post-v1

Not scheduled. Listed so they are not silently forgotten.

| Item                        | Note                                                       |
| --------------------------- | ---------------------------------------------------------- |
| MCP resources and prompts   | Open question 2; tools-only in v1.                         |
| MCP elicitation and sampling | Requires UI for server-initiated requests.                 |
| Conversation import         | Pairs with M5-8.                                           |
| System prompts / personas   | Per-conversation and saved presets.                        |
| Attachments (images, PDFs)  | Provider-dependent; needs a capability matrix.             |
| Cost tracking               | Cumulative spend per provider from usage metadata.         |
| Prompt-injection heuristics | Flag suspicious tool results before showing them.          |
| Additional providers        | Mistral, Groq, Cerebras, self-hosted OpenAI-compatible.    |
| Cross-device sync           | Would breach the no-backend constraint.                    |

---

## Cross-cutting rules

These apply to every ticket and are part of each one's definition of done.

1. `task check` passes before any push.
2. No API keys, tokens, or endpoint credentials in the repository, tests, or CI.
3. Any behaviour derived from the MCP spec cites the relevant §7 subsection in a code comment, so
   spec drift is traceable.
4. Every network failure mode gets a specific user-facing message. "Something went wrong" is a bug.
5. Model output and MCP tool results are untrusted input, always rendered inert.
6. New stored data is added to the M5-7 transparency screen in the same change.
7. A ticket is `x` only when tests cover it and pass. Hand-verified work is `~` with the gap named.
