// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { requestRecoveryCapture } from "./recoveryControl.js";

try {
  const args = process.argv.slice(2);
  const socketPath = args[0] ?? process.env.KAIROS_RECOVERY_SOCKET;
  if (args.length > 1 || !socketPath) throw new Error("Usage: recovery-client ABS_PRIVATE_UNIX_SOCKET (or set KAIROS_RECOVERY_SOCKET). Run through your host operator SSH session.");
  console.log(JSON.stringify(await requestRecoveryCapture({ socketPath })));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Recovery request failed");
  process.exitCode = 1;
}
