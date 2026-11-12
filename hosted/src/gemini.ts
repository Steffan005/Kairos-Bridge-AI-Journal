// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
import { fetchClientMetadataResource } from "@better-auth/cimd/node";

export const GEMINI_JWKS_URL = "https://www.gstatic.com/account-linking/.well-known/client-assertion-signature-verification-key.json";

/** Google-owned consumer identity bound to one account and this service host. */
export function isGeminiConnectorClientId(clientId: string, baseURL: string): boolean {
  let origin: URL;
  try { origin = new URL(baseURL); } catch { return false; }
  if (origin.protocol !== "https:" || origin.port || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash) return false;
  const boundHost = origin.hostname.replaceAll(".", "_").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^https://accountlinking\\.google\\.com/clientidmetadata/user_bound_provider/user_bound_custom-mcp-[0-9]{21}-" + boundHost + "$").test(clientId);
}

async function boundedJson(response: Response, limit: number): Promise<Record<string, unknown>> {
  if (response.status !== 200 || response.redirected ||
      !/^application\/(?:json|[\w.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel(); throw new Error("Google metadata/key response must be direct HTTP 200 JSON");
  }
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel(); throw new Error("Google metadata/key response is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Google metadata/key response has no body");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new Error("Google metadata/key response is too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Google metadata/key response must be an object");
  return parsed;
}

const exactSet = (value: unknown, expected: string[]): boolean => Array.isArray(value) &&
  value.length === expected.length && new Set(value).size === expected.length && value.every(v => expected.includes(v));

/**
 * Better Auth 1.7.7 requires remote key URLs to share the metadata origin or a
 * browser trusted origin. Google uses a separate key host. Resolve ONLY that
 * exact public key resource into inline JWKS instead of trusting another browser
 * origin. The underlying DNS-pinned/no-redirect transport remains in force.
 */
export function geminiMetadataFetcher(baseURL: string, upstream: typeof fetchClientMetadataResource = fetchClientMetadataResource): typeof fetchClientMetadataResource {
  return async (input, init) => {
    const clientId = input instanceof Request ? input.url : input.toString();
    if (!isGeminiConnectorClientId(clientId, baseURL)) return upstream(input, init);
    // A 304 for an unchanged metadata document does not establish key freshness.
    // Re-fetch both documents when the bounded metadata cache expires.
    const headers = new Headers(init?.headers);
    headers.delete("if-none-match"); headers.delete("if-modified-since");
    const metadata = await boundedJson(await upstream(input, { ...init, headers, redirect: "error" }), 5 * 1024);
    const slug = new URL(clientId).pathname.split("/").at(-1)!;
    const callbacks = ["oauth-redirect", "oauth-redirect-sandbox", "oauth-redirect-test"].flatMap(host =>
      ["r", "a"].map(path => `https://${host}.googleusercontent.com/${path}/${slug}`));
    if (metadata.client_id !== clientId || metadata.jwks_uri !== GEMINI_JWKS_URL || metadata.jwks !== undefined ||
        metadata.token_endpoint_auth_method !== "private_key_jwt" || metadata.token_endpoint_auth_signing_alg !== "RS256" ||
        !exactSet(metadata.redirect_uris, callbacks) || !exactSet(metadata.grant_types, ["authorization_code", "refresh_token"]) ||
        !exactSet(metadata.response_types, ["code"]) || typeof metadata.scope !== "string" ||
        !(exactSet(metadata.scope.split(" "), ["journal:read", "journal:write"]) ||
          exactSet(metadata.scope.split(" "), ["journal:read", "journal:write", "offline_access"]))) {
      throw new Error("Google client metadata does not match the observed host-bound signed connector profile");
    }
    const jwks = await boundedJson(await upstream(GEMINI_JWKS_URL, {
      headers: { accept: "application/json" }, redirect: "error", signal: init?.signal,
    }), 64 * 1024);
    if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.some(key =>
      !key || typeof key !== "object" || Array.isArray(key) || key.kty !== "RSA" || key.alg !== "RS256" ||
      (key.use !== undefined && key.use !== "sig") || typeof key.kid !== "string" || !key.kid ||
      typeof key.n !== "string" || typeof key.e !== "string" ||
      ["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some(field => field in key))) {
      throw new Error("Google key resource must contain only public RSA signing keys");
    }
    delete metadata.jwks_uri; metadata.jwks = jwks;
    const body = JSON.stringify(metadata);
    // Preserve the existing MCP metadata cap; never omit a key to fit it.
    if (Buffer.byteLength(body, "utf8") > 5 * 1024) throw new Error("Google inline key metadata exceeds the MCP metadata size cap");
    // At most 60 seconds of key staleness; avoid exhausting CIMD's existing fetch
    // budget during the several client resolutions of one authorization flow.
    return new Response(body, { headers: { "content-type": "application/json", "cache-control": "max-age=60" } });
  };
}
