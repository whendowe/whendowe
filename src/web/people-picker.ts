// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type EditTier,
  editTierSchema,
  type Visibility,
  visibilitySchema,
} from "../people/invite.js";
import type { KnownPerson } from "../people/known.js";
import { normalizeEmail } from "../people/person.js";
import { type Html, html } from "./layout.js";

// The people picker (DESIGN §10 *Asking when*, rc48): one component wherever people are named —
// the Ask page, a new event or poll, an event's "Add people", a group's invites. Each chosen
// person is a chip, and a chip is plain fields in the page's own form, so it works without
// JavaScript: adding or removing one is a button that posts the form (`pp`), and the page comes
// back with its chips — saved on the Ask page, where every button saves, and not saved anywhere
// else. Tapping a chip opens it in place (a <details>) for its levers and Remove.
//
// Fields: `pc_I` is the chip ("e:" + an address as typed, or "p:" + a person id from the
// suggestions — never their address), `pt_I` / `pv_I` / `pa_I` its levers, `pg_I` the group
// it came from. `email` takes any number of addresses pasted at once, each becoming a chip with
// the levers chosen beside it (`editTier`, `visibility`, `newAsk`). Those names are the ones the
// one-address forms always used, so posting one address there still works as it did.

/** The most chips any one form reads, whatever its own limit. */
const MAX_FIELDS = 100;

type ShownVisibility = "FULL" | "DETAILS" | "BUSY";
export type AskFor = "accept" | "ack";

export interface Chip {
  readonly kind: "email" | "person";
  /** The address as typed (trimmed), or a person id. */
  readonly value: string;
  readonly editTier: EditTier;
  /** HIDDEN is never offered; each form decides whether a posted one is refused (leversValid). */
  readonly visibility: Visibility;
  readonly ask: AskFor | "";
  /** The group whose people were added at once, if it came that way. */
  readonly from: string | null;
}

/** Which levers a chip opens to: a question's have none (rc26). */
export interface Levers {
  /** Edit tier and visibility: an event's people, a group invite's defaults. */
  readonly terms: boolean;
  /** What they're asked (an event being made). */
  readonly asking: boolean;
}

export const NO_LEVERS: Levers = { terms: false, asking: false };

function field(form: Record<string, unknown>, key: string): string {
  const v = form[key];
  return typeof v === "string" ? v : "";
}

function askOf(raw: string): AskFor | "" {
  return raw === "accept" || raw === "ack" ? raw : "";
}

/** Split pasted text into addresses: spaces, commas, semicolons or new lines between them. */
export function splitAddresses(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter((e) => e !== "");
}

const keyOf = (c: Pick<Chip, "kind" | "value">) =>
  c.kind === "email" ? `e:${c.value.toLowerCase()}` : `p:${c.value}`;

/** Chips in the order given, each once (an address in any case is one address). */
export function uniqueChips(chips: readonly Chip[]): Chip[] {
  const seen = new Set<string>();
  return chips.filter((c) => {
    const k = keyOf(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The chips a form carries, then whatever was pasted, at most `max`. Nothing here refuses. */
export function readChips(form: Record<string, unknown>, max: number): Chip[] {
  const chips: Chip[] = [];
  for (let i = 0; i < MAX_FIELDS; i++) {
    const raw = field(form, `pc_${i}`);
    const kind = raw.startsWith("e:") ? "email" : raw.startsWith("p:") ? "person" : null;
    const value = raw.slice(2).trim().slice(0, 320);
    if (kind === null || value === "") continue;
    const tier = editTierSchema.safeParse(form[`pt_${i}`]);
    const vis = visibilitySchema.safeParse(form[`pv_${i}`]);
    const from = field(form, `pg_${i}`).slice(0, 64);
    chips.push({
      kind,
      value,
      editTier: tier.success ? tier.data : "view",
      visibility: vis.success ? vis.data : "FULL",
      ask: askOf(field(form, `pa_${i}`)),
      from: from === "" ? null : from,
    });
  }
  const tier = editTierSchema.safeParse(form.editTier);
  const vis = visibilitySchema.safeParse(form.visibility);
  for (const value of splitAddresses(field(form, "email")))
    chips.push({
      kind: "email",
      value: value.slice(0, 320),
      editTier: tier.success ? tier.data : "view",
      visibility: vis.success ? vis.data : "FULL",
      ask: askOf(field(form, "newAsk")),
      from: null,
    });
  return uniqueChips(chips).slice(0, max);
}

/**
 * Whether every lever the form carries is one on the list: a value that isn't is refused, never
 * read as a default, since a default could see more than was meant. HIDDEN only where allowed.
 */
export function leversValid(form: Record<string, unknown>, allowHidden: boolean): boolean {
  const ok = (key: string, check: (v: string) => boolean) => {
    const v = field(form, key);
    return v === "" || check(v);
  };
  const tier = (v: string) => editTierSchema.safeParse(v).success;
  const vis = (v: string) =>
    visibilitySchema.safeParse(v).success && (allowHidden || v !== "HIDDEN");
  const ask = (v: string) => askOf(v) !== "";
  if (!ok("editTier", tier) || !ok("visibility", vis) || !ok("newAsk", ask)) return false;
  for (let i = 0; i < MAX_FIELDS; i++)
    if (!ok(`pt_${i}`, tier) || !ok(`pv_${i}`, vis) || !ok(`pa_${i}`, ask)) return false;
  return true;
}

/** The picker button pressed, if it was one. */
export function pickerAction(form: Record<string, unknown>): string | null {
  const v = field(form, "pp");
  return v === "" ? null : v;
}

export interface Picked {
  readonly chips: Chip[];
  /** The group the suggestions are narrowed to. */
  readonly filter: string | null;
}

const inGroup = (k: KnownPerson, groupId: string) =>
  k.places.some((p) => p.kind === "group" && p.id === groupId);

/**
 * What a picker button does. Only people you know can be picked, and a group's people only
 * through a group you are in, so nothing here adds anyone the suggestions didn't offer.
 */
export function applyPick(input: {
  readonly chips: readonly Chip[];
  readonly action: string;
  readonly known: readonly KnownPerson[];
  readonly max: number;
  /** The filter shown when the button was pressed: kept unless the button changes it. */
  readonly filter: string | null;
  /** Already in some other way (the question's own group): never added again. */
  readonly exclude: ReadonlySet<string>;
}): Picked {
  const { chips, action, known, max, filter, exclude } = input;
  const person = (personId: string, from: string | null): Chip => ({
    kind: "person",
    value: personId,
    editTier: "view",
    visibility: "FULL",
    ask: "",
    from,
  });
  const rm = /^rm:(\d+)$/.exec(action);
  if (rm !== null) {
    const i = Number(rm[1]);
    return { chips: chips.filter((_, j) => j !== i), filter };
  }
  const pick = /^pick:(.+)$/.exec(action)?.[1];
  if (pick !== undefined)
    return {
      chips:
        known.some((k) => k.personId === pick) && !exclude.has(pick)
          ? uniqueChips([...chips, person(pick, null)]).slice(0, max)
          : [...chips],
      filter,
    };
  const group = /^group:(.+)$/.exec(action)?.[1];
  if (group !== undefined)
    return {
      chips: uniqueChips([
        ...chips,
        ...known
          .filter((k) => inGroup(k, group) && !exclude.has(k.personId))
          .map((k) => person(k.personId, group)),
      ]).slice(0, max),
      filter: group,
    };
  const narrowed = /^filter:(.*)$/.exec(action)?.[1];
  if (narrowed !== undefined)
    return { chips: [...chips], filter: narrowed === "" ? null : narrowed.slice(0, 64) };
  return { chips: [...chips], filter };
}

/** Why a chip can't be sent, or null: an address that isn't one, someone you no longer know. */
export function chipProblem(chip: Chip, known: readonly KnownPerson[]): string | null {
  if (chip.kind === "person")
    return known.some((k) => k.personId === chip.value)
      ? null
      : "no longer someone you share a group, event or thread with";
  try {
    normalizeEmail(chip.value);
    return null;
  } catch {
    return "not an email address";
  }
}

/** The refusal for a form with marked chips, or null when every chip can be sent. */
export function chipsRefusal(chips: readonly Chip[], known: readonly KnownPerson[]): string | null {
  const bad = chips.filter((c) => chipProblem(c, known) !== null);
  if (bad.length === 0) return null;
  const typed = bad.filter((c) => c.kind === "email").map((c) => c.value);
  const gone = bad.some((c) => c.kind === "person");
  return [
    typed.length === 0 ? "" : `Not an email address: ${typed.join(", ")}.`,
    gone ? "Someone chosen is no longer someone you share a group, event or thread with." : "",
    "Fix or remove the marked people first.",
  ]
    .filter((t) => t !== "")
    .join(" ");
}

/** The address typed, or the person as the suggestions show them. */
function chipName(chip: Chip, known: readonly KnownPerson[]): string {
  if (chip.kind === "email") return chip.value;
  return known.find((k) => k.personId === chip.value)?.shown.name ?? "Someone";
}

function groupName(id: string, known: readonly KnownPerson[]): string | null {
  for (const k of known)
    for (const p of k.places) if (p.kind === "group" && p.id === id) return p.name;
  return null;
}

const TIERS: readonly (readonly [EditTier, string])[] = [
  ["view", "can't change it"],
  ["propose", "can propose changes"],
  ["edit", "can edit it"],
];
const SEES: readonly (readonly [ShownVisibility, string])[] = [
  ["FULL", "sees everything"],
  ["DETAILS", "sees title, time and place"],
  ["BUSY", "sees only that the time is taken"],
];
const ASKS: readonly (readonly [AskFor | "", string])[] = [
  ["", "asked nothing"],
  ["accept", "must agree"],
  ["ack", "please acknowledge"],
];

function select(
  name: string,
  label: string,
  choices: readonly (readonly [string, string])[],
  chosen: string,
): Html {
  return html`<select name="${name}" aria-label="${label}">${choices.map(
    ([v, l]) => html`<option value="${v}" ${v === chosen ? html`selected` : ""}>${l}</option>`,
  )}</select>`;
}

export interface PickerView {
  readonly chips: readonly Chip[];
  readonly known: readonly KnownPerson[];
  readonly levers: Levers;
  readonly filter: string | null;
  readonly lead: string;
  /** The one group it was started from, shown as a chip naming its members (rc27). */
  readonly group: { readonly name: string; readonly members: readonly string[] } | null;
  /** People not to suggest: already in through the group, or already in it. */
  readonly exclude: ReadonlySet<string>;
}

const PICKER_STYLE = html`<style>
  .people .chips { list-style: none; padding: 0; margin: .5em 0; display: flex; flex-wrap: wrap; gap: .4em; }
  .people .chip { border: 1px solid var(--line, #8886); border-radius: 1em; padding: .15em .7em; }
  .people .chip[open], .people .chip details[open] { border-radius: .5em; }
  .people .chip summary { cursor: pointer; }
  .people .chip.bad { border-color: var(--error, #b00020); border-style: dashed; }
  .people .chip .why { color: var(--error, #b00020); }
  .people .chip details > :not(summary) { margin: .4em 0; }
  .people .known { list-style: none; padding: 0; }
  .people .known li { margin: .25em 0; }
</style>`;

/** The picker: chips, the field to paste into, and suggestions from people you know. */
export function peoplePicker(v: PickerView): Html {
  const chosen = new Set(v.chips.filter((c) => c.kind === "person").map((c) => c.value));
  const chips = v.chips.map((c, i) => {
    const why = chipProblem(c, v.known);
    const from = c.from === null ? null : groupName(c.from, v.known);
    return html`<li class="chip${why === null ? "" : " bad"}"><details><summary>${chipName(c, v.known)}${
      from === null ? "" : html` <span class="muted">· from ${from}</span>`
    }${why === null ? "" : html` <span class="why">· ${why}</span>`}</summary>
${
  v.levers.terms
    ? html`<p>${select(`pt_${i}`, `Can change it (${chipName(c, v.known)})`, TIERS, c.editTier)} ${select(`pv_${i}`, `Sees (${chipName(c, v.known)})`, SEES, c.visibility)}${
        v.levers.asking
          ? html` ${select(`pa_${i}`, `Asked (${chipName(c, v.known)})`, ASKS, c.ask)}`
          : ""
      }</p>`
    : ""
}<p><button type="submit" name="pp" value="rm:${i}">Remove</button></p></details><input type="hidden" name="pc_${i}" value="${c.kind === "email" ? "e:" : "p:"}${c.value}" />${
      c.from === null ? "" : html`<input type="hidden" name="pg_${i}" value="${c.from}" />`
    }</li>`;
  });
  const groupChip =
    v.group === null
      ? ""
      : html`<li class="chip"><details><summary>${v.group.name} <span class="muted">· ${v.group.members.length} ${v.group.members.length === 1 ? "person" : "people"}</span></summary><p class="small">${v.group.members.length === 0 ? "Nobody else yet." : v.group.members.join(", ")}</p></details></li>`;
  const groups = new Map<string, string>();
  for (const k of v.known)
    for (const p of k.places) if (p.kind === "group" && !groups.has(p.id)) groups.set(p.id, p.name);
  const shown = v.known.filter(
    (k) =>
      !chosen.has(k.personId) &&
      !v.exclude.has(k.personId) &&
      (v.filter === null || inGroup(k, v.filter)),
  );
  const filterName = v.filter === null ? null : (groups.get(v.filter) ?? null);
  const suggestions =
    v.known.length === 0
      ? ""
      : html`<h3>People you know</h3>
${
  groups.size === 0
    ? ""
    : html`<p class="row wrap"><button type="submit" name="pp" value="filter:" aria-pressed="${String(v.filter === null)}">Everyone</button>${[
        ...groups,
      ].map(
        ([id, name]) =>
          html` <button type="submit" name="pp" value="filter:${id}" aria-pressed="${String(v.filter === id)}">${name}</button>`,
      )}<input type="hidden" name="pp_filter" value="${v.filter ?? ""}" /></p>`
}${
  v.filter !== null && filterName !== null && shown.length > 0
    ? html`<p><button type="submit" name="pp" value="group:${v.filter}">+ Everyone from ${filterName} (${shown.length})</button></p>`
    : ""
}${
  shown.length === 0
    ? html`<p class="muted small">Everyone here is already in.</p>`
    : html`<ul class="known">${shown.map(
        (k) =>
          html`<li><button type="submit" name="pp" value="pick:${k.personId}">+ ${k.shown.name}</button>${
            k.shown.email === null ? "" : html` <span class="muted">${k.shown.email}</span>`
          } <span class="muted small">· ${k.places.map((p) => p.name).join(", ")}</span></li>`,
      )}</ul>`
}`;
  return html`${PICKER_STYLE}<fieldset class="people"><legend>People</legend>
<p class="muted">${v.lead}</p>
${v.chips.length === 0 && v.group === null ? "" : html`<ul class="chips">${groupChip}${chips}</ul>`}
<p><label>Add by email <span class="muted">(several at once: spaces, commas or new lines between them)</span><br /><textarea name="email" rows="2" style="width:100%"></textarea></label></p>
<p class="row wrap">${
    v.levers.terms
      ? html`${select("editTier", "Can change it (new)", TIERS, "view")} ${select("visibility", "Sees (new)", SEES, "FULL")} ${
          v.levers.asking ? select("newAsk", "Asked (new)", ASKS, "") : ""
        } `
      : ""
  }<button type="submit" name="pp" value="add">Add</button></p>
${suggestions}
</fieldset>`;
}

/** The filter a form carried, for a page drawn again after a button that wasn't the picker's. */
export function carriedFilter(form: Record<string, unknown>): string | null {
  const f = field(form, "pp_filter").slice(0, 64);
  return f === "" ? null : f;
}
