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
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { about, sourceInfo, SOURCE_URL_ENV } from "../src/about.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");

describe("licensing", () => {
  test("LICENSE is the unmodified official AGPLv3 text", () => {
    const text = read("LICENSE");
    assert.ok(text.startsWith("                    GNU AFFERO GENERAL PUBLIC LICENSE\n                       Version 3, 19 November 2007"));
    // sha256 of https://www.gnu.org/licenses/agpl-3.0.txt (34,523 bytes)
    assert.equal(createHash("sha256").update(fs.readFileSync(path.join(root, "LICENSE"))).digest("hex"), "0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0");
  });

  test("package.json declares the same SPDX license", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.equal(pkg.license, "AGPL-3.0-or-later");
    for (const f of ["LICENSE", "NOTICE", "src"]) assert.ok(pkg.files.includes(f), `${f} must ship with the package`);
  });

  test("NOTICE carries the copyright, GNU notice and the section 7(b) attribution term", () => {
    const n = read("NOTICE");
    assert.match(n, /Copyright \(C\) 2026  Steffan Douglas Haskins/);
    assert.match(n, /either version 3 of the License, or\n\(at your option\) any later version/);
    assert.match(n, /section 7\(b\)/);
    assert.match(n, /"Kairos Journal, created by Steffan Douglas Haskins"/);
    assert.match(n, /Patent pending, U\.S\. Provisional 63\/912,083/);
  });

  test("every source file has an SPDX header, the copyright and a pointer to NOTICE", () => {
    const dirs = ["src", "test", "test-utils", "bench"];
    let checked = 0;
    for (const d of dirs) {
      for (const f of fs.readdirSync(path.join(root, d)).filter((x) => x.endsWith(".ts"))) {
        const head = read(path.join(d, f)).split("\n").slice(0, 25).join("\n");
        assert.match(head, /SPDX-License-Identifier: AGPL-3\.0-or-later/, `${d}/${f}`);
        assert.match(head, /Copyright \(C\) 2026  Steffan Douglas Haskins/, `${d}/${f}`);
        assert.match(head, /Kairos Journal, created by Steffan Douglas Haskins/, `${d}/${f}`);
        assert.match(head, /NOTICE/, `${d}/${f}`);
        checked++;
      }
    }
    assert.ok(checked >= 14);
  });

  test("source URL: env wins, otherwise package.json; placeholders are ignored", () => {
    const saved = process.env[SOURCE_URL_ENV];
    try {
      delete process.env[SOURCE_URL_ENV];
      assert.deepEqual([sourceInfo().url, sourceInfo().configuredBy], ["https://github.com/Steffan005/Kairos-Bridge-AI-Journal", "package.json"]);
      process.env[SOURCE_URL_ENV] = "TODO later";
      assert.equal(sourceInfo().configuredBy, "package.json", "a non-URL env value is ignored");
      process.env[SOURCE_URL_ENV] = "https://example.com/repo";
      assert.deepEqual([sourceInfo().url, sourceInfo().configuredBy], ["https://example.com/repo", "env"]);
      const a = about("9.9.9");
      assert.equal(a.version, "9.9.9");
      assert.ok(fs.existsSync(a.license.file));
      assert.ok(fs.existsSync(a.commercialLicensing.details));
    } finally {
      if (saved === undefined) delete process.env[SOURCE_URL_ENV];
      else process.env[SOURCE_URL_ENV] = saved;
    }
  });

  test("package metadata points at the planned repo and the contact", () => {
    const pkg = JSON.parse(read("package.json"));
    assert.equal(pkg.name, "kairos-bridge-ai-journal");
    assert.equal(pkg.author.email, "steffan.haskins@gmail.com");
    assert.equal(pkg.repository.url, "git+https://github.com/Steffan005/Kairos-Bridge-AI-Journal.git");
    assert.equal(pkg.kairosJournal.sourceUrl, "https://github.com/Steffan005/Kairos-Bridge-AI-Journal");
  });

  test("dual-licensing documents exist, are marked as summary/draft, and invent no prices", () => {
    const c = read("COMMERCIAL-LICENSE.md");
    assert.match(c, /not a contract/);
    assert.match(c, /signed by Steffan Douglas Haskins/);
    assert.match(c, /63\/912,083/);
    assert.match(c, /steffan\.haskins@gmail\.com/);
    assert.doesNotMatch(c, /[$€£]\s?\d/);
    const cla = read("CLA.md");
    assert.match(cla, /^# DRAFT/);
    assert.match(cla, /attorney review/);
    assert.match(cla, /Apache Software Foundation's \*Individual Contributor License Agreement, version 2\.2\*/);
    assert.match(read("CONTRIBUTING.md"), /Contributor License Agreement/);
    for (const f of ["NOTICE", "README.md"]) assert.doesNotMatch(read(f), /TODO/, `${f} still has a TODO`);
  });
});
