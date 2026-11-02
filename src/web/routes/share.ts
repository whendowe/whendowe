// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { StoragePort } from "../../db/port.js";
import type { Answer } from "../../events/poll.js";
import type { Plan } from "../../plans/plan.js";
import {
  claimName,
  joinByShareLink,
  questionAsOutsider,
  resolveClaim,
  resolveShareLink,
  SHARE_LINK_TTL_MS,
  type SharedQuestion,
} from "../../plans/share.js";
import {
  findThreadForMember,
  memberName,
  type ThreadAccess,
  ThreadInputError,
  type ThreadMember,
} from "../../plans/thread.js";
import { type Html, html } from "../layout.js";
import { type AppEnv, page, rejectedPage, type SignedIn, verifyFormCsrf } from "../session.js";
import {
  type Answers,
  applyAnswers,
  deadLink,
  linkPage,
  noteList,
  readAnswers,
  readToken,
  sensitive,
  votePlan,
} from "./respond.js";

// The shared link's page (DESIGN §10 rc25, rc29; slice L1): one link for a question, pasted
// into a group chat.
//
//   GET  /s?t=…          the page — renders, NEVER changes anything (a chat app fetches
//                        every pasted link to draw its card; §13)
//   POST /s              answer: signed in, join and vote; otherwise claim a name and vote,
//                        or vote again as the name this browser claimed
//   POST /s/forget       "Not you?": this browser forgets its claim on this question
//
// Who it is for (rc29): the people in the chat, answering in two taps — the name and the
// votes are one form. Signed in, the page acts as the active account and shows it in the
// header; a guest's page has no header, since no account is acting.
//
// This browser remembers its claims, one question each, in a cookie sent only to these
// pages (rc29). The server reads the claim for the question being opened and never records
// which claims share a browser. A name from one question is never offered in another.

export const SHARE_PATH = "/s";
export const CLAIM_COOKIE = "wdw_claims";
const MAX_CLAIMS = 8;

export interface ShareRouteDeps {
  readonly storage: StoragePort;
  readonly now: () => string;
  readonly secureCookies: boolean;
}

// --- The claim cookie: pure ---------------------------------------------------------------

export interface Claim {
  readonly threadId: string;
  readonly token: string;
}

const CLAIM_RE = /^([0-9a-f-]{1,64})\.([A-Za-z0-9_-]{1,256})$/;

/** The cookie's claims, newest first; anything malformed is dropped. */
export function parseClaims(raw: string | undefined): Claim[] {
  if (raw === undefined || raw === "") return [];
  return raw
    .split("~")
    .map((part) => CLAIM_RE.exec(part))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ threadId: m[1] ?? "", token: m[2] ?? "" }))
    .slice(0, MAX_CLAIMS);
}

/** This claim first, replacing any for the same question; the oldest go past MAX_CLAIMS. */
export function withClaim(claims: readonly Claim[], claim: Claim): Claim[] {
  return [claim, ...claims.filter((c) => c.threadId !== claim.threadId)].slice(0, MAX_CLAIMS);
}

export function withoutClaim(claims: readonly Claim[], threadId: string): Claim[] {
  return claims.filter((c) => c.threadId !== threadId);
}

function writeClaims(c: Context<AppEnv>, claims: readonly Claim[], secure: boolean): void {
  const options = { path: SHARE_PATH, secure, httpOnly: true, sameSite: "Lax" } as const;
  if (claims.length === 0) {
    deleteCookie(c, CLAIM_COOKIE, options);
    return;
  }
  setCookie(c, CLAIM_COOKIE, claims.map((x) => `${x.threadId}.${x.token}`).join("~"), {
    ...options,
    maxAge: Math.floor(SHARE_LINK_TTL_MS / 1000),
  });
}

// --- The page ------------------------------------------------------------------------------

/** Who is answering: the active account, the name this browser claimed, or someone new. */
type Answering =
  | { readonly kind: "account"; readonly me: SignedIn; readonly access: ThreadAccess | null }
  | { readonly kind: "claim"; readonly access: ThreadAccess }
  | { readonly kind: "guest" };

interface Shown {
  readonly onTable: readonly Plan[];
  readonly notes: Html | string;
  readonly members: readonly ThreadMember[];
}

/**
 * What the page shows, the same for everyone who opens the link — members included: the
 * plans on the table and the public notes, and never an address (rc25).
 */
async function shown(storage: StoragePort, q: SharedQuestion): Promise<Shown> {
  const seen = await questionAsOutsider(storage, q);
  const names = new Map(seen.members.map((m) => [m.personId, memberName(m)]));
  return {
    onTable: seen.onTable,
    notes: noteList(seen.notes, (id) => names.get(id) ?? "someone"),
    members: seen.members,
  };
}

function accessOf(who: Answering): ThreadAccess | null {
  return who.kind === "guest" ? null : who.access;
}

async function sharePage(
  c: Context<AppEnv>,
  deps: ShareRouteDeps,
  q: SharedQuestion,
  token: string,
  who: Answering,
  notice: Html | string,
  typed: { readonly name: string; readonly votes: ReadonlyMap<string, Answer> } = {
    name: "",
    votes: new Map(),
  },
): Promise<string> {
  const access = accessOf(who);
  const s = await shown(deps.storage, q);
  const voter = { members: s.members, personId: access?.personId ?? "" };
  const mine = access?.members.find((m) => m.personId === access.personId);
  const lead =
    who.kind === "account"
      ? access === null
        ? html`<p>You're signed in, so you'll answer as yourself and join this plan.</p>`
        : html`<p>Answering as <strong>${mine === undefined ? "you" : memberName(mine)}</strong>.</p>`
      : who.kind === "claim"
        ? html`<div class="row"><p>You're <strong>${mine === undefined ? "" : memberName(mine)}</strong>.</p><form method="post" action="${SHARE_PATH}/forget"><input type="hidden" name="t" value="${token}" /><button class="link" type="submit">Not you?</button></form></div>`
        : "";
  const body = !q.open
    ? html`<p><strong>This is decided.</strong> There's nothing to vote on any more.</p>`
    : html`${lead}<form method="post" action="${SHARE_PATH}">
  <input type="hidden" name="t" value="${token}" />
  ${who.kind === "account" ? html`<input type="hidden" name="csrf" value="${who.me.csrfToken}" />` : ""}
  ${
    who.kind === "guest"
      ? html`<p><label>Your name <span class="muted">(everyone in it sees this)</span><br />
  <input name="name" value="${typed.name}" maxlength="40" autocomplete="nickname" required /></label></p>`
      : ""
  }
  <h2>Which of these work for you?</h2>
  <ul style="list-style:none;padding-left:0">${s.onTable.map((p) => votePlan(voter, p, typed.votes))}</ul>
  <p><label>Anything to add? <span class="muted">(optional — everyone in it sees it)</span><br />
  <textarea name="note" rows="2" maxlength="500" style="width:100%"></textarea></label></p>
  <p><button class="primary" type="submit">Send my answer</button></p>
</form>`;
  const content = html`${notice}<h1>${q.thread.name}</h1>
${body}
${s.notes === "" ? "" : html`<h2>Notes</h2>${s.notes}`}
<p class="muted">Anyone with this link can answer${who.kind === "account" ? "" : ", no account needed"}.</p>`;
  // Signed in, the page acts as the account: its header says which (§13 rc18).
  return who.kind === "account"
    ? page(c, q.thread.name, content)
    : linkPage(q.thread.name, content);
}

/** Who answers on this browser: the active account first, then this question's claim. */
async function answering(
  c: Context<AppEnv>,
  deps: ShareRouteDeps,
  q: SharedQuestion,
): Promise<Answering> {
  const me = c.get("signedIn");
  if (me !== null)
    return {
      kind: "account",
      me,
      access: await findThreadForMember(deps.storage, q.thread.id, me.personId),
    };
  const claim = parseClaims(getCookie(c, CLAIM_COOKIE)).find((x) => x.threadId === q.thread.id);
  const access =
    claim === undefined ? null : await resolveClaim(deps.storage, claim.token, q.thread.id);
  return access === null ? { kind: "guest" } : { kind: "claim", access };
}

const saved = (token: string) => {
  const back = new URL(SHARE_PATH, "http://placeholder");
  back.searchParams.set("t", token);
  back.searchParams.set("saved", "1");
  return `${back.pathname}${back.search}`;
};

export function registerShareRoutes(app: Hono<AppEnv>, deps: ShareRouteDeps): void {
  app.get(SHARE_PATH, async (c) => {
    sensitive(c);
    const token = readToken(c.req.query("t"));
    const q = token === null ? null : await resolveShareLink(deps.storage, token, deps.now());
    if (token === null || q === null) return c.html(deadLink(), 404);
    const notice =
      c.req.query("saved") === "1"
        ? html`<p class="notice"><strong>Thanks — your answer is saved.</strong> Open this link again to change it.</p>`
        : "";
    return c.html(await sharePage(c, deps, q, token, await answering(c, deps, q), notice));
  });

  app.post(SHARE_PATH, async (c) => {
    sensitive(c);
    const form = await c.req.parseBody();
    const token = readToken(form.t);
    const now = deps.now();
    // Resolved again on the POST, and every join re-checks it in the statement that writes.
    const q = token === null ? null : await resolveShareLink(deps.storage, token, now);
    if (token === null || q === null) return c.html(deadLink(), 404);
    const who = await answering(c, deps, q);
    if (who.kind === "account" && !(await verifyFormCsrf(who.me, form)))
      return rejectedPage(c, form);
    const answers = readAnswers(form);
    const name = typeof form.name === "string" ? form.name : "";
    const again = async (message: string, status: 400 | 404 | 409 | 429) =>
      c.html(
        await sharePage(c, deps, q, token, who, html`<p class="error">${message}</p>`, {
          name,
          votes: answers?.votes ?? new Map(),
        }),
        status,
      );
    if (!q.open) return again("This was decided meanwhile.", 409);
    if (answers === null) return again("Pick an answer first.", 400);

    let access: ThreadAccess;
    if (who.kind === "claim") access = who.access;
    else if (who.kind === "account") {
      const joined = await joinByShareLink(deps.storage, q, who.me.personId, now);
      if (joined.kind === "gone") return again("This was decided meanwhile.", 409);
      if (joined.kind === "full") return again("This plan is full — ask whoever shared it.", 409);
      access = joined.access;
    } else {
      let claimed: Awaited<ReturnType<typeof claimName>>;
      try {
        claimed = await claimName(deps.storage, q, { name, now });
      } catch (err) {
        if (err instanceof ThreadInputError) return again(err.message, 400);
        throw err;
      }
      if (claimed.kind === "taken")
        return again("Someone in this plan already goes by that name — pick another.", 409);
      if (claimed.kind === "busy")
        return again("A lot of people joined today. Please try again tomorrow.", 429);
      if (claimed.kind === "full") return again("This plan is full — ask whoever shared it.", 409);
      if (claimed.kind === "gone") return again("This was decided meanwhile.", 409);
      access = claimed.access;
      const claims = parseClaims(getCookie(c, CLAIM_COOKIE));
      writeClaims(
        c,
        withClaim(claims, { threadId: q.thread.id, token: claimed.token }),
        deps.secureCookies,
      );
    }
    const refused = await applyAnswers(deps.storage, access, answers satisfies Answers, now);
    if (refused !== null) {
      // Joined or claimed even so: the page now answers as that person.
      const as: Answering = who.kind === "guest" ? { kind: "claim", access } : who;
      return c.html(
        await sharePage(
          c,
          deps,
          q,
          token,
          as.kind === "account" ? { ...as, access } : as,
          html`<p class="error">${refused.message}</p>`,
        ),
        refused.status,
      );
    }
    return c.redirect(saved(token), 303);
  });

  // "Not you?" (rc29): forgets this question's claim on this browser. Writes no storage.
  app.post(`${SHARE_PATH}/forget`, async (c) => {
    sensitive(c);
    const form = await c.req.parseBody();
    const token = readToken(form.t);
    const q = token === null ? null : await resolveShareLink(deps.storage, token, deps.now());
    const claims = parseClaims(getCookie(c, CLAIM_COOKIE));
    if (q !== null) writeClaims(c, withoutClaim(claims, q.thread.id), deps.secureCookies);
    if (token === null || q === null) return c.html(deadLink(), 404);
    const back = new URL(SHARE_PATH, "http://placeholder");
    back.searchParams.set("t", token);
    return c.redirect(`${back.pathname}${back.search}`, 303);
  });
}
