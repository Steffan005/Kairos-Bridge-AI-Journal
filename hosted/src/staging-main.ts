// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { createStaging } from "./service.js";
const baseURL = process.env.KAIROS_STAGING_URL ?? process.env.RENDER_EXTERNAL_URL;
const directory = process.env.KAIROS_STAGING_DATA;
const secret = process.env.KAIROS_STAGING_SECRET;
const inviteCode = process.env.KAIROS_STAGING_INVITE;
const sourceRevision = process.env.RENDER_GIT_COMMIT ?? process.env.KAIROS_SOURCE_REVISION;
if (!baseURL || !directory || !secret || !inviteCode || !sourceRevision) throw new Error("Set the HTTPS origin, persistent data path, auth/invitation secrets, and source revision outside Git");
const staging = await createStaging({ baseURL, directory, secret, inviteCode, sourceRevision, port: Number(process.env.PORT ?? 10000) });
await staging.listen();
process.stderr.write(`Kairos invited development staging: ${baseURL}\nUse .test accounts and approved project notes. Customer account recovery is not ready.\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { staging.close().then(() => process.exit(0), () => process.exit(1)); });
