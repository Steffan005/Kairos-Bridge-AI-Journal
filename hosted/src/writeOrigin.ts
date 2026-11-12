// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import type { WriteOrigin } from "../../src/journal.js";
import { CLAUDE_CONNECTOR_CLIENT_ID, CHATGPT_CONNECTOR_CLIENT_ID, GROK_CONNECTOR_CLIENT_ID, isGeminiConnectorClientId } from "./auth.js";

/** Only call with the client ID returned by the current, rechecked OAuth grant.
 * Provider identifies a validated connector client, never a particular model.
 * Display names, entry actors, caller parameters and HTTP Origin are not evidence.
 */
export function oauthWriteOrigin(clientId: string, baseURL: string): WriteOrigin {
  // The pre-registered Muse client and the Cursor metadata client are
  // intentionally unclassified. A display name or a similar client id does not
  // become a provider.
  const provider = clientId === CLAUDE_CONNECTOR_CLIENT_ID ? "claude"
    : clientId === CHATGPT_CONNECTOR_CLIENT_ID ? "chatgpt"
    : clientId === GROK_CONNECTOR_CLIENT_ID ? "grok"
    : isGeminiConnectorClientId(clientId, baseURL) ? "gemini" : null;
  return { version: 1, channel: "oauth", client_id: clientId, provider, received_at: new Date().toISOString() };
}

/** This stamp requires the authenticated owner route, independent of note authorship. */
export function ownerWriteOrigin(): WriteOrigin {
  return { version: 1, channel: "owner", client_id: null, provider: null, received_at: new Date().toISOString() };
}
