import { useEffect, useState } from 'react';
import type { McpServerConfig } from '@/config/schema';
import {
  mcpServerStore,
  preferencesStore,
  removeMcpServer,
  setMcpServerEnabled,
  setToolAlwaysAllowed,
  setToolCategoryAlwaysAllowed,
  upsertMcpServer,
} from '@/config/stores';
import { useStore } from '@/storage/useStore';
import { createServerConfig } from '@/mcp/manager';
import { buildServerConfig } from '@/mcp/server-form';
import type { Diagnosis } from '@/mcp/diagnostics';
import type { ConnectionSnapshot, ConnectionState } from '@/mcp/connection';
import { canonicalHeaderName } from '@/mcp/header-negotiation';
import { alwaysAllowCategoryKey, alwaysAllowKey, type McpToolDescriptor } from '@/mcp/tool-adapter';
import {
  groupByCategory,
  isBulkApprovable,
  TOOL_CATEGORY_DESCRIPTION,
  TOOL_CATEGORY_LABEL,
  TOOL_CATEGORY_TONE,
  type ToolCategory,
} from '@/mcp/tool-categories';
import { mcpManager } from '@/state/chat';
import { Badge, Button, Card, ErrorNote, Field, Input } from '@/ui/primitives';

const STATE_TONE: Record<ConnectionState, 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'> = {
  disconnected: 'neutral',
  connecting: 'accent',
  authorizing: 'accent',
  'needs-auth': 'warn',
  connected: 'ok',
  error: 'danger',
};

const STATE_LABEL: Record<ConnectionState, string> = {
  disconnected: 'disconnected',
  connecting: 'connecting…',
  authorizing: 'authorizing…',
  'needs-auth': 'needs authorization',
  connected: 'connected',
  error: 'error',
};

export function ServersPage() {
  const servers = useStore(mcpServerStore);
  const [, force] = useState(0);
  const [editing, setEditing] = useState<McpServerConfig | undefined>();

  useEffect(() => {
    mcpManager.sync();
    return mcpManager.subscribe(() => force((n) => n + 1));
  }, [servers]);

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">MCP servers</h1>
          <p className="text-sm text-fg-muted">
            Remote MCP servers over HTTP. A name and an endpoint IRI are usually all that is needed
            — authorization is discovered automatically.
          </p>
        </div>
        <Button variant="primary" onClick={() => setEditing(createServerConfig({}))}>
          Add server
        </Button>
      </header>

      {editing ? (
        <ServerForm
          value={editing}
          onCancel={() => setEditing(undefined)}
          onSave={(config) => {
            upsertMcpServer(config);
            mcpManager.sync();
            setEditing(undefined);
          }}
        />
      ) : null}

      {servers.length === 0 && !editing ? (
        <Card>
          <p className="text-sm text-fg-muted">
            No servers configured yet. Note that a browser can only reach MCP servers that permit
            cross-origin requests.
          </p>
        </Card>
      ) : null}

      {servers.map((server) => (
        <ServerCard
          key={server.id}
          config={server}
          snapshot={mcpManager.get(server.id)?.getSnapshot()}
          onEdit={() => setEditing(server)}
        />
      ))}
    </div>
  );
}

function ServerCard({
  config,
  snapshot,
  onEdit,
}: {
  config: McpServerConfig;
  snapshot: ConnectionSnapshot | undefined;
  onEdit: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const state = snapshot?.state ?? 'disconnected';
  const tools = snapshot?.tools ?? [];
  // Read the diagnosis from the snapshot rather than local state: connect() and
  // diagnose() both publish there, so the panel can never show a verdict from a
  // probe that predates the current connection attempt.
  const diagnosis: Diagnosis | undefined = snapshot?.diagnosis;

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="space-y-3">
      {/*
        Identity above, controls below — always. Letting the two share a row
        when the IRI happens to be short made otherwise identical cards lay out
        differently, which reads as a rendering bug rather than as one design.
      */}
      <div className="space-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-medium">{config.name}</h2>
            {config.enabled ? (
              <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>
            ) : (
              <Badge tone="neutral">disabled</Badge>
            )}
            {config.enabled && state === 'connected' ? (
              <span className="text-xs text-fg-muted">
                {tools.length} tool{tools.length === 1 ? '' : 's'}
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-fg-muted">{config.url}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label
            className="flex items-center gap-1.5 text-xs text-fg-muted"
            title="Disabling closes the connection and withdraws this server's tools from the chat."
          >
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(event) => {
                setMcpServerEnabled(config.id, event.target.checked);
                mcpManager.sync();
              }}
            />
            Enabled
          </label>

          {!config.enabled ? null : state === 'needs-auth' ? (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void run(() => mcpManager.get(config.id)!.authorize())}
            >
              Authorize
            </Button>
          ) : state === 'connected' ? (
            <Button
              disabled={busy}
              onClick={() => void run(() => mcpManager.disconnect(config.id))}
            >
              Disconnect
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void run(() => mcpManager.connect(config.id))}
            >
              Connect
            </Button>
          )}
          {config.enabled ? (
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  // Diagnose through the connection so the probe carries the
                  // stored token; an anonymous probe always reports "needs auth".
                  // The result lands in the snapshot, which is what renders.
                  await mcpManager.get(config.id)?.diagnose();
                })
              }
            >
              Diagnose
            </Button>
          ) : null}
          <Button onClick={onEdit}>Edit</Button>
          <Button
            variant="ghost"
            onClick={() => {
              void mcpManager.disconnect(config.id, true);
              removeMcpServer(config.id);
              mcpManager.sync();
            }}
          >
            Remove
          </Button>
        </div>
      </div>

      {snapshot?.error ? (
        <ErrorNote>
          <span className="whitespace-pre-wrap">{snapshot.error}</span>
        </ErrorNote>
      ) : null}

      {state === 'connected' && snapshot?.droppedHeaders?.length ? (
        <p className="rounded-lg border border-border bg-surface-3 p-3 text-xs text-fg-muted">
          Connected with {snapshot.droppedHeaders.map(canonicalHeaderName).join(' and ')} omitted —
          this server's CORS policy does not accept{' '}
          {snapshot.droppedHeaders.length === 1 ? 'it' : 'them'} from a browser. Everything works,
          but the server should list{' '}
          {snapshot.droppedHeaders.length === 1 ? 'that header' : 'those headers'} in
          Access-Control-Allow-Headers.
        </p>
      ) : null}

      {snapshot?.hasToken ? (
        <p className="text-xs text-fg-muted">
          Access token stored
          {snapshot.grantedScopes ? (
            <>
              {' · scopes '}
              <code>{snapshot.grantedScopes}</code>
            </>
          ) : null}
          {snapshot.tokenExpiresAt
            ? ` · expires ${new Date(snapshot.tokenExpiresAt).toLocaleTimeString()}`
            : ''}
          {state === 'needs-auth' ? ' — but the server did not accept it' : ''}
        </p>
      ) : null}

      {diagnosis ? (
        <div className="rounded-lg border border-border bg-surface-3 p-3 text-xs">
          <p className="font-medium">Diagnosis: {diagnosis.kind}</p>
          <p className="mt-1 text-fg-muted">{diagnosis.message}</p>
          {diagnosis.remedy ? <p className="mt-2 whitespace-pre-wrap">{diagnosis.remedy}</p> : null}
        </div>
      ) : null}

      {tools.length > 0 ? <ToolInventory serverId={config.id} tools={tools} /> : null}
    </Card>
  );
}

/**
 * The tool list, grouped by the risk category the server annotated, with
 * pre-approval per tool and per category.
 *
 * Grouping is what makes the bulk toggle defensible: the user approves "every
 * read-only tool on this server" while looking at exactly which tools that
 * covers, rather than trusting a label.
 */
function ToolInventory({ serverId, tools }: { serverId: string; tools: McpToolDescriptor[] }) {
  const preferences = useStore(preferencesStore);
  const groups = groupByCategory(tools);

  const categoryAllowed = (category: ToolCategory) =>
    preferences.alwaysAllowedToolCategories.includes(alwaysAllowCategoryKey(serverId, category));

  return (
    <details>
      <summary className="cursor-pointer text-xs text-fg-muted">
        Tool inventory — {tools.length} tool{tools.length === 1 ? '' : 's'}
        {preferences.toolApproval === 'never' ? ' · approval is off for every tool' : ''}
      </summary>

      <div className="mt-2 space-y-3">
        {preferences.toolApproval === 'never' ? (
          <p className="text-xs text-fg-muted">
            Tool approval is set to “never” in preferences, so these pre-approvals have no effect
            until that is changed.
          </p>
        ) : null}

        {groups.map(({ category, tools: grouped }) => {
          const bulk = isBulkApprovable(category);
          const allowedByCategory = bulk && categoryAllowed(category);

          return (
            <section key={category} className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={TOOL_CATEGORY_TONE[category]}>{TOOL_CATEGORY_LABEL[category]}</Badge>
                <span className="text-xs text-fg-muted">
                  {grouped.length} · {TOOL_CATEGORY_DESCRIPTION[category]}
                </span>
              </div>

              {bulk ? (
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={allowedByCategory}
                    onChange={(event) =>
                      setToolCategoryAlwaysAllowed(
                        alwaysAllowCategoryKey(serverId, category),
                        event.target.checked
                      )
                    }
                  />
                  Always allow every {TOOL_CATEGORY_LABEL[category]} tool on this server
                </label>
              ) : (
                <p className="text-xs text-fg-muted">
                  These cannot be approved as a group — the server said nothing about what they do,
                  so each has to be decided on its own.
                </p>
              )}

              <ul className="space-y-1.5">
                {grouped.map((tool) => {
                  const key = alwaysAllowKey(serverId, tool.name);
                  const allowed = allowedByCategory || preferences.alwaysAllowedTools.includes(key);

                  return (
                    <li key={tool.name} className="flex items-start gap-2 text-xs">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={allowed}
                        // Covered by the category toggle: the box shows the
                        // effective state, and unticking it here would be a lie.
                        disabled={allowedByCategory}
                        title={
                          allowedByCategory
                            ? `Allowed by the ${TOOL_CATEGORY_LABEL[category]} category`
                            : 'Always allow this tool'
                        }
                        onChange={(event) => setToolAlwaysAllowed(key, event.target.checked)}
                      />
                      <span>
                        <code className="font-mono">{tool.name}</code>
                        {tool.description ? (
                          <span className="text-fg-muted"> — {tool.description}</span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </details>
  );
}

function ServerForm({
  value,
  onSave,
  onCancel,
}: {
  value: McpServerConfig;
  onSave: (config: McpServerConfig) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(value.name);
  const [url, setUrl] = useState(value.url);
  const [clientId, setClientId] = useState(value.clientId ?? '');
  const [scopes, setScopes] = useState((value.scopes ?? []).join(' '));
  const [autoConnect, setAutoConnect] = useState(value.autoConnect);
  const [error, setError] = useState<string>();

  const save = () => {
    const result = buildServerConfig(value, { name, url, clientId, scopes, autoConnect });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setError(undefined);
    onSave(result.config);
  };

  return (
    <Card className="space-y-3">
      <h2 className="font-medium">
        {value.name === 'New server' ? 'Add a server' : 'Edit server'}
      </h2>

      <Field label="Name" htmlFor="server-name">
        <Input
          id="server-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Corporate Memory"
        />
      </Field>

      <Field
        label="Endpoint IRI"
        htmlFor="server-url"
        hint="The MCP endpoint itself, often ending in /mcp."
      >
        <Input
          id="server-url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://mcp.example.com/mcp"
        />
      </Field>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={autoConnect}
          onChange={(event) => setAutoConnect(event.target.checked)}
        />
        Connect automatically on startup
      </label>

      <details>
        <summary className="cursor-pointer text-xs text-fg-muted">Advanced</summary>
        <div className="space-y-3 pt-2">
          <Field
            label="Client ID"
            htmlFor="server-client-id"
            hint="Only needed if the authorization server supports neither client ID metadata documents nor dynamic registration."
          >
            <Input
              id="server-client-id"
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
            />
          </Field>
          <Field
            label="Scopes"
            htmlFor="server-scopes"
            hint="Space-separated. Leave empty to use the scopes the server asks for."
          >
            <Input
              id="server-scopes"
              value={scopes}
              onChange={(event) => setScopes(event.target.value)}
            />
          </Field>
        </div>
      </details>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <div className="flex gap-2">
        <Button variant="primary" onClick={save}>
          Save
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
