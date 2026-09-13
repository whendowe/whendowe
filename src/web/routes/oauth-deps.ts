// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Config, requireGoogleOAuth } from "../../config.js";
import { createTokenCipher } from "../../crypto/tokens.js";
import type { StoragePort } from "../../db/port.js";
import type { OAuthRouteDeps } from "./oauth.js";

// Assembles the OAuth route dependencies from config + a storage port. Lives here
// rather than in deploy/ because none of it is platform-specific: the two adapters
// differ only in which storage driver they hand in.

/**
 * Owner for rows created by the connect flow.
 *
 * The MVP is single-user (§17 leaves single-user vs multi-account open), but §10's
 * schema already carries owner_id, so the column is populated with a fixed
 * placeholder rather than left meaningless. When multi-account lands this becomes
 * the authenticated user's id and nothing else about the flow changes.
 */
export const SINGLE_USER_OWNER_ID = "self";

/**
 * The key id new ciphertexts are written under.
 *
 * The envelope format reserves a byte for this so rotation needs no migration
 * (§13). Until there is a second key, the ring is this one key; rotating means
 * loading both and moving this pointer.
 */
const CURRENT_TOKEN_KEY_ID = 1;

export async function buildOAuthDeps(
  config: Config,
  storage: StoragePort,
): Promise<OAuthRouteDeps> {
  // Throws, naming every missing key, if the instance is only half configured.
  const google = requireGoogleOAuth(config);

  const cipher = await createTokenCipher(
    [{ id: CURRENT_TOKEN_KEY_ID, material: google.TOKEN_ENCRYPTION_KEY }],
    CURRENT_TOKEN_KEY_ID,
  );

  return {
    storage,
    cipher,
    clientId: google.GOOGLE_CLIENT_ID,
    clientSecret: google.GOOGLE_CLIENT_SECRET,
    redirectUri: google.GOOGLE_REDIRECT_URI,
    ownerId: SINGLE_USER_OWNER_ID,
    now: () => new Date().toISOString(),
    newId: () => crypto.randomUUID(),
    // Derived from the redirect URI rather than hardcoded: a deployment on https
    // gets Secure cookies, and plain-http local development still works. Browsers
    // do accept Secure on http://localhost, so this is belt-and-braces for the
    // environments that disagree.
    secureCookies: new URL(google.GOOGLE_REDIRECT_URI).protocol === "https:",
  };
}
