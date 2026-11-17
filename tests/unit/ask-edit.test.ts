// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { findOrCreatePerson } from "../../src/people/person.js";
import { findAskDraft } from "../../src/plans/ask.js";
import { ASK_PATH } from "../../src/web/routes/ask.js";
import { addAccount, type Browser, browser, home, post } from "../property/one-browser.js";

// The week-row editor behind an option's Edit (DESIGN §10 *Asking when*, rc49, A5b): the
// option's week rows with one of its events chosen, by identity; the plan editor's script
// writes that event's own fields and sends the form. Kept, like "See A", until Done.

const NOW = "2101-12-01T09:00:00.000Z";

async function start(b: Browser) {
  await addAccount(b, "mara@example.org");
  const res = await b.request(ASK_PATH, post({ csrf: (await home(b)).csrf }));
  const path = res.headers.get("location") ?? "";
  const mara = (await findOrCreatePerson(b.storage, "mara@example.org", { now: NOW })).id;
  const send = async (fields: Record<string, string>) =>
    b.request(path, post({ csrf: (await home(b)).csrf, ...fields }));
  const body = async () =>
    (await findAskDraft(b.storage, { id: path.split("/").at(-1) ?? "", authorId: mara }))?.body;
  const page = async (query = "") => (await b.request(`${path}${query}`)).text();
  return { path, send, body, page };
}

/** Dinner Friday and the weekend away, as option A. */
const WEEKEND = {
  title: "Weekend",
  location: "",
  tzid: "Europe/Prague",
  o0e0name: "Dinner",
  o0e0day: "2101-12-16",
  o0e0from: "19:00",
  o0e0to: "21:00",
  o0e1name: "Away",
  o0e1day: "2101-12-17",
  o0e1from: "",
  o0e1last: "2101-12-18",
  email: "lea@example.org",
  new_from: "19:00",
  new_hours: "2",
};

async function weekend(b: Browser) {
  const f = await start(b);
  await f.send({ ...WEEKEND, act: "and:0" });
  await f.send({ ...WEEKEND, act: "save" });
  const sids = (await f.body())?.options[0]?.map((e) => e.sid ?? "") ?? [];
  return { ...f, sids };
}

const where = (res: Response) => res.headers.get("location") ?? "";

it("Edit opens the option's week rows with its first event chosen; another is chosen by tapping it", async () => {
  const b = await browser({ now: () => NOW });
  const f = await weekend(b);
  const [dinner, away] = f.sids;
  const plain = await f.page();
  expect(plain).toContain(
    '<button type="submit" name="act" value="edit:0">Edit on the weeks</button>',
  );
  expect(plain).not.toContain("data-plan-editor");
  expect(plain).not.toContain("WhenDoWePlanEditor");
  const opened = await f.send({ ...WEEKEND, act: "edit:0" });
  expect(where(opened)).toBe(`${f.path}?saved=1&x=0&e=${dinner}#o0`);
  const page = await f.page(`?x=0&e=${dinner}`);
  expect(page).toContain(
    `<div data-plan-editor data-sel="${dinner}" data-grab="" data-form="ask" data-kind="time" data-from="o0e0day" data-to="o0e0last" data-day="o0e0day">`,
  );
  expect(page).toContain("Tap a day to move it there; its times are below.");
  expect(page).toContain('<div class="weeks editing">');
  expect(page).toContain('<form method="post" action="' + f.path + '" id="ask">');
  expect(page).toContain(
    `<input type="hidden" name="x" value="0" /><input type="hidden" name="e" value="${dinner}" />`,
  );
  expect(page).toContain('<button type="submit" name="act" value="edit:">Done</button>');
  expect(page).not.toContain('value="edit:0">Edit on the weeks</button>');
  expect(page).toContain("WhenDoWePlanEditor");
  // Each of its events is a button that chooses it, saving what was typed first.
  expect(page).toMatch(
    new RegExp(`<button type="submit" name="act" value="edit:0:${away}" class="rib plan[^"]*"`),
  );
  expect(page).toMatch(
    new RegExp(
      `<button type="submit" name="act" value="edit:0:${dinner}" class="rib plan[^"]* sel`,
    ),
  );
  const chose = await f.send({ ...WEEKEND, o0e0name: "Supper", act: `edit:0:${away}` });
  expect(where(chose)).toBe(`${f.path}?saved=1&x=0&e=${away}#o0`);
  expect((await f.body())?.options[0]?.[0]?.title).toBe("Supper");
  const days = await f.page(`?x=0&e=${away}`);
  expect(days).toContain(
    `data-sel="${away}" data-grab="" data-form="ask" data-kind="days" data-from="o0e1day" data-to="o0e1last" data-day="o0e1day"`,
  );
  expect(days).toContain(
    "Tap its first or last day to pick it up, then tap where it goes. Or drag an end.",
  );
  expect(days).toContain('<span class="grip s" data-grip="start"');
  expect(days).toContain('<span class="grip e" data-grip="end"');
});

it("what the script sends is saved, and the editor stays until Done", async () => {
  const b = await browser({ now: () => NOW });
  const f = await weekend(b);
  const [, away] = f.sids;
  // The script writes the event's own fields and sends the form with no button.
  const moved = await f.send({
    ...WEEKEND,
    o0e1day: "2101-12-24",
    o0e1last: "2101-12-26",
    x: "0",
    e: away ?? "",
  });
  expect(where(moved)).toBe(`${f.path}?saved=1&x=0&e=${away}#o0`);
  expect((await f.body())?.options[0]?.[1]).toMatchObject({
    sid: away,
    startLocal: "2101-12-24",
    endLocal: "2101-12-27",
  });
  // A one-day stretch: its last day is left empty, as the page writes it.
  const one = await f.send({
    ...WEEKEND,
    o0e1day: "2101-12-24",
    o0e1last: "2101-12-24",
    x: "0",
    e: away ?? "",
  });
  expect(where(one)).toContain("x=0");
  expect(await f.page(`?x=0&e=${away}`)).toContain('name="o0e1last" value=""');
  // Other buttons keep it: a day tapped on the calendar, a month moved.
  expect(where(await f.send({ ...WEEKEND, x: "0", e: away ?? "", act: "month:2102-01" }))).toBe(
    `${f.path}?saved=1&m=2102-01&x=0&e=${away}#o0`,
  );
  const done = await f.send({ ...WEEKEND, x: "0", e: away ?? "", act: "edit:" });
  expect(where(done)).toBe(`${f.path}?saved=1`);
});

it("an option made like A is edited with its changes from A; See A and Edit end each other", async () => {
  const b = await browser({ now: () => NOW });
  const f = await weekend(b);
  const [dinner, away] = f.sids;
  await f.send({ ...WEEKEND, act: "like" });
  const B = {
    o1e0name: "Dinner",
    o1e0day: "2101-12-16",
    o1e0from: "19:00",
    o1e0to: "21:00",
    o1e1name: "Away",
    o1e1day: "2101-12-24",
    o1e1from: "",
    o1e1last: "2101-12-25",
  };
  const opened = await f.send({ ...WEEKEND, ...B, s: "1", act: `edit:1:${away}` });
  expect(where(opened)).toBe(`${f.path}?saved=1&x=1&e=${away}#o1`);
  const page = await f.page(`?x=1&e=${away}`);
  expect(page).toContain(
    `<div class="like edit"><div class="row wrap"><details><summary>1 change from A</summary>`,
  );
  expect(page).not.toContain('value="see:1">See A</button>');
  expect(page).toMatch(/class="rib ghost[^"]*" style="[^"]*--x:var\(--o1\)/);
  // A ghost is not one of B's events: it stays a link, to B's card.
  expect(page).toMatch(/<a class="rib ghost[^"]*"[^>]* href="#o1"/);
  expect(page).toContain(
    `data-sel="${away}" data-grab="" data-form="ask" data-kind="days" data-from="o1e1day"`,
  );
  // See A closes the editor; Edit closes See A.
  const see = await f.send({ ...WEEKEND, ...B, x: "1", e: away ?? "", act: "see:1" });
  expect(where(see)).toBe(`${f.path}?saved=1&s=1`);
  const edit = await f.send({ ...WEEKEND, ...B, s: "1", act: "edit:1" });
  expect(where(edit)).toBe(`${f.path}?saved=1&x=1&e=${dinner}#o1`);
  // A itself is edited on its own week rows, compared with nothing.
  const a = await f.page(`?x=0&e=${dinner}`);
  expect(a).toContain('<div class="like edit">\n<p class="small muted" data-hint>');
});

it("the editor follows its option as options go, and closes when its event or option is gone", async () => {
  const b = await browser({ now: () => NOW });
  const f = await weekend(b);
  const [dinner, away] = f.sids;
  await f.send({ ...WEEKEND, act: "option" });
  await f.send({ ...WEEKEND, o1e0day: "2101-12-20", o1e0from: "", act: "option" });
  const opt = { o1e0day: "2101-12-20", o1e0from: "", o2e0day: "2101-12-21", o2e0from: "" };
  const c = (await f.body())?.options[2]?.[0]?.sid ?? "";
  // B removed while C is edited: C is B now, and still edited.
  const shifted = await f.send({ ...WEEKEND, ...opt, x: "2", e: c, act: "remove:1" });
  expect(where(shifted)).toBe(`${f.path}?saved=1&x=1&e=${c}#o1`);
  // A later option removed: nothing moves.
  const kept = await f.send({
    ...WEEKEND,
    o1e0day: "2101-12-21",
    o1e0from: "",
    x: "0",
    e: away ?? "",
    act: "remove:1",
  });
  expect(where(kept)).toBe(`${f.path}?saved=1&x=0&e=${away}#o0`);
  // Its chosen event removed from the list: the editor stays, on the option's first event.
  const dropped = await f.send({ ...WEEKEND, x: "0", e: away ?? "", act: "drop:0:1" });
  expect(where(dropped)).toBe(`${f.path}?saved=1&x=0&e=${dinner}#o0`);
  // Another event of it removed: the chosen one stays chosen.
  await f.send({ ...WEEKEND, act: "and:0" });
  const third = (await f.body())?.options[0]?.[1]?.sid ?? "";
  const other = await f.send({ ...WEEKEND, o0e1day: "", x: "0", e: dinner ?? "", act: "drop:0:1" });
  expect(where(other)).toBe(`${f.path}?saved=1&x=0&e=${dinner}#o0`);
  expect(third).not.toBe("");
  // The edited option removed: the editor closes, rather than edit another.
  await f.send({ ...WEEKEND, act: "option" });
  const gone = await f.send({
    ...WEEKEND,
    o1e0day: "2101-12-20",
    o1e0from: "",
    x: "1",
    e: "",
    act: "remove:1",
  });
  expect(where(gone)).toBe(`${f.path}?saved=1`);
  // An event no longer in the option, or an option that isn't there: no editor.
  expect(await f.page(`?x=0&e=${third}`)).not.toContain("data-plan-editor");
  expect(await f.page(`?x=7&e=${dinner}`)).not.toContain("data-plan-editor");
  expect(await f.page("?x=zero")).not.toContain("data-plan-editor");
});

it("an option whose events have no time yet opens with nothing chosen, and says why", async () => {
  const b = await browser({ now: () => NOW });
  const f = await start(b);
  await f.send({ ...WEEKEND, o0e0day: "", act: "edit:0" });
  const sid = (await f.body())?.options[0]?.[0]?.sid ?? "";
  const page = await f.page(`?x=0&e=${sid}`);
  expect(page).toContain('<div data-plan-editor data-sel="" data-grab=""');
  expect(page).toContain(
    "Its events show here once they have a day and a time. Tap one to move it.",
  );
  expect(page).toContain('<div class="weeks">');
  // Given a day, it is chosen: the one the editor was carrying.
  const timed = await f.send({ ...WEEKEND, o0e0day: "2101-12-16", x: "0", e: sid });
  expect(where(timed)).toBe(`${f.path}?saved=1&x=0&e=${sid}#o0`);
  expect(await f.page(`?x=0&e=${sid}`)).toContain(`data-sel="${sid}"`);
});

it("a refused ask keeps the editor where it was", async () => {
  const b = await browser({ now: () => NOW });
  const f = await weekend(b);
  const [dinner] = f.sids;
  await f.send({ ...WEEKEND, act: "like" });
  const res = await f.send({
    ...WEEKEND,
    o1e0name: "Dinner",
    o1e0day: "2101-12-16",
    o1e0from: "19:00",
    o1e0to: "21:00",
    o1e1name: "Away",
    o1e1day: "2101-12-17",
    o1e1from: "",
    o1e1last: "2101-12-18",
    x: "0",
    e: dinner ?? "",
    act: "ask",
  });
  expect(res.status).toBe(400);
  const page = await res.text();
  expect(page).toContain("Two of the options are the same");
  expect(page).toContain(`<div data-plan-editor data-sel="${dinner}"`);
});
