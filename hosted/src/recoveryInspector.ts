// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { parentPort, workerData } from "node:worker_threads";
import { inspectRecoveryDirectory } from "./recovery.js";

// This worker only reads databases and computes hashes. It cannot copy source
// databases, publish a backup, release the service lease, or reopen admission.
if (!parentPort || typeof workerData?.directory !== "string" || typeof workerData?.includeFiles !== "boolean") throw new Error("Invalid recovery inspection job");
parentPort.postMessage(inspectRecoveryDirectory(workerData.directory, workerData.includeFiles));
