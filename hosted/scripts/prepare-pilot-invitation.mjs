// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Steffan Douglas Haskins
// Run after hosted build: --email name@domain.tld --out /private/new-directory.
// This creates local files only. It does not provision accounts or send email.
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, dirname, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realAccountEmail } from '../dist/hosted/src/accountAccess.js';
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--email' || args[2] !== '--out' || !isAbsolute(args[3])) {
  throw new Error('Use --email invited-address --out /private/new-directory');
}
const email = realAccountEmail(args[1]);
if (!email) throw new Error('Use the intended recipient\'s real email address');
const directory = join(realpathSync(dirname(args[3])), basename(args[3]));
const repository = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
const within = relative(repository, directory);
if (!within || (within !== '..' && !within.startsWith('..' + sep) && !isAbsolute(within))) {
  throw new Error('Keep private invitation output outside the repository');
}
const code = randomBytes(32).toString('base64url');
const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
mkdirSync(directory, { mode: 0o700 }); // Refuse an existing output directory.
const manifest = [{ bindingHash: createHash('sha256').update(email + '\0' + code).digest('hex'), codeHash: createHash('sha256').update(code).digest('hex'), expiresAt }];
writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
writeFileSync(join(directory, 'invitation.txt'), [
  'PRIVATE DRAFT — do not send until all beta gates pass.',
  `Invited email: ${email}`, `Personal invitation code: ${code}`,
  `Expires: ${new Date(expiresAt).toISOString()}`, '',
  'Use this code only in the Kairos account form. Never share a password or the operator staging secret.',
  'The code authorizes one registration attempt; ask for help if creation is uncertain.',
].join('\n') + '\n', { mode: 0o600, flag: 'wx' });
process.stdout.write('Private manifest and invitation draft saved. Nothing sent or provisioned.\n');
