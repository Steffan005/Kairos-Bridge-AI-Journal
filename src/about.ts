// SPDX-License-Identifier: AGPL-3.0-or-later
/*
 * Kairos Journal: a portable, user-owned memory journal for AI apps, served over MCP.
 * Copyright (C) 2026  Steffan Douglas Haskins
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * Additional terms under AGPLv3 section 7(b) apply: the notice
 * "Kairos Journal, created by Steffan Douglas Haskins" and the copyright
 * notice above must be preserved. See the NOTICE file for the full terms.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Environment variable that sets where users can download the Corresponding Source. */
export const SOURCE_URL_ENV = "KAIROS_JOURNAL_SOURCE_URL";

export const PROGRAM_NAME = "Kairos-Bridge AI Journal";
export const CONTACT_EMAIL = "steffan.haskins@gmail.com";
export const COMMERCIAL_LICENSING =
  "Also available under a separate paid commercial license for use without the AGPL's obligations (for example in closed-source products or services), including the patent-pending technology (U.S. Provisional 63/912,083). See COMMERCIAL-LICENSE.md. Contact steffan.haskins@gmail.com.";
export const COPYRIGHT = "Copyright (C) 2026 Steffan Douglas Haskins";
export const ATTRIBUTION = "Kairos Journal, created by Steffan Douglas Haskins";
export const LICENSE_SPDX = "AGPL-3.0-or-later";
export const LICENSE_NAME = "GNU Affero General Public License, version 3 or (at your option) any later version";
export const LICENSE_URL = "https://www.gnu.org/licenses/agpl-3.0.html";
export const PATENT_NOTICE = "Patent pending, U.S. Provisional 63/912,083.";
export const WARRANTY =
  "This program comes with ABSOLUTELY NO WARRANTY. It is free software, and you are welcome to redistribute it under the terms of the GNU AGPL.";
export const ADDITIONAL_TERMS =
  'Additional term under AGPLv3 section 7(b): copies and modified versions must preserve the notices "Copyright (C) 2026 Steffan Douglas Haskins" and "Kairos Journal, created by Steffan Douglas Haskins", including in any Appropriate Legal Notices. See the NOTICE file.';

/** Folder containing package.json, LICENSE, NOTICE and src/ (two levels above dist/src/). */
export function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Hosted builds compile the shared engine inside a nested dist directory.
  // Find the actual licensed package, rather than a dependency-only adapter.
  let candidate = here;
  for (let depth = 0; depth < 7; depth++) {
    if (fs.existsSync(path.join(candidate, "package.json")) && fs.existsSync(path.join(candidate, "NOTICE"))) return candidate;
    candidate = path.dirname(candidate);
  }
  return path.resolve(here, "../..");
}

function readPackageJson(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot(), "package.json"), "utf8"));
  } catch {
    return {};
  }
}

/** A configured URL counts only if it is a real http(s) URL (placeholders like "TODO…" do not). */
function usableUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^https?:\/\/\S+$/i.test(s)) return null;
  return s;
}

export interface SourceInfo {
  url: string | null;
  configuredBy: "env" | "package.json" | "none";
  /** Plain-language description of how to get the source. */
  howToGet: string;
}

export function sourceInfo(): SourceInfo {
  const fromEnv = usableUrl(process.env[SOURCE_URL_ENV]);
  if (fromEnv) {
    return { url: fromEnv, configuredBy: "env", howToGet: `Download the complete Corresponding Source at no charge from ${fromEnv}` };
  }
  const fromPkg = usableUrl(readPackageJson()?.kairosJournal?.sourceUrl);
  if (fromPkg) {
    return { url: fromPkg, configuredBy: "package.json", howToGet: `Download the complete Corresponding Source at no charge from ${fromPkg}` };
  }
  return {
    url: null,
    configuredBy: "none",
    howToGet:
      `No public source URL is configured yet. The complete Corresponding Source (TypeScript in src/, build files, LICENSE, NOTICE) ships with this copy of the program at ${packageRoot()}. ` +
      `Whoever runs this server for others should set ${SOURCE_URL_ENV} to a public download location.`,
  };
}

export interface About {
  name: string;
  version: string;
  attribution: string;
  copyright: string;
  license: { spdx: string; name: string; url: string; file: string };
  additionalTerms: string;
  warranty: string;
  source: SourceInfo;
  commercialLicensing: { summary: string; contact: string; details: string };
  contact: string;
  patent: string;
}

export function about(version: string): About {
  return {
    name: PROGRAM_NAME,
    version,
    attribution: ATTRIBUTION,
    copyright: COPYRIGHT,
    license: { spdx: LICENSE_SPDX, name: LICENSE_NAME, url: LICENSE_URL, file: path.join(packageRoot(), "LICENSE") },
    additionalTerms: ADDITIONAL_TERMS,
    warranty: WARRANTY,
    source: sourceInfo(),
    commercialLicensing: {
      summary: COMMERCIAL_LICENSING,
      contact: CONTACT_EMAIL,
      details: path.join(packageRoot(), "COMMERCIAL-LICENSE.md"),
    },
    contact: CONTACT_EMAIL,
    patent: PATENT_NOTICE,
  };
}

/** Short legal notice for --help / --version output and MCP instructions. */
export function legalNoticeText(version: string): string {
  const s = sourceInfo();
  return [
    `${PROGRAM_NAME} (${ATTRIBUTION}). Version ${version}.`,
    `${COPYRIGHT}. License: ${LICENSE_SPDX} (${LICENSE_URL}).`,
    WARRANTY,
    `Source: ${s.url ?? s.howToGet}`,
    `Commercial licenses (use without AGPL obligations): ${CONTACT_EMAIL}`,
    PATENT_NOTICE,
  ].join("\n");
}
