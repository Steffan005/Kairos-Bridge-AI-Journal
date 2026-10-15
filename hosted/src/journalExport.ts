// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import type { ServerResponse } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";

/** The caller owns the temporary export file and removes it after this settles. */
export async function streamJournalExport(res: ServerResponse, file: string): Promise<void> {
  const size = statSync(file).size;
  res.writeHead(200, { "content-type": "application/json; charset=utf-8", "content-disposition": 'attachment; filename="kairos-journal.json"', "content-length": size });
  await pipeline(createReadStream(file), res);
}
