import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clientMetadataUrl, redirectUri, appBaseUrl } from './browser';

/**
 * Guards the Client ID Metadata Document invariant from tasks/spec.md §7.3.
 *
 * The `client_id` inside this document must byte-match the URL it is served
 * from, because authorization servers validate exactly that. It is effectively
 * a permanent public identifier: renaming the repository or changing the owner
 * silently invalidates every existing authorization (risk R6). A test is the
 * only thing standing between a rename and that breakage.
 */
// Resolved from the project root: under jsdom, import.meta.url is an http URL.
const DOCUMENT_PATH = resolve(process.cwd(), 'public/oauth/client-metadata.json');

const document = JSON.parse(readFileSync(DOCUMENT_PATH, 'utf8')) as {
  client_id: string;
  client_name: string;
  client_uri: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
};

const DEPLOYED_BASE = 'https://rpietzsch.github.io/ctbx/';

describe('client-metadata.json', () => {
  it('declares the required properties', () => {
    expect(document.client_id).toBeTruthy();
    expect(document.client_name).toBeTruthy();
    expect(Array.isArray(document.redirect_uris)).toBe(true);
  });

  it('has a client_id matching the URL it is served from', () => {
    expect(document.client_id).toBe(`${DEPLOYED_BASE}oauth/client-metadata.json`);
  });

  it('uses an https client_id with a path component, as CIMD requires', () => {
    const url = new URL(document.client_id);
    expect(url.protocol).toBe('https:');
    expect(url.pathname).not.toBe('/');
  });

  it('lists the deployed callback as a redirect URI', () => {
    expect(document.redirect_uris).toContain(`${DEPLOYED_BASE}oauth/callback.html`);
  });

  it('lists localhost callbacks so local development uses the same client ID', () => {
    expect(document.redirect_uris).toContain('http://localhost:5173/ctbx/oauth/callback.html');
    expect(document.redirect_uris).toContain('http://localhost:4173/ctbx/oauth/callback.html');
  });

  it('declares itself a public client', () => {
    expect(document.token_endpoint_auth_method).toBe('none');
  });

  it('requests the refresh grant, so sessions can be renewed', () => {
    expect(document.grant_types).toContain('authorization_code');
    expect(document.grant_types).toContain('refresh_token');
  });

  it('never carries a client secret', () => {
    expect(Object.keys(document)).not.toContain('client_secret');
  });

  it('agrees with the URLs the app derives at runtime', () => {
    // The runtime helpers build these from window.location, so under jsdom they
    // resolve to the test origin. What matters is that they compose the same
    // paths the document hard-codes for the deployed origin.
    expect(clientMetadataUrl()).toBe(`${appBaseUrl()}oauth/client-metadata.json`);
    expect(redirectUri()).toBe(`${appBaseUrl()}oauth/callback.html`);
    expect(document.client_id).toBe(`${document.client_uri}oauth/client-metadata.json`);
    expect(document.redirect_uris).toContain(`${document.client_uri}oauth/callback.html`);
  });

  it('keeps every redirect URI pointing at the same callback filename', () => {
    for (const uri of document.redirect_uris) {
      expect(uri.endsWith('/oauth/callback.html')).toBe(true);
    }
  });
});
