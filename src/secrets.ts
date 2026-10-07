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
/**
 * Best-effort safety net: refuse to store text that clearly contains a
 * credential. This is NOT a guarantee; the tool descriptions also tell the AI
 * never to write secrets. Patterns are deliberately narrow to avoid blocking
 * normal notes.
 */
const PATTERNS: Array<[string, RegExp]> = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["OpenAI-style API key", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/],
  ["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe secret key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/],
  ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["password assignment", /\b(?:password|passwd|pwd|passcode)\s*[:=]\s*\S{4,}/i],
  ["seed / recovery phrase", /\b(?:seed|recovery|mnemonic)\s+phrase\s*[:=]/i],
  ["US Social Security number", /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/],
];

const CARD_CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;

/** Luhn checksum, used so random digit runs are not mistaken for card numbers. */
function luhnOk(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function looksLikeCard(text: string): boolean {
  for (const m of text.matchAll(CARD_CANDIDATE)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length >= 15 && digits.length <= 16 && /^(?:4|5[1-5]|2[2-7]|3[47]|6(?:011|5))/.test(digits) && luhnOk(digits)) {
      return true;
    }
  }
  return false;
}

/** Returns the name of the first secret-looking pattern found, or null. */
export function findSecret(text: string): string | null {
  for (const [name, re] of PATTERNS) {
    if (re.test(text)) return name;
  }
  if (looksLikeCard(text)) return "payment card number";
  return null;
}
