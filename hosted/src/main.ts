// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { createPreview } from "./service.js";
const baseURL = process.env.KAIROS_PREVIEW_URL ?? "http://127.0.0.1:18790";
const directory = process.env.KAIROS_PREVIEW_DATA;
const secret = process.env.KAIROS_PREVIEW_SECRET;
if (!directory || !secret) throw new Error("Set KAIROS_PREVIEW_DATA and KAIROS_PREVIEW_SECRET outside Git before starting the synthetic preview");
const preview = await createPreview({ baseURL, directory, secret });
await preview.listen();
process.stderr.write(`Kairos synthetic preview: ${baseURL}\nSynthetic .test accounts only. No public hosting or phone connection is enabled.\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { preview.close().then(() => process.exit(0), () => process.exit(1)); });
