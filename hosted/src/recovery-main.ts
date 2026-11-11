// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { captureBackup, captureDeletionWitness, restoreBackup } from "./recovery.js";

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "backup" && args.length === 3) {
    const result = await captureBackup(args[0], args[1], args[2]);
    console.log(JSON.stringify({ backup_id: result.id, accounts: result.users.length, journals: result.journals.length, files: result.files.length }));
  } else if (command === "witness" && args.length === 2) {
    const result = captureDeletionWitness(args[0], args[1]);
    console.log(JSON.stringify({ witness_id: result.witness.id, sha256: result.sha256 }));
  } else if (command === "restore" && args.length === 4) {
    console.log(JSON.stringify(restoreBackup({ backup: args[0], output: args[1], witness: args[2], expectedWitnessSha256: args[3] })));
  } else {
    throw new Error("Usage: recovery backup ABS_DATA ABS_NEW_BUNDLE SOURCE_SHA | witness ABS_STOPPED_DATA ABS_NEW_WITNESS | restore ABS_BUNDLE ABS_NEW_DATA ABS_WITNESS TRUSTED_WITNESS_SHA256. Stop the service first. Keep credentials and backup bytes private.");
  }
} catch (error) { console.error(error instanceof Error ? error.message : "Recovery failed"); process.exitCode = 1; }
