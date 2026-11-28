// SPDX-License-Identifier: AGPL-3.0-or-later
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { type Config, capabilityConfigOf, loadConfig } from "../../src/config.js";
import type { StoragePort } from "../../src/db/port.js";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import { normalizeEmail } from "../../src/people/person.js";
import { makeSetupLink, shellSignInLink } from "../../src/people/setup.js";
import { CONFIRM_PATH } from "../../src/web/routes/auth.js";
import { SETUP_PATH } from "../../src/web/routes/setup.js";

// `setup-link` and `sign-in-link <address>` (DESIGN §10 rc60 *Running without email*), run in
// the container: `docker compose exec whendowe setup-link`. Each prints its link to the
// terminal that ran it and nowhere else — never to the server's log (§13/§14). Being able to
// run a command in the container is the proof of running the instance.
//
// They write one row each (a setup or a login token) through the storage port, beside the
// server's process: SQLite serialises the two writers, and neither row is a connection's state,
// which only the server writes (§6).

export interface CliDeps {
  readonly storage: StoragePort;
  readonly config: Pick<Config, "PUBLIC_BASE_URL" | "OPERATOR_EMAILS" | "CAPABILITIES_DEFAULT">;
  readonly now: () => string;
  /** The terminal: what the person who ran the command reads. */
  readonly out: (text: string) => void;
}

const USAGE = `Usage:
  setup-link              a link that makes you this instance's owner, while it has none
  sign-in-link <address>  a sign-in link for an account that exists here
`;

function link(base: string, path: string, token: string): string {
  const url = new URL(path, base);
  url.searchParams.set("t", token);
  return url.toString();
}

/** Run one command; the exit code. */
export async function runCli(args: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = args;
  const capabilities = capabilityConfigOf(deps.config);
  if (command === "setup-link" && rest.length === 0) {
    const made = await makeSetupLink(deps.storage, capabilities, { now: deps.now() });
    if (!made.ok) {
      deps.out(
        "This instance already has an owner, so there is no setup link.\nFor a sign-in link for an account here, run: sign-in-link <address>\n",
      );
      return 1;
    }
    deps.out(
      `Your setup link, for the next 30 minutes and once:\n\n  ${link(deps.config.PUBLIC_BASE_URL, SETUP_PATH, made.token)}\n\nOpen it to make yourself this instance's owner. Running setup-link again makes a new one and this one stops working.\n`,
    );
    return 0;
  }
  if (command === "sign-in-link" && rest.length === 1 && rest[0] !== undefined) {
    let email: string;
    try {
      email = normalizeEmail(rest[0]);
    } catch {
      deps.out("That doesn't look like an email address.\n");
      return 2;
    }
    const made = await shellSignInLink(deps.storage, email, { now: deps.now() });
    if (!made.ok) {
      deps.out(
        `No account here has the address ${email}. New people join by an invite from someone already here.\n`,
      );
      return 1;
    }
    deps.out(
      `A sign-in link for ${email}, for the next 15 minutes and once:\n\n  ${link(deps.config.PUBLIC_BASE_URL, CONFIRM_PATH, made.token)}\n\nAnyone with this link can sign in as ${email} until it is used.\n`,
    );
    return 0;
  }
  deps.out(USAGE);
  return 2;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig(process.env);
  const client = createClient({ url: config.DATABASE_URL });
  const code = await runCli(process.argv.slice(2), {
    storage: sqliteStoragePort(client),
    config,
    now: () => new Date().toISOString(),
    out: (text) => process.stdout.write(text),
  });
  client.close();
  process.exitCode = code;
}
