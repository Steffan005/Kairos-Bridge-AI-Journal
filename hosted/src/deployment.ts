// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import type { AccountDelivery } from "./accountAccess.js";

export interface PreviewOptions { baseURL: string; directory: string; secret: string; accountDelivery?: AccountDelivery }
export interface StagingOptions extends PreviewOptions {
  port: number;
  inviteCode: string;
  sourceRevision: string;
  trustedEdge?: "render-cloudflare";
}
export interface ServiceSettings extends PreviewOptions {
  kind: "local-private-preview" | "hosted-invited-staging";
  listenHost: string;
  listenPort: number;
  inviteCode?: string;
  sourceURL: string;
  trustedEdge?: "render-cloudflare";
}
const source = "https://github.com/Steffan005/Kairos-Bridge-AI-Journal/tree/";
function origin(baseURL: string): URL {
  const url = new URL(baseURL);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("Configure one canonical origin without a path, query, fragment or credentials");
  }
  return url;
}
export function previewSettings(options: PreviewOptions): ServiceSettings {
  const url = origin(options.baseURL);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:") {
    throw new Error("The local preview requires a loopback HTTP base URL");
  }
  return { ...options, baseURL: url.origin, kind: "local-private-preview", listenHost: url.hostname.replace(/^\[|\]$/g, ""), listenPort: Number(url.port || 80), sourceURL: source + "chatgpt/private-journal-service" };
}
export function stagingSettings(options: StagingOptions): ServiceSettings {
  const url = origin(options.baseURL);
  if (url.protocol !== "https:" || url.port || isIP(url.hostname) || !url.hostname.includes(".") || /(?:^|\.)(localhost|local|internal)$/.test(url.hostname)) {
    throw new Error("Hosted invited staging requires a canonical public HTTPS origin on port 443");
  }
  if (!isAbsolute(options.directory)) throw new Error("Set an absolute persistent staging data directory");
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("Set a valid staging listen port");
  if (typeof options.inviteCode !== "string" || options.inviteCode.length < 32) throw new Error("Set a random staging invitation secret of at least 32 characters");
  if (!/^[a-f0-9]{40}$/.test(options.sourceRevision)) throw new Error("Set the deployed Git commit for the corresponding-source link");
  if (options.trustedEdge !== undefined && options.trustedEdge !== "render-cloudflare") throw new Error("Unsupported trusted staging edge");
  return { ...options, baseURL: url.origin, kind: "hosted-invited-staging", listenHost: "0.0.0.0", listenPort: options.port, sourceURL: source + options.sourceRevision };
}
