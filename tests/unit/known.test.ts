// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { stmt } from "../../src/db/port.js";
import { knownAddresses, listKnownPeople } from "../../src/people/known.js";
import { findOrCreatePerson } from "../../src/people/person.js";
import { ASK_PATH } from "../../src/web/routes/ask.js";
import { EVENTS_PATH } from "../../src/web/routes/events.js";
import { addAccount, browser, home, nameActive, post } from "../property/one-browser.js";

// Who you already know (DESIGN §10 *Asking when*, rc48): the places counted, the people never
// suggested, how each is shown, and the order.

it("counts events and threads, newest place first; never a hidden participant, a guest or a former member", async () => {
  let clock = "2101-12-01T09:00:00.000Z";
  const b = await browser({ now: () => clock });
  const id = async (email: string) =>
    (await findOrCreatePerson(b.storage, email, { now: clock })).id;
  await addAccount(b, "lea@example.org");
  await nameActive(b, "lea@example.org");
  await addAccount(b, "mara@example.org");
  await nameActive(b, "mara@example.org");
  const [mara, lea] = [await id("mara@example.org"), await id("lea@example.org")];
  const csrf = async () => (await home(b)).csrf;

  const made = await b.request(
    EVENTS_PATH,
    post({
      csrf: await csrf(),
      title: "Board games",
      location: "",
      description: "",
      start: "2101-12-20T19:00",
      end: "2101-12-20T22:00",
      tzid: "Europe/Prague",
      email: "lea@example.org hid@example.org gus@example.org gone@example.org",
    }),
  );
  const event = made.headers.get("location")?.split("/").at(-1) ?? "";
  const [hid, gus, gone] = [
    await id("hid@example.org"),
    await id("gus@example.org"),
    await id("gone@example.org"),
  ];
  await b.storage.batch([
    stmt(
      "UPDATE event_participation SET visibility = 'HIDDEN' WHERE canonical_event_id = ? AND person_id = ?",
      event,
      hid,
    ),
    stmt("UPDATE person SET guest_at = ? WHERE id = ?", clock, gus),
    stmt("UPDATE person SET email = ? WHERE id = ?", `${gone}@erased.invalid`, gone),
  ]);
  expect((await listKnownPeople(b.storage, mara)).map((k) => k.personId)).toEqual([lea]);

  // Later, a question to Lea becomes a thread: now the newest place, and the one she's shown by.
  clock = "2101-12-02T09:00:00.000Z";
  const path =
    (await b.request(ASK_PATH, post({ csrf: await csrf() }))).headers.get("location") ?? "";
  const asked = await b.request(
    path,
    post({
      csrf: await csrf(),
      title: "Pizza",
      tzid: "Europe/Prague",
      o0e0day: "2101-12-17",
      o0e0from: "19:00",
      o0e0to: "21:00",
      new_from: "19:00",
      new_hours: "2",
      email: "lea@example.org",
      act: "ask",
    }),
  );
  const thread = asked.headers.get("location")?.split("/").at(-1) ?? "";
  await b.storage.batch([
    stmt(
      "UPDATE plan_thread_member SET handle = 'Lea P' WHERE thread_id = ? AND person_id = ?",
      thread,
      lea,
    ),
  ]);
  expect(await listKnownPeople(b.storage, mara)).toEqual([
    {
      personId: lea,
      shown: { name: "Lea P", email: null },
      places: [
        { kind: "thread", id: thread, name: "Pizza" },
        { kind: "event", id: event, name: "Board games" },
      ],
    },
  ]);
  // In a verified thread everyone sees each member's address (rc42), so the picker may too.
  await b.storage.batch([
    stmt("UPDATE plan_thread SET verified_at = ? WHERE id = ?", clock, thread),
  ]);
  expect((await listKnownPeople(b.storage, mara))[0]?.shown).toEqual({
    name: "Lea P",
    email: "lea@example.org",
  });

  // Addresses only for the ids asked about, and only of people known.
  expect(await knownAddresses(b.storage, mara, [])).toEqual(new Map());
  expect(await knownAddresses(b.storage, mara, [lea, hid, gus, "nobody"])).toEqual(
    new Map([[lea, "lea@example.org"]]),
  );
  // Lea knows Mara the same way back.
  expect((await listKnownPeople(b.storage, lea)).map((k) => k.personId)).toEqual([mara]);
});
