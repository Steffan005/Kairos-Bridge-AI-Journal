// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026  Steffan Douglas Haskins
// Kairos Journal, created by Steffan Douglas Haskins. See ../../NOTICE.
import { createHash } from "node:crypto";
import { realAccountEmail, type AccountDelivery } from "./accountAccess.js";

/** Email is explicitly configured; local previews never send by default. */
export function accountDeliveryFromEnvironment(baseURL: string, env: NodeJS.ProcessEnv = process.env): AccountDelivery | undefined {
  const provider = env.KAIROS_EMAIL_PROVIDER;
  const apiKey = env.KAIROS_EMAIL_API_KEY;
  const from = env.KAIROS_EMAIL_FROM;
  if (!provider && !apiKey && !from) return undefined;
  if (provider !== "resend" || !apiKey || !from) {
    throw new Error("Configure KAIROS_EMAIL_PROVIDER=resend, KAIROS_EMAIL_API_KEY and KAIROS_EMAIL_FROM together outside Git");
  }
  return createResendAccountDelivery({ baseURL, apiKey, from });
}

export function createResendAccountDelivery(options: {
  baseURL: string; apiKey: string; from: string; fetcher?: typeof fetch;
}): AccountDelivery {
  const base = new URL(options.baseURL);
  if (base.protocol !== "https:" || base.origin !== options.baseURL || base.username || base.password) {
    throw new Error("Account email requires the canonical HTTPS Kairos origin");
  }
  const from = realAccountEmail(options.from);
  if (!from || from !== options.from.trim().toLowerCase()) throw new Error("Set KAIROS_EMAIL_FROM to one verified sender email address");
  if (options.apiKey.length < 16 || /\s/.test(options.apiKey)) throw new Error("Set a valid private account-email API key");
  const sendFetch = options.fetcher ?? fetch;
  return {
    async send(message) {
      const to = realAccountEmail(message.to);
      const link = new URL(message.url);
      const path = message.kind === "email-change" ? "/confirm-email" : "/reset-password";
      if (!to || link.origin !== base.origin || link.pathname !== path || link.search || link.username || link.password ||
          !/^#token=[A-Za-z0-9_-]{43}$/.test(link.hash)) {
        throw new Error("Account email could not be prepared");
      }
      const emailChange = message.kind === "email-change";
      const subject = emailChange ? "Confirm your Kairos sign-in email" : "Reset your Kairos password";
      const action = emailChange
        ? "You requested this email address for your existing Kairos account. Open the link below, sign in to the account that requested the change, and choose Confirm email."
        : "You requested a new password for your Kairos account. Open the link below and choose a new password.";
      const text = ["Kairos-Bridge — The bridge to remembrance", "", action, "", message.url, "",
        "This link expires in 30 minutes and can be used once. Opening it does not change your account until you submit the form.",
        emailChange ? "Your journal and approved AI connections stay with the same account." : "Resetting signs out your Kairos app and browser sessions. Your journal and approved AI connections stay with the same account.",
        "", "If you did not request this, ignore this email. Keep the link private."].join("\n");
      // Retransmission of the same message must not create duplicate provider sends.
      const idempotency = createHash("sha256").update(JSON.stringify([message.kind, to, message.url])).digest("hex");
      try {
        const response = await sendFetch("https://api.resend.com/emails", {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(8_000),
          headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json", "idempotency-key": `kairos-account-${idempotency}` },
          body: JSON.stringify({ from: `Kairos-Bridge <${from}>`, to: [to], subject, text }),
        });
        // Never relay delivery-provider bodies, recipients, links or credentials into logs/errors.
        await response.body?.cancel();
        if (!response.ok) throw new Error("delivery rejected");
      } catch { throw new Error("Account email delivery is temporarily unavailable"); }
    },
  };
}
