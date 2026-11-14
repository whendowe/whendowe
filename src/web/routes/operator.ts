// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import {
  CAPABILITIES,
  type Capability,
  type CapabilityConfig,
  capabilitySchema,
  EVERYTHING,
  grantCapability,
  isOperator,
  listCapabilityChanges,
  listGrants,
  revokeCapability,
} from "../../people/capability.js";
import { normalizeEmail } from "../../people/person.js";
import { type Html, html } from "../layout.js";
import {
  type AppEnv,
  page,
  rejectedPage,
  requireSignedIn,
  type SignedIn,
  verifyFormCsrf,
} from "../session.js";
import type { AuthDeps } from "./auth.js";

// The operator page (DESIGN §10 rc43): who holds which capability, granted and revoked by
// address. Only the instance's operators see it; for everyone else, and on an instance with
// none, it doesn't exist (404). It shows addresses and capabilities, never anything else.

export const OPERATOR_PATH = "/operator";

const LABEL: Record<Capability, string> = {
  verify: "Turn verifying on",
  calendar_sync: "Connect Google Calendar",
  long_history: "History older than 90 days",
};

function operatorPage(
  c: Context<AppEnv>,
  me: SignedIn,
  config: CapabilityConfig,
  grants: Awaited<ReturnType<typeof listGrants>>,
  changes: Awaited<ReturnType<typeof listCapabilityChanges>>,
  notice: Html | string,
): string {
  const csrf = html`<input type="hidden" name="csrf" value="${me.csrfToken}" />`;
  return page(
    c,
    "Operator",
    html`<h1>Operator page</h1>
<p class="muted">Only this instance's operators see this page. It shows who may use which capability, and nothing else. ${
      config.default === "all"
        ? "This instance gives every account every capability, so grants here change nothing until it is set to give them only to granted accounts."
        : "This instance gives capabilities only to the accounts granted here."
    }</p>
${notice}
<h2>Grant</h2>
<form method="post" action="${OPERATOR_PATH}/grant">${csrf}
  <p><label>Email address<br /><input name="email" type="email" required /></label></p>
  <p><label>Capability<br /><select name="capability">${CAPABILITIES.map((cap) => html`<option value="${cap}">${LABEL[cap]}</option>`)}</select></label></p>
  <p><button type="submit">Grant</button></p>
</form>
<h2>Granted</h2>
${
  grants.length === 0
    ? html`<p class="muted">Nobody yet.</p>`
    : html`<ul>${grants.map(
        (g) =>
          html`<li>${g.email}: ${g.capabilities.map(
            (cap) =>
              html`${LABEL[cap]} <form method="post" action="${OPERATOR_PATH}/revoke" style="display:inline">${csrf}<input type="hidden" name="person" value="${g.personId}" /><input type="hidden" name="capability" value="${cap}" /><button type="submit">Revoke</button></form> `,
          )}</li>`,
      )}</ul>`
}
<h2>Log</h2>
${
  changes.length === 0
    ? html`<p class="muted">Nothing yet.</p>`
    : html`<ul>${changes.map(
        (x) =>
          html`<li><span class="muted">${x.at.slice(0, 16).replace("T", " ")}</span> · ${x.actorEmail ?? "a former operator"} ${x.action} ${LABEL[x.capability]} ${x.action === "granted" ? "to" : "from"} ${x.email ?? "a deleted account"}</li>`,
      )}</ul>`
}`,
  );
}

export function registerOperatorRoutes(app: Hono<AppEnv>, deps: AuthDeps): void {
  const config = deps.capabilities ?? EVERYTHING;
  /** The signed-in operator, or a response: sign in, or 404 for anyone else. */
  const operator = async (c: Context<AppEnv>): Promise<SignedIn | Response> => {
    const me = requireSignedIn(c);
    if (me instanceof Response) return me;
    return isOperator(config, me.email) ? me : await c.notFound();
  };
  const render = async (
    c: Context<AppEnv>,
    me: SignedIn,
    notice: Html | string,
    status: 200 | 400 = 200,
  ) =>
    c.html(
      operatorPage(
        c,
        me,
        config,
        await listGrants(deps.storage),
        await listCapabilityChanges(deps.storage),
        notice,
      ),
      status,
    );

  app.get(OPERATOR_PATH, async (c) => {
    const me = await operator(c);
    if (me instanceof Response) return me;
    c.header("Cache-Control", "no-store");
    return render(c, me, "");
  });

  app.post(`${OPERATOR_PATH}/grant`, async (c) => {
    const me = await operator(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const capability = capabilitySchema.safeParse(form.capability);
    let email: string;
    try {
      email = normalizeEmail(typeof form.email === "string" ? form.email : "");
    } catch {
      return render(c, me, html`<p class="error">That isn't an email address.</p>`, 400);
    }
    if (!capability.success)
      return render(c, me, html`<p class="error">Choose a capability.</p>`, 400);
    await grantCapability(deps.storage, {
      email,
      capability: capability.data,
      actorId: me.personId,
      now: deps.now(),
    });
    return c.redirect(OPERATOR_PATH, 303);
  });

  app.post(`${OPERATOR_PATH}/revoke`, async (c) => {
    const me = await operator(c);
    if (me instanceof Response) return me;
    const form = await c.req.parseBody();
    if (!(await verifyFormCsrf(me, form))) return rejectedPage(c, form);
    const capability = capabilitySchema.safeParse(form.capability);
    if (!capability.success || typeof form.person !== "string")
      return render(c, me, html`<p class="error">Choose what to revoke.</p>`, 400);
    await revokeCapability(deps.storage, {
      personId: form.person,
      capability: capability.data,
      actorId: me.personId,
      now: deps.now(),
    });
    return c.redirect(OPERATOR_PATH, 303);
  });
}
