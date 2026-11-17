// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { acceptInvite } from "../../src/people/invite.js";
import { listKnownPeople } from "../../src/people/known.js";
import { findOrCreatePerson, findPersonByEmail } from "../../src/people/person.js";
import { findAskDraft } from "../../src/plans/ask.js";
import { ASK_PATH } from "../../src/web/routes/ask.js";
import { EVENTS_PATH } from "../../src/web/routes/events.js";
import { GROUPS_PATH } from "../../src/web/routes/groups.js";
import {
  addAccount,
  type Browser,
  browser,
  home,
  nameActive,
  post,
} from "../property/one-browser.js";

// The people picker on its pages (DESIGN §10 *Asking when*, rc48): suggestions from people you
// already know, by how they're shown and never by address; a chosen person is an id, checked
// again when the form is sent; a question or event keeps its one group, and another group adds
// its people; "Ask when" on a group's page.

const NOW = "2101-12-01T09:00:00.000Z";

const NIGHT = {
  title: "Board games",
  location: "",
  description: "",
  start: "2101-12-20T19:00",
  end: "2101-12-20T22:00",
  tzid: "Europe/Prague",
};

const csrf = async (b: Browser) => (await home(b)).csrf;

// One browser holds every account here, and its header names them all by address (rc18), so
// what the picker shows is looked for in the picker alone.
const picker = (page: string) => /<fieldset class="people">.*?<\/fieldset>/s.exec(page)?.[0] ?? "";

async function signedIn(b: Browser, email: string) {
  await addAccount(b, email);
  await nameActive(b, email);
  return (await findOrCreatePerson(b.storage, email, { now: NOW })).id;
}

/** A group of Mara's, with these people in it (each invited and joined). */
async function group(b: Browser, name: string, emails: readonly string[]) {
  const g =
    (await b.request(GROUPS_PATH, post({ csrf: await csrf(b), name }))).headers.get("location") ??
    "";
  for (const email of emails) {
    const before = b.sent.length;
    await b.request(
      `${g}/invites`,
      post({ csrf: await csrf(b), email, editTier: "view", visibility: "FULL" }),
    );
    const t = /\/invite\?t=([A-Za-z0-9_-]+)/.exec(b.sent.at(before)?.text ?? "")?.[1] ?? "";
    await acceptInvite(b.storage, t, NOW);
  }
  return { path: g, id: g.split("/").at(-1) ?? "" };
}

/** Lea and Cat sign in; Mara has Lea in "Table" and Cat in "Band"; Mara is active. */
async function world() {
  const b = await browser({ now: () => NOW });
  const lea = await signedIn(b, "lea@example.org");
  const cat = await signedIn(b, "cat@example.org");
  const mara = await signedIn(b, "mara@example.org");
  const table = await group(b, "Table", ["lea@example.org"]);
  const band = await group(b, "Band", ["cat@example.org"]);
  return { b, lea, cat, mara, table, band };
}

it("suggests the people you share a group with, by handle and place, never by address", async () => {
  const { b, lea, cat } = await world();
  const form = await (await b.request(`${EVENTS_PATH}/new`)).text();
  expect(form).toContain(
    `value="pick:${lea}">+ lea</button> <span class="muted small">· Table</span>`,
  );
  expect(form).toContain(
    `value="pick:${cat}">+ cat</button> <span class="muted small">· Band</span>`,
  );
  expect(picker(form)).not.toContain("lea@example.org");
  expect(picker(form)).not.toContain("cat@example.org");
  // Lea knows Mara, not Cat: they share nothing.
  await addAccount(b, "lea@example.org");
  const hers = await (await b.request(`${EVENTS_PATH}/new`)).text();
  expect(hers).toContain(">+ mara</button>");
  expect(hers).not.toContain(">+ cat</button>");
});

it("an event you see only as busy doesn't make its people known; one you see in full does", async () => {
  const b = await browser({ now: () => NOW });
  const zed = await signedIn(b, "zed@example.org");
  const mara = await signedIn(b, "mara@example.org");
  const made = await b.request(
    EVENTS_PATH,
    post({ csrf: await csrf(b), ...NIGHT, pc_0: "e:zed@example.org", pv_0: "BUSY" }),
  );
  expect(made.status).toBe(303);
  expect((await listKnownPeople(b.storage, zed)).map((k) => k.personId)).toEqual([]);
  // Mara sees the event in full, so she knows Zed from it.
  expect(await listKnownPeople(b.storage, mara)).toEqual([
    {
      personId: zed,
      shown: { name: "zed", email: null },
      places: [
        { kind: "event", id: made.headers.get("location")?.split("/").at(-1), name: "Board games" },
      ],
    },
  ]);
  await b.request(
    EVENTS_PATH,
    post({
      csrf: await csrf(b),
      ...NIGHT,
      title: "Pizza",
      pc_0: "e:zed@example.org",
      pv_0: "FULL",
    }),
  );
  const known = await listKnownPeople(b.storage, zed);
  expect(known.map((k) => [k.personId, k.shown.name, k.places.map((p) => p.name)])).toEqual([
    [mara, "mara", ["Pizza"]],
  ]);
});

it("a picker button draws the form again with its chips and creates nothing; creating uses each chip's terms", async () => {
  const { b, lea } = await world();
  const picked = await b.request(
    EVENTS_PATH,
    post({ csrf: await csrf(b), ...NIGHT, email: "new@example.org", pp: `pick:${lea}` }),
  );
  expect(picked.status).toBe(200);
  const page = await picked.text();
  expect(page).toContain('name="pc_0" value="e:new@example.org"');
  expect(page).toContain(`name="pc_1" value="p:${lea}"`);
  expect(page).toContain('value="Board games"');
  expect(await findPersonByEmail(b.storage, "new@example.org")).toBeNull();

  const made = await b.request(
    EVENTS_PATH,
    post({ csrf: await csrf(b), ...NIGHT, pc_0: `p:${lea}`, pt_0: "edit", pv_0: "DETAILS" }),
  );
  expect(made.status).toBe(303);
  const event = await (await b.request(made.headers.get("location") ?? "")).text();
  expect(event).toMatch(/lea <span class="muted">· can edit/);
});

it("an id that isn't someone you know is refused when the form is sent, and nothing is made", async () => {
  const { b } = await world();
  const stranger = await findOrCreatePerson(b.storage, "stranger@example.org", { now: NOW });
  const refused = await b.request(
    EVENTS_PATH,
    post({ csrf: await csrf(b), ...NIGHT, pc_0: `p:${stranger.id}` }),
  );
  expect(refused.status).toBe(400);
  const page = await refused.text();
  expect(page).toContain("no longer someone you share a group, event or thread with");
  expect(page).not.toContain("stranger@example.org");
  // A lever off the list is refused too, never read as a default.
  const odd = await b.request(
    EVENTS_PATH,
    post({ csrf: await csrf(b), ...NIGHT, pc_0: "e:ok@example.org", pv_0: "EVERYTHING" }),
  );
  expect(odd.status).toBe(400);
  expect(await findPersonByEmail(b.storage, "ok@example.org")).toBeNull();
});

it("Ask from a group's page: its group as a chip; another group adds its people, saying from where", async () => {
  const { b, cat, table, band } = await world();
  const groupPage = await (await b.request(table.path)).text();
  expect(groupPage).toContain(
    `<form method="post" action="${ASK_PATH}" class="row wrap"><input type="hidden" name="csrf" value="`,
  );
  expect(groupPage).toContain(
    `<input type="hidden" name="group" value="${table.id}" /><button class="primary" type="submit">Ask Table when</button>`,
  );
  const started = await b.request(ASK_PATH, post({ csrf: await csrf(b), group: table.id }));
  const path = started.headers.get("location") ?? "";
  const page = await (await b.request(path)).text();
  expect(page).toContain(
    '<summary>Table <span class="muted">· 1 person</span></summary><p class="small">lea</p>',
  );
  expect(page).not.toContain(">+ lea</button>"); // asked through the group already

  const filtered = await b.request(
    path,
    post({ csrf: await csrf(b), title: "Pizza", pp: `filter:${band.id}` }),
  );
  expect(filtered.headers.get("location")).toBe(`${path}?saved=1&f=${band.id}`);
  const narrowed = await (await b.request(`${path}?f=${band.id}`)).text();
  expect(narrowed).toContain(`value="group:${band.id}">+ Everyone from Band (1)</button>`);
  await b.request(path, post({ csrf: await csrf(b), title: "Pizza", pp: `group:${band.id}` }));
  const draft = await findAskDraft(b.storage, {
    id: path.split("/").at(-1) ?? "",
    authorId: (await findOrCreatePerson(b.storage, "mara@example.org", { now: NOW })).id,
  });
  expect(draft?.body.people).toEqual([{ id: cat, from: band.id }]);
  const after = await (await b.request(path)).text();
  expect(after).toContain('<summary>cat <span class="muted">· from Band</span></summary>');
  expect(picker(after)).not.toContain("cat@example.org");
  expect(after).toContain(">Ask 2 people by email</button>");
});

it("asking emails a chosen person, and refuses one no longer known", async () => {
  const { b, lea, cat } = await world();
  const h = await home(b);
  const path = (await b.request(ASK_PATH, post({ csrf: h.csrf }))).headers.get("location") ?? "";
  const fields = {
    title: "Pizza",
    tzid: "Europe/Prague",
    o0e0day: "2101-12-17",
    o0e0from: "19:00",
    o0e0to: "21:00",
    new_from: "19:00",
    new_hours: "2",
  };
  const stranger = await findOrCreatePerson(b.storage, "stranger@example.org", { now: NOW });
  const refused = await b.request(
    path,
    post({ csrf: await csrf(b), ...fields, pc_0: `p:${stranger.id}`, act: "ask" }),
  );
  expect(refused.status).toBe(400);
  expect(await refused.text()).toContain(
    "no longer someone you share a group, event or thread with",
  );
  const asked = await b.request(
    path,
    post({ csrf: await csrf(b), ...fields, pc_0: `p:${lea}`, pc_1: `p:${cat}`, act: "ask" }),
  );
  expect(asked.status).toBe(303);
  expect(asked.headers.get("location")).toMatch(/^\/plans\//);
});

it("an event's Add people: a chosen person is added, named by handle, never by address", async () => {
  const { b, lea } = await world();
  const made = await b.request(EVENTS_PATH, post({ csrf: await csrf(b), ...NIGHT }));
  const event = made.headers.get("location") ?? "";
  const page = await (await b.request(event)).text();
  expect(page).toContain(`value="pick:${lea}">+ lea</button>`);
  const picked = await b.request(
    `${event}/people`,
    post({ csrf: await csrf(b), pp: `pick:${lea}` }),
  );
  expect(picked.status).toBe(200);
  expect(await picked.text()).toContain(`name="pc_0" value="p:${lea}"`);
  const added = await b.request(
    `${event}/people`,
    post({ csrf: await csrf(b), pc_0: `p:${lea}`, pv_0: "DETAILS" }),
  );
  expect([200, 303]).toContain(added.status);
  if (added.status === 200)
    expect(
      /<p class="(?:notice|error)">.*?<\/p>/s.exec(await added.text())?.[0] ?? "",
    ).not.toContain("lea@example.org");
  const after = await (await b.request(event)).text();
  expect(after).toMatch(/<li>lea/);
  expect(after).not.toContain(`value="pick:${lea}"`); // taking part now
  // Two pasted at once are both added.
  const two = await b.request(
    `${event}/people`,
    post({ csrf: await csrf(b), email: "one@example.org, two@example.org" }),
  );
  expect([200, 303]).toContain(two.status);
  expect(await findPersonByEmail(b.storage, "one@example.org")).not.toBeNull();
  expect(await findPersonByEmail(b.storage, "two@example.org")).not.toBeNull();
});

it("a group's invites: several pasted at once, a chosen person named by handle, marked ones refused", async () => {
  const { b, cat, table } = await world();
  const marked = await b.request(
    `${table.path}/invites`,
    post({ csrf: await csrf(b), email: "a@example.org nope" }),
  );
  expect(marked.status).toBe(400);
  const text = await marked.text();
  expect(text).toContain('name="pc_1" value="e:nope"');
  expect(text).toContain('<span class="why">· not an email address</span>');
  const before = b.sent.length;
  const sent = await b.request(
    `${table.path}/invites`,
    post({ csrf: await csrf(b), email: "a@example.org", pc_0: `p:${cat}` }),
  );
  expect(sent.status).toBe(200);
  const notice = await sent.text();
  expect(notice).toContain("Invite sent to <strong>cat</strong>.");
  expect(notice).toContain("Invite sent to <strong>a@example.org</strong>.");
  expect(/<h2>Invite people<\/h2>(.*?)<form/s.exec(notice)?.[1] ?? "").not.toContain(
    "cat@example.org",
  );
  expect(
    b.sent
      .slice(before)
      .map((m) => m.to)
      .sort(),
  ).toEqual(["a@example.org", "cat@example.org"]);
  // A picker button invites nobody.
  const n = b.sent.length;
  expect(
    (
      await b.request(
        `${table.path}/invites`,
        post({ csrf: await csrf(b), email: "z@example.org", pp: "add" }),
      )
    ).status,
  ).toBe(200);
  expect(b.sent.length).toBe(n);
});
