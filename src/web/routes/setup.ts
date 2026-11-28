// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import { z } from "zod";
import { handleSchema, normalizeEmail } from "../../people/person.js";
import { claimInstance, hasOperator, setupLinkWorks } from "../../people/setup.js";
import { type Html, html } from "../layout.js";
import { type AppEnv, page, roomFor, signInAs } from "../session.js";
import { type AuthDeps, tooManyAccounts } from "./auth.js";

// The setup link's page (DESIGN §10 rc60 *Running without email*): the first owner of an
// instance with no operator. The link comes from `setup-link`, run in the container, which
// prints it to that terminal and never to the log.
//
//   GET  /setup?t=…   your name, your address, Make me the owner — renders, changes nothing
//   POST /setup       claims the instance (src/people/setup.ts claimInstance), signs you in
//
// Signed out there is no session to carry a CSRF token, as for sign-in's confirm page: the
// token in the form is what a forged POST can't have.

export const SETUP_PATH = "/setup";

/** The command the log names, for an instance in a container (deploy/node/cli.ts). */
export const SETUP_COMMAND = "docker compose exec whendowe setup-link";

const tokenSchema = z.string().min(1).max(256);

function sensitive(c: Context): void {
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
}

/**
 * "This instance has no owner yet", for the pages a signed-out visitor meets (home and
 * sign-in), or nothing. Once there is an operator the answer is kept: only erasing the last one
 * could change it, and then the page merely stays quiet until the next start.
 */
export function ownerNotice(deps: AuthDeps): () => Promise<Html | string> {
  let owned = false;
  return async () => {
    if (owned) return "";
    owned = await hasOperator(deps.storage, deps.capabilities);
    return owned
      ? ""
      : html`<p class="attn">This instance has no owner yet. Whoever runs it makes the first account with a setup link; the server's log says how.</p>`;
  };
}

/** The address the page was opened at, when it isn't the one links are made from. */
function elsewhere(c: Context, publicBaseUrl: string): Html | string {
  const here = new URL(c.req.url).origin;
  const links = new URL(publicBaseUrl).origin;
  return here === links
    ? ""
    : html`<p class="attn">You opened this at <strong>${here}</strong>, but the links this instance hands out start with <strong>${links}</strong>. If friends will use ${here}, set <code>PUBLIC_BASE_URL=${here}</code> in the compose file and restart, or the links you copy for them won't work.</p>`;
}

function claimForm(
  c: Context,
  deps: AuthDeps,
  token: string,
  values: { readonly name: string; readonly email: string },
  error: string | null,
): Html {
  return html`<h1>Make this instance yours</h1>
<p class="muted">You'll be its owner: its first account, and its operator. Others join when you invite them.</p>
${elsewhere(c, deps.publicBaseUrl)}
${error === null ? "" : html`<p class="error">${error}</p>`}
<form method="post" action="${SETUP_PATH}">
  <input type="hidden" name="t" value="${token}" />
  <p><label>Your name<br /><input name="name" maxlength="40" required autocomplete="name" value="${values.name}" /></label></p>
  <p><label>Your email address<br /><input name="email" type="email" required autocomplete="email" value="${values.email}" /></label></p>
  <p class="muted">The address is how people find you here. Nothing is sent to it unless this instance is given a way to send email.</p>
  <p><button type="submit">Make me the owner</button></p>
</form>`;
}

function usedPage(c: Context<AppEnv>): string {
  return page(
    c,
    "Setup link",
    html`<h1>This setup link has expired or was already used</h1>
<p>A setup link lasts 30 minutes and works once, and only while the instance has no owner. For a new one, run this where the instance runs:</p>
<pre><code>${SETUP_COMMAND}</code></pre>`,
  );
}

export function registerSetupRoutes(app: Hono<AppEnv>, deps: AuthDeps): void {
  app.get(SETUP_PATH, async (c) => {
    sensitive(c);
    const token = tokenSchema.safeParse(c.req.query("t"));
    const works =
      token.success &&
      (await setupLinkWorks(deps.storage, deps.capabilities, token.data, { now: deps.now() }));
    if (!token.success || !works) return c.html(usedPage(c), 400);
    return c.html(page(c, "Setup", claimForm(c, deps, token.data, { name: "", email: "" }, null)));
  });

  app.post(SETUP_PATH, async (c) => {
    sensitive(c);
    const form = await c.req.parseBody();
    const token = tokenSchema.safeParse(form.t);
    if (!token.success) return c.html(usedPage(c), 400);
    const values = {
      name: typeof form.name === "string" ? form.name.slice(0, 200) : "",
      email: typeof form.email === "string" ? form.email.slice(0, 200) : "",
    };
    const again = (error: string) =>
      c.html(page(c, "Setup", claimForm(c, deps, token.data, values, error)), 400);
    const name = handleSchema.safeParse(values.name);
    if (!name.success) return again(name.error.issues[0]?.message ?? "Choose a name.");
    let email: string;
    try {
      email = normalizeEmail(values.email);
    } catch {
      return again("That doesn't look like an email address.");
    }
    if (!roomFor(c, null)) return tooManyAccounts(c);
    const claimed = await claimInstance(deps.storage, deps.capabilities, {
      token: token.data,
      email,
      name: name.data,
      now: deps.now(),
    });
    if (!claimed.ok)
      return claimed.reason === "address_taken"
        ? again(
            "Someone on this instance already has that address. Use another, or, to make that account the owner, name it in OPERATOR_EMAILS.",
          )
        : c.html(usedPage(c), 400);
    if (!(await signInAs(c, deps, claimed.personId, "setup"))) return tooManyAccounts(c);
    return c.redirect("/", 303);
  });
}
