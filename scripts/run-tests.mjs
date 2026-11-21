import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const testDirectory = resolve(process.argv[2]);
const files = readdirSync(testDirectory, { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith(".test.js"))
  .map(entry => join(testDirectory, entry.name))
  .sort();

if (files.length === 0) throw new Error(`No compiled tests found in ${testDirectory}`);

const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
