// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import type { KnownPerson } from "../../src/people/known.js";
import {
  applyPick,
  type Chip,
  carriedFilter,
  chipProblem,
  chipsRefusal,
  leversValid,
  NO_LEVERS,
  peoplePicker,
  pickerAction,
  readChips,
  splitAddresses,
  uniqueChips,
} from "../../src/web/people-picker.js";

// The people picker's own logic (DESIGN §10 *Asking when*, rc48): chips read from plain fields,
// what each button does, and what refuses a form.

const LEA: KnownPerson = {
  personId: "p-lea",
  shown: { name: "lea", email: null },
  places: [
    { kind: "group", id: "g-table", name: "Table" },
    { kind: "event", id: "e-pizza", name: "Pizza night" },
  ],
};
const CAT: KnownPerson = {
  personId: "p-cat",
  shown: { name: "cat", email: "cat@example.org" },
  places: [{ kind: "group", id: "g-band", name: "Band" }],
};
const DAN: KnownPerson = {
  personId: "p-dan",
  shown: { name: "dan", email: null },
  places: [{ kind: "group", id: "g-band", name: "Band" }],
};
const KNOWN = [LEA, CAT, DAN];

const chip = (kind: Chip["kind"], value: string, more: Partial<Chip> = {}): Chip => ({
  kind,
  value,
  editTier: "view",
  visibility: "FULL",
  ask: "",
  from: null,
  ...more,
});

it("splits pasted addresses on spaces, commas, semicolons and new lines", () => {
  expect(splitAddresses(" a@x.org, b@x.org;c@x.org\n\n d@x.org  ")).toEqual([
    "a@x.org",
    "b@x.org",
    "c@x.org",
    "d@x.org",
  ]);
  expect(splitAddresses("  ")).toEqual([]);
});

it("reads the chips a form carries, then what was pasted, each once and at most the limit", () => {
  const chips = readChips(
    {
      pc_0: "e:Lea@Example.org",
      pt_0: "edit",
      pv_0: "DETAILS",
      pa_0: "accept",
      pc_2: "p:p-cat",
      pg_2: "g-band",
      pc_3: "x:nonsense",
      pc_4: "e:   ",
      email: "lea@example.org new@example.org",
      editTier: "propose",
      visibility: "BUSY",
      newAsk: "ack",
    },
    10,
  );
  expect(chips).toEqual([
    chip("email", "Lea@Example.org", { editTier: "edit", visibility: "DETAILS", ask: "accept" }),
    chip("person", "p-cat", { from: "g-band" }),
    chip("email", "new@example.org", { editTier: "propose", visibility: "BUSY", ask: "ack" }),
  ]);
  // Missing levers are the quietest ones; a long value is cut, never refused here.
  expect(readChips({ pc_0: "p:p-lea", pt_0: "nope", pa_0: "nope" }, 10)).toEqual([
    chip("person", "p-lea"),
  ]);
  expect(readChips({ email: "a@x.org b@x.org c@x.org" }, 2).map((c) => c.value)).toEqual([
    "a@x.org",
    "b@x.org",
  ]);
  expect(readChips({ pc_0: `e:${"a".repeat(400)}` }, 1)[0]?.value).toHaveLength(320);
  expect(readChips({ pc_99: "p:late" }, 5)).toEqual([chip("person", "late")]);
  expect(readChips({ pc_100: "p:too-far" }, 5)).toEqual([]);
});

it("one chip per address in any case, and per person", () => {
  expect(
    uniqueChips([
      chip("email", "A@x.org"),
      chip("email", "a@X.org"),
      chip("person", "p"),
      chip("person", "p"),
      chip("person", "q"),
    ]).map((c) => c.value),
  ).toEqual(["A@x.org", "p", "q"]);
});

it("a picker button is pp; its filter is carried in pp_filter", () => {
  expect(pickerAction({ pp: "add" })).toBe("add");
  expect(pickerAction({ pp: "" })).toBeNull();
  expect(pickerAction({})).toBeNull();
  expect(carriedFilter({ pp_filter: "g-band" })).toBe("g-band");
  expect(carriedFilter({ pp_filter: "" })).toBeNull();
});

it("buttons remove a chip, pick someone you know, add a group's people, and filter", () => {
  const base = {
    known: KNOWN,
    max: 10,
    filter: null,
    exclude: new Set<string>(),
  };
  const two = [chip("email", "a@x.org"), chip("email", "b@x.org")];
  expect(applyPick({ ...base, chips: two, action: "rm:0", filter: "g-band" })).toEqual({
    chips: [chip("email", "b@x.org")],
    filter: "g-band",
  });
  expect(applyPick({ ...base, chips: two, action: "rm:7" }).chips).toEqual(two);
  expect(applyPick({ ...base, chips: [], action: "pick:p-lea" }).chips).toEqual([
    chip("person", "p-lea"),
  ]);
  // Nobody the suggestions didn't offer: a stranger, or someone already in through the group.
  expect(applyPick({ ...base, chips: [], action: "pick:p-stranger" }).chips).toEqual([]);
  expect(
    applyPick({ ...base, chips: [], action: "pick:p-lea", exclude: new Set(["p-lea"]) }).chips,
  ).toEqual([]);
  expect(applyPick({ ...base, chips: [], action: "pick:p-lea", max: 0 }).chips).toEqual([]);
  // A group's people, each saying where they came from; the filter moves to it.
  expect(
    applyPick({
      ...base,
      chips: [chip("person", "p-cat")],
      action: "group:g-band",
      exclude: new Set(["p-lea"]),
    }),
  ).toEqual({
    chips: [chip("person", "p-cat"), chip("person", "p-dan", { from: "g-band" })],
    filter: "g-band",
  });
  expect(applyPick({ ...base, chips: [], action: "group:g-band", max: 1 }).chips).toHaveLength(1);
  expect(applyPick({ ...base, chips: two, action: "filter:g-table" })).toEqual({
    chips: two,
    filter: "g-table",
  });
  expect(applyPick({ ...base, chips: two, action: "filter:", filter: "g-table" }).filter).toBe(
    null,
  );
  expect(applyPick({ ...base, chips: two, action: "add", filter: "g-band" })).toEqual({
    chips: two,
    filter: "g-band",
  });
});

it("a chip is marked when its address isn't one, or its person isn't someone you know", () => {
  expect(chipProblem(chip("email", "lea@example.org"), KNOWN)).toBeNull();
  expect(chipProblem(chip("email", "x y"), KNOWN)).toBe("not an email address");
  expect(chipProblem(chip("person", "p-lea"), KNOWN)).toBeNull();
  expect(chipProblem(chip("person", "p-gone"), KNOWN)).toBe(
    "no longer someone you share a group, event or thread with",
  );
  expect(chipsRefusal([chip("email", "lea@example.org"), chip("person", "p-cat")], KNOWN)).toBe(
    null,
  );
  expect(chipsRefusal([chip("email", "x y"), chip("email", "nope")], KNOWN)).toBe(
    "Not an email address: x y, nope. Fix or remove the marked people first.",
  );
  expect(chipsRefusal([chip("person", "p-gone")], KNOWN)).toBe(
    "Someone chosen is no longer someone you share a group, event or thread with. Fix or remove the marked people first.",
  );
});

it("levers off the list are refused, never read as a default; HIDDEN only where allowed", () => {
  expect(leversValid({}, false)).toBe(true);
  expect(leversValid({ editTier: "edit", visibility: "BUSY", newAsk: "ack" }, false)).toBe(true);
  expect(leversValid({ editTier: "owner" }, false)).toBe(false);
  expect(leversValid({ visibility: "ALL" }, true)).toBe(false);
  expect(leversValid({ newAsk: "maybe" }, false)).toBe(false);
  expect(leversValid({ visibility: "HIDDEN" }, false)).toBe(false);
  expect(leversValid({ visibility: "HIDDEN" }, true)).toBe(true);
  expect(leversValid({ pt_3: "propose", pv_3: "DETAILS", pa_3: "accept" }, false)).toBe(true);
  expect(leversValid({ pt_3: "x" }, false)).toBe(false);
  expect(leversValid({ pv_99: "HIDDEN" }, false)).toBe(false);
  expect(leversValid({ pa_0: "x" }, false)).toBe(false);
});

it("draws chips, the paste field and suggestions — names and places, an address only if shown", () => {
  const page = String(
    peoplePicker({
      chips: [
        chip("email", "new@example.org"),
        chip("person", "p-dan", { from: "g-band" }),
        chip("email", "x y"),
      ],
      known: KNOWN,
      levers: { terms: true, asking: true },
      filter: null,
      lead: "Who is it for?",
      group: { name: "Table", members: ["lea"] },
      exclude: new Set(["p-lea"]),
    }),
  );
  expect(page).toContain('<input type="hidden" name="pc_0" value="e:new@example.org" />');
  expect(page).toContain('<input type="hidden" name="pc_1" value="p:p-dan" />');
  expect(page).toContain('<input type="hidden" name="pg_1" value="g-band" />');
  expect(page).toContain('<summary>dan <span class="muted">· from Band</span></summary>');
  expect(page).toContain(
    '<li class="chip bad"><details><summary>x y <span class="why">· not an email address</span>',
  );
  expect(page).toContain('name="pt_0"');
  expect(page).toContain('name="pa_2"');
  expect(page).toContain('<button type="submit" name="pp" value="rm:2">Remove</button>');
  expect(page).toContain(
    '<summary>Table <span class="muted">· 1 person</span></summary><p class="small">lea</p>',
  );
  expect(page).toContain('<textarea name="email"');
  expect(page).toContain('name="newAsk"');
  // Lea is in through the group, Dan is chosen: only Cat is suggested, with the address she shows.
  expect(page).not.toContain('value="pick:p-lea"');
  expect(page).not.toContain('value="pick:p-dan"');
  expect(page).toContain(
    '<button type="submit" name="pp" value="pick:p-cat">+ cat</button> <span class="muted">cat@example.org</span> <span class="muted small">· Band</span>',
  );
  expect(page).toContain('value="filter:g-table" aria-pressed="false">Table</button>');
  expect(page).toContain('value="filter:" aria-pressed="true">Everyone</button>');
  expect(page).not.toContain('value="group:');

  const quiet = String(
    peoplePicker({
      chips: [chip("person", "p-cat")],
      known: KNOWN,
      levers: NO_LEVERS,
      filter: "g-band",
      lead: "",
      group: null,
      exclude: new Set(),
    }),
  );
  expect(quiet).not.toContain('name="pt_0"');
  expect(quiet).not.toContain('name="editTier"');
  expect(quiet).toContain('<input type="hidden" name="pp_filter" value="g-band" />');
  expect(quiet).toContain('value="group:g-band">+ Everyone from Band (1)</button>');
  expect(quiet).toContain('value="pick:p-dan"');
  expect(quiet).not.toContain('value="pick:p-lea"'); // not in Band
  const nobody = String(
    peoplePicker({
      chips: [],
      known: [],
      levers: NO_LEVERS,
      filter: null,
      lead: "",
      group: null,
      exclude: new Set(),
    }),
  );
  expect(nobody).not.toContain("People you know");
  expect(nobody).not.toContain('class="chips"');
});
