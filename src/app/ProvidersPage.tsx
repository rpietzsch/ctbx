import { useState } from 'react';
import type { ProviderId } from '@/config/schema';
import { forgetProvider, getProviderConfig, setProviderConfig } from '@/config/stores';
import { allDefinitions, listModels, validateKey } from '@/providers/registry';
import type { ProviderDefinition } from '@/providers/types';
import { Badge, Button, Card, ErrorNote, Field, Input } from '@/ui/primitives';

export function ProvidersPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">Providers</h1>
        <p className="text-sm text-fg-muted">
          Keys are stored in this browser&apos;s local storage and sent only to the provider they
          belong to. Any script running on this page can read them, so ctbx loads no third-party
          code.
        </p>
      </header>

      {allDefinitions().map((definition) => (
        <ProviderCard key={definition.id} definition={definition} />
      ))}
    </div>
  );
}

function ProviderCard({ definition }: { definition: ProviderDefinition }) {
  const existing = getProviderConfig(definition.id);
  const [apiKey, setApiKey] = useState(existing?.apiKey ?? '');
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '');
  const [status, setStatus] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState<string>();
  const [modelCount, setModelCount] = useState<number>();

  const save = async () => {
    setStatus('checking');
    setMessage(undefined);

    const result = await validateKey(definition.id, apiKey.trim());
    if (!result.ok) {
      setStatus('error');
      setMessage(result.error);
      return;
    }

    setProviderConfig({
      providerId: definition.id,
      apiKey: apiKey.trim(),
      ...(baseUrl.trim() !== '' ? { baseUrl: baseUrl.trim() } : {}),
      enabled: true,
    });

    const models = await listModels(definition.id, { force: true });
    setModelCount(models.models.length);
    setStatus('ok');
    setMessage(
      models.error
        ? `Key accepted, but the model list could not be refreshed: ${models.error}`
        : undefined
    );
  };

  const forget = () => {
    forgetProvider(definition.id);
    setApiKey('');
    setBaseUrl('');
    setStatus('idle');
    setMessage(undefined);
    setModelCount(undefined);
  };

  const keyLooksWrong =
    apiKey.trim() !== '' && definition.keyPattern && !definition.keyPattern.test(apiKey.trim());

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="font-medium">{definition.label}</h2>
          {existing?.apiKey ? <Badge tone="ok">key saved</Badge> : null}
          {definition.id === 'openrouter' ? <Badge tone="accent">recommended</Badge> : null}
        </div>
        <a
          href={definition.keyUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="text-xs underline text-fg-muted"
        >
          Get a key
        </a>
      </div>

      {definition.browserNote ? (
        <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
          {definition.browserNote}
        </p>
      ) : null}

      <Field label="API key" htmlFor={`key-${definition.id}`}>
        <Input
          id={`key-${definition.id}`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          placeholder={definition.keyHint}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </Field>

      {keyLooksWrong ? (
        <p className="text-xs text-warn">
          That does not look like a {definition.label} key — they usually start with{' '}
          <code>{definition.keyHint}</code>. Saving it anyway is fine if you know better.
        </p>
      ) : null}

      <details>
        <summary className="cursor-pointer text-xs text-fg-muted">Advanced</summary>
        <div className="pt-2">
          <Field
            label="Base URL override"
            htmlFor={`base-${definition.id}`}
            hint="For gateways or self-hosted, OpenAI-compatible endpoints."
          >
            <Input
              id={`base-${definition.id}`}
              value={baseUrl}
              placeholder="https://…"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </Field>
        </div>
      </details>

      {status === 'error' && message ? <ErrorNote>{message}</ErrorNote> : null}
      {status === 'ok' ? (
        <p className="text-xs text-ok">
          Key verified{modelCount ? ` · ${modelCount} models available` : ''}.
          {message ? ` ${message}` : ''}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button
          variant="primary"
          onClick={() => void save()}
          disabled={apiKey.trim() === '' || status === 'checking'}
        >
          {status === 'checking' ? 'Checking…' : 'Save and verify'}
        </Button>
        {existing?.apiKey ? (
          <Button variant="ghost" onClick={forget}>
            Forget key
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

export type { ProviderId };
