# ctbx

A browser-only, installable chat client for multiple LLM providers that can connect to remote MCP
servers — including OAuth-protected ones. It is served as static files from GitHub Pages and has no
backend of any kind.

- **Spec:** [tasks/spec.md](tasks/spec.md)
- **Backlog:** [tasks/backlog.md](tasks/backlog.md)
- **Deployed at:** https://rpietzsch.github.io/ctbx/

## What it does

- Chat against **OpenRouter, OpenAI, Anthropic and Google**, switchable mid-conversation.
- Connect to **multiple remote MCP servers** at once and expose their tools to the model in one
  conversation, with mandatory per-call approval.
- **OAuth for MCP servers** discovered from a name and an endpoint IRI alone — protected resource
  metadata, authorization server metadata, PKCE, resource indicators and client registration are all
  handled automatically.
- Everything runs in the page. API keys and OAuth tokens never leave the browser except to go
  directly to the provider or server they belong to.

## Getting started

Requires [Node](https://nodejs.org) 20+ and [go-task](https://taskfile.dev).

```sh
task setup     # install dependencies and Playwright browsers
task dev       # http://localhost:5173/ctbx/
task check     # typecheck + lint + format + unit tests — run before pushing
task ci        # what GitHub Actions runs
```

`task` with no arguments lists every target.

## Two things that will bite you

### 1. A browser is not a CLI: CORS decides what works

The single biggest constraint (spec §9.1, risk R1). A command-line MCP client such as Claude Code is
a native process and is **not subject to CORS at all**. A server that works there can still be
completely unusable from a browser. CORS is enforced by the browser, not the server.

A remote MCP server usable from ctbx must send:

```http
Access-Control-Allow-Origin: https://rpietzsch.github.io
Access-Control-Allow-Methods: POST, GET, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version
Access-Control-Expose-Headers: WWW-Authenticate, Mcp-Session-Id
```

`Mcp-Session-Id` and `MCP-Protocol-Version` in `Allow-Headers` are the ones most often missed: the
client sends `MCP-Protocol-Version` on every request _after_ the handshake, so a server that omits it
appears to work for one call and then fails. `Expose-Headers` matters too — without
`WWW-Authenticate` the client cannot read the auth challenge (it falls back to well-known probing),
and without `Mcp-Session-Id` sessions cannot resume.

The **Diagnose** button on each server names the specific missing piece rather than reporting
"failed to fetch".

If the authorization server is **Keycloak**, note that it answers the CORS preflight for any origin
and then rejects the actual token request with `403 {"error":"Invalid origin"}`. Add the app origin
to the client's _Web Origins_, and `<origin>/ctbx/oauth/callback.html` to its _Valid redirect URIs_.

### 2. The repository name is baked into the OAuth client ID

ctbx identifies itself to authorization servers with a
[Client ID Metadata Document](https://modelcontextprotocol.io/specification/draft/basic/authorization/client-registration#client-id-metadata-documents):
the `client_id` **is** the URL of [`public/oauth/client-metadata.json`](public/oauth/client-metadata.json),
and it must byte-match the URL it is served from.

```text
https://rpietzsch.github.io/ctbx/oauth/client-metadata.json
```

Renaming the repository or moving it to another owner changes that URL and **invalidates every
existing authorization**. Treat it as a public API. `src/mcp/auth/cimd.test.ts` fails if the document
and the deployed URL drift apart.

The document also lists `localhost` callbacks, so local development uses the production client ID —
no separate registration needed.

## Security posture

Stated plainly, because the design depends on it (spec §9.2):

- API keys and OAuth tokens live in `localStorage`. That is readable by **any** script running on
  this origin, so the safety of your keys rests entirely on there being no XSS. ctbx therefore loads
  **zero third-party runtime scripts** — no analytics, no CDN fonts, no error reporters.
- Model output and MCP tool results are treated as untrusted input. They are sanitized before
  rendering and never become active content.
- Every tool call requires explicit approval by default, showing the server, tool and arguments. This
  is the boundary that stops prompt injection from reaching real tools.
- **Settings → Data** lists everything stored, without ever showing a stored value, and can delete it
  per item or all at once.
- Anthropic requires an opt-in header to be called from a browser at all. It is supported, but
  OpenRouter is recommended precisely because it avoids per-vendor caveats.

## Layout

```text
src/
  app/        routes and pages
  chat/       message list, composer, model search, tool approval
  config/     stored configuration and its schemas
  engine/     the streamText turn loop and error mapping
  mcp/        connections, tool adaptation, diagnostics
  mcp/auth/   OAuth discovery, PKCE, validation, token storage
  providers/  provider registry and definitions
  storage/    localStorage wrapper and IndexedDB history
public/
  oauth/      client-metadata.json (the OAuth client ID) and callback.html
  .nojekyll   stops GitHub Pages dropping _-prefixed asset directories
```

## Licence

MIT — see [LICENSE](LICENSE).
