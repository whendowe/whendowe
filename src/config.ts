// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

// Config comes from env, parsed and validated here (DESIGN.md §13).
// Platform adapters in deploy/ pass their env source in; domain code never
// reads process.env or Workers bindings directly.

/** Byte length of a base64 payload, or null if it isn't valid base64. */
function base64ByteLength(value: string): number | null {
  try {
    return atob(value).length;
  } catch {
    return null;
  }
}

// Bare z.url() is too loose for a redirect URI: `new URL()` happily parses
// "localhost:8080/cb" with protocol "localhost:", so a missing scheme would be
// accepted at boot and only surface as a rejected redirect_uri from Google.
const httpUrlSchema = z.string().refine(
  (value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "must be an http(s) URL" },
);

// Google OAuth (§12) + the AES-256-GCM key wrapping the token columns (§13).
// Declared once, then spread into configSchema as optional: the M0 hello-page
// targets and the test suites boot without Google credentials, and an instance
// with no calendar connected yet is a legitimate state. The key is length-checked
// at boot rather than at first encrypt — a truncated secret should fail the
// deploy, not the first user's connect flow.
const googleOAuthFields = {
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: httpUrlSchema,
  TOKEN_ENCRYPTION_KEY: z.string().refine((value) => base64ByteLength(value) === 32, {
    message: "must be base64-encoded 32 bytes (AES-256-GCM key)",
  }),
};

const googleOAuthSchema = z.object(googleOAuthFields);

export const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  DATABASE_URL: z.string().min(1).default("file:data/whendowe.db"),
  // Resolved against the working directory by the Node migration runner; the
  // compiled dist/ layout and the tsx dev layout sit at different depths, so a
  // file-relative path would break one of them.
  MIGRATIONS_DIR: z.string().min(1).default("migrations"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  // Outbound mail (DESIGN §13 rc9). `disabled` fails closed — see src/mail/port.ts.
  // `console` prints messages including tokens: development only, explicit opt-in.
  MAIL_PROVIDER: z.enum(["disabled", "console", "cloudflare"]).default("disabled"),
  MAIL_FROM_ADDRESS: z.email().optional(),
  MAIL_FROM_NAME: z.string().min(1).default("WhenDoWe"),
  // Defaults sit under the 3,000 sends/month Workers Paid includes, so the default
  // configuration cannot incur overage. Raising them is a deliberate config change.
  MAIL_DAILY_CAP: z.coerce.number().int().min(0).default(200),
  MAIL_MONTHLY_CAP: z.coerce.number().int().min(0).default(2500),
  // REST path only (Node self-host). The hosted Workers instance uses a binding and
  // has no mail credential at all.
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1).optional(),
  CLOUDFLARE_EMAIL_API_TOKEN: z.string().min(1).optional(),

  GOOGLE_CLIENT_ID: googleOAuthFields.GOOGLE_CLIENT_ID.optional(),
  GOOGLE_CLIENT_SECRET: googleOAuthFields.GOOGLE_CLIENT_SECRET.optional(),
  GOOGLE_REDIRECT_URI: googleOAuthFields.GOOGLE_REDIRECT_URI.optional(),
  TOKEN_ENCRYPTION_KEY: googleOAuthFields.TOKEN_ENCRYPTION_KEY.optional(),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined>): Config {
  return configSchema.parse(env);
}

/** The Google OAuth credentials, proven present. */
export type GoogleOAuthConfig = z.infer<typeof googleOAuthSchema>;

/**
 * Whether this instance has *any* Google OAuth setting.
 *
 * Lets an adapter distinguish "not configured, run without the connect flow" from
 * "half configured, fail loudly": pair it with requireGoogleOAuth(), which throws
 * on the partial case. A deployment missing one of four secrets is a mistake, not
 * a mode.
 */
export function anyGoogleOAuthConfigured(config: Config): boolean {
  return (
    config.GOOGLE_CLIENT_ID !== undefined ||
    config.GOOGLE_CLIENT_SECRET !== undefined ||
    config.GOOGLE_REDIRECT_URI !== undefined ||
    config.TOKEN_ENCRYPTION_KEY !== undefined
  );
}

/**
 * Narrow a Config to the credentials the OAuth flow needs, or throw naming every
 * offending key at once. The message carries key names only — never the values
 * and never zod's received-value echo (§13/§14: secrets stay out of logs).
 */
export function requireGoogleOAuth(config: Config): GoogleOAuthConfig {
  const parsed = googleOAuthSchema.safeParse(config);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Google OAuth is not configured; missing or invalid: ${keys}`);
  }
  return parsed.data;
}
