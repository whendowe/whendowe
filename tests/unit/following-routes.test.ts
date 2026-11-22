// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { AddressRefused, type PublicGet, type PublicResponse } from "../../src/following/fetch.js";
import { createGroup, findGroupForMember } from "../../src/people/group.js";
import { acceptInvite, createInvite } from "../../src/people/invite.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { FOLLOWING_PATH } from "../../src/web/routes/following.js";
import { addAccount, type Browser, browser, home, post } from "../property/one-browser.js";

// The following page (DESIGN §10 rc56): paste a link to follow it, for yourself or for a group
// you organize; rename, recolour, stop. Every action a POST form with its CSRF, the GET
// writing nothing; a group's follows shown to its members and changed only by its organizers.

const NOW = "2026-11-21T12:00:00.000Z";
const URL_ICS = "https://club.example/swing.ics";

const CAL = (name: string, ...events: string[][]) =>
  [
    "BEGIN:VCALENDAR",
    `X-WR-CALNAME:${name}`,
    "X-WR-TIMEZONE:Europe/Prague",
    ...events.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]),
    "END:VCALENDAR",
  ].join("\r\n");
const SOCIAL = [
  "UID:social",
  "DTSTART:20261126T180000Z",
  "DTEND:20261126T210000Z",
  "SUMMARY:Social",
];
const ODD = ["UID:odd", "DTSTART:20261127T180000Z", "RDATE:20261128T180000Z", "SUMMARY:Odd"];

function answer(status: number, text: string): PublicResponse {
  return {
    status,
    header: () => null,
    body: {
      getReader: () => {
        const chunks = [new TextEncoder().encode(text)];
        return {
          read: async () => {
            const value = chunks.shift();
            return value === undefined ? { done: true } : { done: false, value };
          },
          cancel: async () => {},
        };
      },
    },
  };
}

/** A calendar server answering `text` to every address, recording what it was asked for. */
function serving(text: string, status = 200) {
  const asked: string[] = [];
  const get: PublicGet = async (url) => {
    asked.push(url);
    return answer(status, text);
  };
  return { get, asked };
}

async function signedIn(b: Browser, email: string) {
  await addAccount(b, email);
  return (await home(b)).csrf;
}

const page = async (b: Browser) => (await b.request(FOLLOWING_PATH)).text();

/** Ann organizes "Dancers"; Bob is a member. Each signed in on a browser of their own. */
async function dancers(publicGet?: PublicGet) {
  const ann = await browser({ now: () => NOW, ...(publicGet === undefined ? {} : { publicGet }) });
  const annCsrf = await signedIn(ann, "ann@example.org");
  const bob = ann.another();
  const bobCsrf = await signedIn(bob, "bob@example.org");
  const a = await findOrCreatePerson(ann.storage, "ann@example.org", { now: NOW });
  const group = await createGroup(ann.storage, { name: "Dancers", creatorId: a.id, now: NOW });
  const membership = await findGroupForMember(ann.storage, group.id, a.id);
  if (membership === null) throw new Error("membership");
  const invite = await createInvite(ann.storage, membership, {
    email: "bob@example.org",
    invitedBy: a.id,
    editTier: "view",
    visibility: "FULL",
    now: NOW,
  });
  if (!invite.ok) throw new Error(invite.reason);
  if ((await acceptInvite(ann.storage, invite.token, NOW)) === null) throw new Error("accept");
  return { ann, annCsrf, bob, bobCsrf, groupId: group.id };
}

const followId = (res: Response) =>
  /#f-([0-9a-f-]+)$/.exec(res.headers.get("location") ?? "")?.[1] ?? "";

it("asks you to sign in, and its GET writes nothing", async () => {
  const b = await browser({ now: () => NOW });
  const out = await b.request(FOLLOWING_PATH);
  expect(out.status).toBe(303);
  expect(out.headers.get("location")).toBe(
    `/auth/sign-in?next=${encodeURIComponent(FOLLOWING_PATH)}`,
  );
  await signedIn(b, "ann@example.org");
  const before = b.writes;
  const res = await b.request(FOLLOWING_PATH);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  const text = await res.text();
  expect(text).toContain("<h1>Calendars you follow</h1>");
  expect(text).toContain("You don't follow any calendars yet.");
  // Nothing to follow for but yourself: no choice offered.
  expect(text).toContain('<input type="hidden" name="for" value="me" />');
  expect(b.writes).toBe(before);
  // Home links to it.
  expect((await home(b)).text).toContain(`<a href="${FOLLOWING_PATH}">Calendars you follow</a>`);
});

it("following a link fetches it at once and shows what it holds", async () => {
  const server = serving(CAL("Swing school", SOCIAL));
  const b = await browser({ now: () => NOW, publicGet: server.get });
  const csrf = await signedIn(b, "ann@example.org");
  const res = await b.request(
    FOLLOWING_PATH,
    post({ csrf, link: "webcal://club.example/swing.ics", for: "me" }),
  );
  expect(res.status).toBe(303);
  const id = followId(res);
  expect(id).not.toBe("");
  expect(server.asked).toEqual([URL_ICS]);
  const text = await page(b);
  expect(text).toContain(`<li id="f-${id}" class="fc-f1"><strong>Swing school</strong>`);
  expect(text).toContain("1 event in the next 60 days");
  expect(text).toContain(`<a href="${URL_ICS}" rel="noreferrer noopener" class="muted">`);
  // Following the same link again is the same follow, and isn't fetched again.
  const again = await b.request(FOLLOWING_PATH, post({ csrf, link: URL_ICS, for: "me" }));
  expect(followId(again)).toBe(id);
  expect(server.asked).toHaveLength(1);
});

it("a Google embed link is followed as its public iCal address", async () => {
  const server = serving(CAL("Swing school", SOCIAL));
  const b = await browser({ now: () => NOW, publicGet: server.get });
  const csrf = await signedIn(b, "ann@example.org");
  const embed =
    "https://calendar.google.com/calendar/embed?src=dance%40group.calendar.google.com&ctz=Europe%2FPrague";
  await b.request(FOLLOWING_PATH, post({ csrf, link: embed }));
  expect(server.asked).toEqual([
    "https://calendar.google.com/calendar/ical/dance%40group.calendar.google.com/public/basic.ics",
  ]);
});

it("without a fetcher a follow waits for the pass, and says it hasn't been read", async () => {
  const b = await browser({ now: () => NOW });
  const csrf = await signedIn(b, "ann@example.org");
  await b.request(FOLLOWING_PATH, post({ csrf, link: URL_ICS }));
  const text = await page(b);
  expect(text).toContain("<strong>club.example</strong>"); // no name yet: its host
  expect(text).toContain("Not read yet.");
});

it("says when a calendar couldn't be read, and how many events were left out", async () => {
  const bad = serving("not a calendar");
  const b = await browser({ now: () => NOW, publicGet: bad.get });
  const csrf = await signedIn(b, "ann@example.org");
  await b.request(FOLLOWING_PATH, post({ csrf, link: URL_ICS }));
  expect(await page(b)).toContain('<span class="error">Couldn\'t read this calendar.</span>');

  const odd = serving(CAL("Swing school", SOCIAL, ODD));
  const c = await browser({ now: () => NOW, publicGet: odd.get });
  const csrf2 = await signedIn(c, "ann@example.org");
  await c.request(FOLLOWING_PATH, post({ csrf: csrf2, link: URL_ICS }));
  expect(await page(c)).toContain(
    "1 event in the next 60 days · 1 event we couldn&#39;t read is left out",
  );
});

it("a link that can't be followed is refused on the page, kept in the field, escaped, unwritten", async () => {
  const b = await browser({ now: () => NOW, publicGet: serving("").get });
  const csrf = await signedIn(b, "ann@example.org");
  const before = b.writes;
  const cases: [string, string][] = [
    ['"><script>x</script>', "That isn&#39;t a link we can read."],
    ["http://club.example/a.ics", "Only https: and webcal: links can be followed."],
    ["https://me:pw@club.example/a.ics", "A link with a name or password in it"],
    ["https://club.example:8443/a.ics", "A link with a port number in it"],
  ];
  for (const [link, message] of cases) {
    const res = await b.request(FOLLOWING_PATH, post({ csrf, link }));
    expect(res.status, link).toBe(400);
    const text = await res.text();
    expect(text, link).toContain(message);
    expect(text, link).not.toContain("<script>x");
  }
  const kept = await (
    await b.request(FOLLOWING_PATH, post({ csrf, link: '"><script>x</script>' }))
  ).text();
  expect(kept).toContain('value="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
  expect(b.writes).toBe(before);
});

it("a form without its CSRF token changes nothing", async () => {
  const server = serving(CAL("Swing school", SOCIAL));
  const b = await browser({ now: () => NOW, publicGet: server.get });
  const csrf = await signedIn(b, "ann@example.org");
  const id = followId(await b.request(FOLLOWING_PATH, post({ csrf, link: URL_ICS })));
  const before = b.writes;
  for (const [path, fields] of [
    [FOLLOWING_PATH, { link: "https://club.example/other.ics" }],
    [`${FOLLOWING_PATH}/${id}/name`, { name: "Mine" }],
    [`${FOLLOWING_PATH}/${id}/colour`, { colour: "f3" }],
    [`${FOLLOWING_PATH}/${id}/stop`, {}],
  ] as const) {
    const res = await b.request(path, post({ ...fields, csrf: "nope" }));
    expect(res.status, path).not.toBe(303);
  }
  expect(b.writes).toBe(before);
  expect(server.asked).toHaveLength(1);
});

it("rename, recolour and stop your own; an empty name is the calendar's own again", async () => {
  const server = serving(CAL("Swing school", SOCIAL));
  const b = await browser({ now: () => NOW, publicGet: server.get });
  const csrf = await signedIn(b, "ann@example.org");
  const id = followId(await b.request(FOLLOWING_PATH, post({ csrf, link: URL_ICS })));
  const back = `${FOLLOWING_PATH}#f-${id}`;

  const renamed = await b.request(
    `${FOLLOWING_PATH}/${id}/name`,
    post({ csrf, for: "me", name: "  <b>Tuesdays</b>  " }),
  );
  expect(renamed.headers.get("location")).toBe(back);
  let text = await page(b);
  expect(text).toContain("<strong>&lt;b&gt;Tuesdays&lt;/b&gt;</strong>");
  expect(text).toContain(
    'value="&lt;b&gt;Tuesdays&lt;/b&gt;" placeholder="&lt;b&gt;Tuesdays&lt;/b&gt;"',
  );
  await b.request(`${FOLLOWING_PATH}/${id}/name`, post({ csrf, for: "me", name: "   " }));
  text = await page(b);
  expect(text).toContain("<strong>Swing school</strong>");
  expect(text).toContain('value="" placeholder="Swing school"');

  const recoloured = await b.request(
    `${FOLLOWING_PATH}/${id}/colour`,
    post({ csrf, for: "me", colour: "f4" }),
  );
  expect(recoloured.headers.get("location")).toBe(back);
  text = await page(b);
  expect(text).toContain(`<li id="f-${id}" class="fc-f4">`);
  expect(text).toContain('value="f4" checked');
  // Not one of the six: nothing changes.
  const odd = await b.request(
    `${FOLLOWING_PATH}/${id}/colour`,
    post({ csrf, for: "me", colour: "red" }),
  );
  expect(odd.status).toBe(404);
  expect(await page(b)).toContain(`class="fc-f4"`);

  const stopped = await b.request(`${FOLLOWING_PATH}/${id}/stop`, post({ csrf, for: "me" }));
  expect(stopped.status).toBe(303);
  expect(await page(b)).toContain("You don't follow any calendars yet.");
});

it("nobody changes another person's follow", async () => {
  const { ann, annCsrf, bob, bobCsrf } = await dancers(serving(CAL("Swing school", SOCIAL)).get);
  const id = followId(await ann.request(FOLLOWING_PATH, post({ csrf: annCsrf, link: URL_ICS })));
  for (const [what, fields] of [
    ["name", { name: "Bob's" }],
    ["colour", { colour: "f2" }],
    ["stop", {}],
  ] as const) {
    const res = await bob.request(
      `${FOLLOWING_PATH}/${id}/${what}`,
      post({ csrf: bobCsrf, for: "me", ...fields }),
    );
    expect(res.status, what).toBe(404);
  }
  expect(await page(bob)).not.toContain("Swing school");
  const annSees = await page(ann);
  expect(annSees).toContain("<strong>Swing school</strong>");
  expect(annSees).toContain(`class="fc-f1"`);
});

it("an organizer follows for the group; members see it and can't change it", async () => {
  const { ann, annCsrf, bob, bobCsrf, groupId } = await dancers(
    serving(CAL("Swing school", SOCIAL)).get,
  );
  // Ann may choose the group; Bob, who organizes nothing, isn't offered one.
  expect(await page(ann)).toContain(`<option value="${groupId}">Dancers: everyone in it</option>`);
  expect(await page(bob)).toContain('<input type="hidden" name="for" value="me" />');
  // Bob can't follow for it, even by sending the form himself.
  const refused = await bob.request(
    FOLLOWING_PATH,
    post({ csrf: bobCsrf, link: URL_ICS, for: groupId }),
  );
  expect(refused.status).toBe(403);

  const id = followId(
    await ann.request(FOLLOWING_PATH, post({ csrf: annCsrf, link: URL_ICS, for: groupId })),
  );
  const bobSees = await page(bob);
  expect(bobSees).toContain("<h2>Dancers</h2>");
  expect(bobSees).toContain(`<li id="f-${id}" class="fc-f1"><strong>Swing school</strong>`);
  expect(bobSees).toContain("The group's organizers follow this for it.");
  expect(bobSees).not.toContain(`action="${FOLLOWING_PATH}/${id}/stop"`);
  for (const what of ["name", "colour", "stop"]) {
    const res = await bob.request(
      `${FOLLOWING_PATH}/${id}/${what}`,
      post({ csrf: bobCsrf, for: groupId, name: "x", colour: "f2" }),
    );
    expect(res.status, what).toBe(404);
  }
  // The group's follow isn't Ann's own either: changed only as the group's.
  const asOwn = await ann.request(
    `${FOLLOWING_PATH}/${id}/name`,
    post({ csrf: annCsrf, for: "me", name: "Mine" }),
  );
  expect(asOwn.status).toBe(404);
  const annSees = await page(ann);
  expect(annSees).toContain("You don't follow any calendars yet.");
  expect(annSees).toContain(`<input type="hidden" name="for" value="${groupId}" />`);
  const stop = await ann.request(
    `${FOLLOWING_PATH}/${id}/stop`,
    post({ csrf: annCsrf, for: groupId }),
  );
  expect(stop.status).toBe(303);
  expect(await page(bob)).not.toContain("<h2>Dancers</h2>");
});

const CLASS = ["UID:class", "DTSTART:20261201T180000Z", "DTEND:20261201T193000Z", "SUMMARY:Class"];
const ODD2 = ["UID:odd2", "DTSTART:20261129T180000Z", "RDATE:20261130T180000Z", "SUMMARY:Odd"];

it("counts in the plural, says nothing of what's left out when nothing is, and names a refused address", async () => {
  const b = await browser({
    now: () => NOW,
    publicGet: serving(CAL("Swing school", SOCIAL, CLASS)).get,
  });
  const csrf = await signedIn(b, "ann@example.org");
  await b.request(FOLLOWING_PATH, post({ csrf, link: URL_ICS }));
  const text = await page(b);
  expect(text).toContain('<span class="muted">2 events in the next 60 days</span>');

  const odd = await browser({
    now: () => NOW,
    publicGet: serving(CAL("Swing school", SOCIAL, ODD, ODD2)).get,
  });
  const csrf2 = await signedIn(odd, "ann@example.org");
  await odd.request(FOLLOWING_PATH, post({ csrf: csrf2, link: URL_ICS }));
  expect(await page(odd)).toContain(
    "1 event in the next 60 days · 2 events we couldn&#39;t read are left out</span>",
  );

  const refusing: PublicGet = () => Promise.reject(new AddressRefused("private"));
  const r = await browser({ now: () => NOW, publicGet: refusing });
  const csrf3 = await signedIn(r, "ann@example.org");
  await r.request(FOLLOWING_PATH, post({ csrf: csrf3, link: URL_ICS }));
  expect(await page(r)).toContain(
    "<span class=\"error\">This address can't be followed: it isn't a public one.</span>",
  );
});

it("each follow's forms post to its own actions, as its follower, with its colour chosen", async () => {
  const { ann, annCsrf, groupId } = await dancers(serving(CAL("Swing school", SOCIAL)).get);
  const own = followId(await ann.request(FOLLOWING_PATH, post({ csrf: annCsrf, link: URL_ICS })));
  const theirs = followId(
    await ann.request(
      FOLLOWING_PATH,
      post({ csrf: annCsrf, link: "https://club.example/b.ics", for: groupId }),
    ),
  );
  await ann.request(
    `${FOLLOWING_PATH}/${own}/colour`,
    post({ csrf: annCsrf, for: "me", colour: "f5" }),
  );
  const text = await page(ann);
  const item = (id: string) => text.slice(text.indexOf(`id="f-${id}"`)).split("</li>")[0] ?? "";
  for (const [id, forWhom, colour] of [
    [own, "me", "f5"],
    [theirs, groupId, "f1"],
  ] as const) {
    const li = item(id);
    for (const what of ["name", "colour", "stop"]) {
      expect(li).toContain(`<form method="post" action="${FOLLOWING_PATH}/${id}/${what}">`);
    }
    expect(li.split(`<input type="hidden" name="for" value="${forWhom}" />`)).toHaveLength(4);
    expect(li.match(/ checked/g)).toHaveLength(1);
    expect(li).toContain(`value="${colour}" checked`);
    expect(li).toContain('<span class="muted">4</span></label>');
    // The others are plain radios, nothing added.
    const other = colour === "f1" ? "f2" : "f1";
    expect(li).toContain(
      `<input type="radio" name="colour" value="${other}" /><span class="fc-dot"`,
    );
  }
  // Nothing refused: no message, an empty field; the page has its title.
  expect(text).not.toContain('role="alert"');
  expect(text).toMatch(/name="csrf" value="[^"]+" \/>\s*<p><label>Calendar link/);
  expect(text).toContain('name="link" required maxlength="2000" value=""');
  expect(text).toContain("<title>Calendars you follow · WhenDoWe</title>");
});

it("signed out, every POST asks you to sign in and changes nothing", async () => {
  const b = await browser({ now: () => NOW });
  for (const path of [FOLLOWING_PATH, `${FOLLOWING_PATH}/x/name`, `${FOLLOWING_PATH}/x/stop`]) {
    const res = await b.request(path, post({ link: URL_ICS, name: "x" }));
    expect(res.status, path).toBe(303);
    expect(res.headers.get("location"), path).toBe("/auth/sign-in");
  }
  expect(b.writes).toBe(0);
});

it("a form with no link, or one too long, is refused with the field cut to fit", async () => {
  const b = await browser({ now: () => NOW });
  const csrf = await signedIn(b, "ann@example.org");
  const none = await b.request(FOLLOWING_PATH, post({ csrf }));
  expect(none.status).toBe(400);
  const text = await none.text();
  expect(text).toContain("That isn&#39;t a link we can read.");
  expect(text).toContain("<title>Calendars you follow · WhenDoWe</title>");
  expect(text).toContain('name="link" required maxlength="2000" value=""'); // none sent: none kept
  const long = `https://club.example/${"a".repeat(2100)}`;
  const cut = await (await b.request(FOLLOWING_PATH, post({ csrf, link: long }))).text();
  expect(cut).toContain(`value="${long.slice(0, 2000)}"`);
  expect(cut).not.toContain(long.slice(0, 2001));
});

it("says why a follow or a change was refused", async () => {
  const { ann, annCsrf, bob, bobCsrf, groupId } = await dancers();
  const refused = await bob.request(
    FOLLOWING_PATH,
    post({ csrf: bobCsrf, link: URL_ICS, for: groupId }),
  );
  expect(await refused.text()).toBe("Only a group's organizers follow calendars for it.");
  const id = followId(await ann.request(FOLLOWING_PATH, post({ csrf: annCsrf, link: URL_ICS })));
  const res = await bob.request(`${FOLLOWING_PATH}/${id}/stop`, post({ csrf: bobCsrf }));
  expect(await res.text()).toBe("That isn't a calendar you can change.");
});
