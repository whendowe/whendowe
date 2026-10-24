// SPDX-License-Identifier: AGPL-3.0-or-later
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { test } from "vitest";
import { MAX_ACCOUNTS } from "../../src/people/accounts.js";
import { findPersonByEmail } from "../../src/people/person.js";
import { resolveAccounts, revokeAllSessions, SESSION_TTL_MS } from "../../src/people/session.js";
import { SIGN_OUT_ALL_PATH, SIGN_OUT_PATH, SWITCH_PATH } from "../../src/web/routes/auth.js";
import { GROUPS_PATH } from "../../src/web/routes/groups.js";
import { addAccount, type Browser, browser, home, post, tokensIn } from "./one-browser.js";

// Accounts on a browser (DESIGN §9 rc18, §13): a draw-loop over one browser and the
// whole app. Each step is something a person (or the world) does; a small model says
// which accounts the browser should then hold, active first. After every step:
//   - the page shows exactly the model's accounts, in order — at most four, one per
//     person, the active one first;
//   - a session that was signed out, revoked elsewhere or expired never comes back;
//   - a form verifies only for the account it was rendered for;
//   - switching and page views write nothing to storage.

const PEOPLE = ["ann", "bob", "cat", "dan", "eve", "fay"].map((n) => `${n}@example.org`);
// Every case builds a fresh database and runs requests through the whole app, so the
// budgets are smaller than the pure properties' (budget.ts): 50 × 12 in the gate.
const SOAK = process.env.SOAK !== undefined;
const CASES = SOAK ? 500 : 50;
const STEPS = SOAK ? 40 : 12;
const MINUTE = 60_000;

type Action =
  | { type: "signIn"; who: string }
  | { type: "switch"; to: number }
  | { type: "signOut" }
  | { type: "signOutAll" }
  | { type: "revokedElsewhere"; who: number }
  | { type: "monthPasses" }
  | { type: "staleTab"; to: number };

function drawAction(tc: hegel.TestCase, held: number): Action {
  const pick = (max: number) => tc.draw(gs.integers({ minValue: 0, maxValue: max }));
  const kinds: (() => Action)[] = [
    () => ({ type: "signIn", who: PEOPLE[pick(PEOPLE.length - 1)] ?? "ann@example.org" }),
    () => ({ type: "signIn", who: PEOPLE[pick(PEOPLE.length - 1)] ?? "ann@example.org" }),
    () => ({ type: "monthPasses" }),
  ];
  if (held > 0) {
    kinds.push(
      () => ({ type: "signOut" }),
      () => ({ type: "signOutAll" }),
      () => ({ type: "revokedElsewhere", who: pick(held - 1) }),
    );
  }
  if (held > 1) {
    kinds.push(
      () => ({ type: "switch", to: pick(held - 2) }),
      () => ({ type: "switch", to: pick(held - 2) }),
      () => ({ type: "staleTab", to: pick(held - 2) }),
    );
  }
  return (kinds[pick(kinds.length - 1)] ?? (() => ({ type: "monthPasses" })))();
}

/** One look at home; checks the page against the model and that looking wrote nothing. */
async function look(
  b: Browser,
  model: readonly string[],
  dead: Set<string>,
  log: string[],
  now: string,
) {
  const fail: (what: string) => never = (what) => {
    throw new Error(`${what}\n  after: ${log.join(" → ")}`);
  };
  const before = b.writes;
  const seen = await home(b);
  if (b.writes !== before) fail(`a page view wrote ${b.writes - before} statements`);
  const shown = seen.active === null ? [] : [seen.active, ...seen.others.map((o) => o.email)];
  if (JSON.stringify(shown) !== JSON.stringify(model)) {
    fail(`page shows ${JSON.stringify(shown)}, expected ${JSON.stringify(model)}`);
  }
  const tokens = tokensIn(b.cookie);
  if (tokens.length !== model.length)
    fail(`cookie holds ${tokens.length}, expected ${model.length}`);
  if (tokens.length > MAX_ACCOUNTS) fail(`cookie holds ${tokens.length} accounts`);
  const back = tokens.find((t) => dead.has(t));
  if (back !== undefined) fail("a signed-out session came back");
  // ...and is over on the server too, not just gone from this cookie: presented by
  // anyone, it resolves to no one.
  const gone = [...dead].filter((t) => t !== "");
  for (let i = 0; i < gone.length; i += MAX_ACCOUNTS) {
    const alive = await resolveAccounts(b.storage, gone.slice(i, i + MAX_ACCOUNTS), { now });
    if (alive.length > 0)
      fail(`a signed-out session still works on the server (${alive[0]?.email})`);
  }
  return { ...seen, tokens };
}

test("a browser's accounts are always the ones it signed in to and still holds", () =>
  hegel.testAsync(
    async (tc) => {
      let clock = Date.parse("2026-10-24T08:00:00Z");
      const b = await browser({ now: () => new Date(clock).toISOString() });
      let model: string[] = [];
      const dead = new Set<string>();
      const log: string[] = [];
      const fail: (what: string) => never = (what) => {
        throw new Error(`${what}\n  after: ${log.join(" → ")}`);
      };
      const steps = tc.draw(gs.integers({ minValue: 1, maxValue: STEPS }));
      for (let i = 0; i < steps; i++) {
        const a = drawAction(tc, model.length);
        log.push(JSON.stringify(a));
        const now = await look(b, model, dead, log, new Date(clock).toISOString());
        // Sign-in links are rate-limited per address per hour; let time pass between.
        clock += 13 * MINUTE;
        switch (a.type) {
          case "signIn": {
            const res = await addAccount(b, a.who);
            const room = model.length < MAX_ACCOUNTS || model.includes(a.who);
            if (res.status !== (room ? 303 : 409)) fail(`sign-in answered ${res.status}`);
            if (room) {
              const again = model.indexOf(a.who);
              if (again >= 0) dead.add(now.tokens[again] ?? "");
              model = [a.who, ...model.filter((e) => e !== a.who)];
            }
            break;
          }
          case "switch": {
            const target = now.others[a.to];
            if (target === undefined) fail("no such account to switch to");
            const before = b.writes;
            await b.request(
              SWITCH_PATH,
              post({ csrf: now.csrf, session: target.sessionId, back: "/" }),
            );
            if (b.writes !== before) fail(`switching wrote ${b.writes - before} statements`);
            model = [target.email, ...model.filter((e) => e !== target.email)];
            break;
          }
          case "signOut":
            await b.request(SIGN_OUT_PATH, post({ csrf: now.csrf }));
            dead.add(now.tokens[0] ?? "");
            model = model.slice(1);
            break;
          case "signOutAll":
            await b.request(SIGN_OUT_ALL_PATH, post({ csrf: now.csrf }));
            for (const t of now.tokens) dead.add(t);
            model = [];
            break;
          case "revokedElsewhere": {
            // "Sign out everywhere" from another device: that person's sessions all end.
            const email = model[a.who] ?? "";
            const person = await findPersonByEmail(b.storage, email);
            if (person === null) fail(`no person for ${email}`);
            await revokeAllSessions(b.storage, person.id, new Date(clock).toISOString());
            dead.add(now.tokens[a.who] ?? "");
            model = model.filter((e) => e !== email);
            break;
          }
          case "monthPasses":
            clock += SESSION_TTL_MS;
            for (const t of now.tokens) dead.add(t);
            model = [];
            break;
          case "staleTab": {
            // A tab rendered as the active account; the person switches in another tab,
            // then submits the old tab's form. It must be refused, and change nothing.
            const target = now.others[a.to];
            if (target === undefined) fail("no such account to switch to");
            await b.request(
              SWITCH_PATH,
              post({ csrf: now.csrf, session: target.sessionId, back: "/" }),
            );
            model = [target.email, ...model.filter((e) => e !== target.email)];
            const before = b.writes;
            const res = await b.request(GROUPS_PATH, post({ csrf: now.csrf, name: "Stale" }));
            if (res.status !== 403) fail(`a stale tab's form answered ${res.status}`);
            if (b.writes !== before) fail("a stale tab's form wrote to storage");
            break;
          }
        }
      }
      await look(b, model, dead, log, new Date(clock).toISOString());
    },
    { testCases: CASES },
  ));
