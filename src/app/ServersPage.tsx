import { useEffect, useState } from 'react';
import type { McpServerConfig } from '@/config/schema';
import { mcpServerStore, removeMcpServer, upsertMcpServer } from '@/config/stores';
import { useStore } from '@/storage/useStore';
import { createServerConfig } from '@/mcp/manager';
import { buildServerConfig } from '@/mcp/server-form';
import { diagnoseConnection, type Diagnosis } from '@/mcp/diagnostics';
import type { ConnectionSnapshot, ConnectionState } from '@/mcp/connection';
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
  const [diagnosis, setDiagnosis] = useState<Diagnosis>();
  const [busy, setBusy] = useState(false);
  const state = snapshot?.state ?? 'disconnected';
  const tools = snapshot?.tools ?? [];

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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-medium">{config.name}</h2>
            <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>
            {state === 'connected' ? (
              <span className="text-xs text-fg-muted">
                {tools.length} tool{tools.length === 1 ? '' : 's'}
              </span>
            ) : null}
          </div>
          <p className="truncate text-xs text-fg-muted">{config.url}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          {state === 'needs-auth' ? (
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
          <Button
            disabled={busy}
            onClick={() => void run(async () => setDiagnosis(await diagnoseConnection(config.url)))}
          >
            Diagnose
          </Button>
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

      {snapshot?.grantedScopes ? (
        <p className="text-xs text-fg-muted">
          Granted scopes: <code>{snapshot.grantedScopes}</code>
          {snapshot.tokenExpiresAt
            ? ` · token expires ${new Date(snapshot.tokenExpiresAt).toLocaleTimeString()}`
            : ''}
        </p>
      ) : null}

      {diagnosis ? (
        <div className="rounded-lg border border-border bg-surface-3 p-3 text-xs">
          <p className="font-medium">Diagnosis: {diagnosis.kind}</p>
          <p className="mt-1 text-fg-muted">{diagnosis.message}</p>
          {diagnosis.remedy ? <p className="mt-2 whitespace-pre-wrap">{diagnosis.remedy}</p> : null}
        </div>
      ) : null}

      {tools.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs text-fg-muted">Tool inventory</summary>
          <ul className="mt-2 space-y-1.5">
            {tools.map((tool) => (
              <li key={tool.name} className="text-xs">
                <code className="font-mono">{tool.name}</code>
                {tool.description ? (
                  <span className="text-fg-muted"> — {tool.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
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
