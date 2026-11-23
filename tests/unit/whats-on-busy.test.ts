// SPDX-License-Identifier: AGPL-3.0-or-later
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { whatsOnBusyAssets } from "../../src/web/whats-on-busy.js";

// What's on's script (DESIGN §10 rc58, F2b): extracted from the rendered assets and run without
// a document, so these check exactly what browsers get. The page itself is driven in
// tests/browser/whats-on.spec.ts.

const assets = whatsOnBusyAssets().value;
const source = assets.slice(assets.indexOf("<script>") + 8, assets.lastIndexOf("</script>"));
const sandbox: { WhenDoWeWhatsOnBusy?: unknown } = {};
runInNewContext(source, sandbox);
const fn = z.custom<(...args: unknown[]) => unknown>((v) => typeof v === "function");
const api = z
  .object({ spans: fn, clashes: fn, countText: fn, googleLine: fn })
  .parse(sandbox.WhenDoWeWhatsOnBusy);
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const spans = (items: unknown) =>
  z.array(z.object({ a: z.number(), z: z.number() })).parse(plain(api.spans(items)));
const clashes = (items: unknown, start: unknown, end: unknown) =>
  z.boolean().parse(api.clashes(api.spans(items), start, end));

const ms = (t: string) => Date.parse(t);
const evening = { allDay: false, start: "2101-11-21T18:00", end: "2101-11-21T20:00" };

it("holds nothing a tagged template would cook (backslash, backtick, dollar-brace)", () => {
  expect(source).not.toMatch(/[\\`]|\$\{/);
});

describe("spans", () => {
  it("timed busy times, as UTC instants", () => {
    expect(spans([evening])).toEqual([
      { a: ms("2101-11-21T18:00:00Z"), z: ms("2101-11-21T20:00:00Z") },
    ]);
  });

  it("leaves out whole days: the server counted those already", () => {
    expect(spans([{ allDay: true, from: "2101-11-21", to: "2101-11-22" }, evening])).toHaveLength(
      1,
    );
  });

  it("skips anything malformed, empty or backwards", () => {
    expect(
      spans([
        null,
        "x",
        { start: "2101-11-21T18:00", end: "2101-11-21T20:00" },
        { allDay: false, start: "2101-11-21T18:00" },
        { allDay: false, start: 1, end: 2 },
        { allDay: false, start: "2101-11-21 18:00", end: "2101-11-21T20:00" },
        { allDay: false, start: "2101-11-21T18:00", end: "2101-11-21T20:00:00" },
        { allDay: false, start: "2101-02-30T18:00", end: "2101-13-01T18:00" },
        { allDay: false, start: "2101-11-21T20:00", end: "2101-11-21T20:00" },
        { allDay: false, start: "2101-11-21T20:00", end: "2101-11-21T19:00" },
      ]),
    ).toEqual([]);
    expect(spans("nope")).toEqual([]);
    expect(spans(undefined)).toEqual([]);
  });
});

describe("clashes", () => {
  it("an event overlapping a busy time, by instant", () => {
    expect(clashes([evening], "2101-11-21T19:00:00Z", "2101-11-21T21:00:00Z")).toBe(true);
    expect(clashes([evening], "2101-11-21T17:00:00Z", "2101-11-21T18:01:00Z")).toBe(true);
    expect(clashes([evening], "2101-11-21T18:30:00Z", "2101-11-21T19:30:00Z")).toBe(true);
    // An event in another zone: the same instants.
    expect(clashes([evening], "2101-11-21T20:30:00+01:00", "2101-11-21T22:00:00+01:00")).toBe(true);
  });

  it("touching ends don't overlap", () => {
    expect(clashes([evening], "2101-11-21T20:00:00Z", "2101-11-21T22:00:00Z")).toBe(false);
    expect(clashes([evening], "2101-11-21T16:00:00Z", "2101-11-21T18:00:00Z")).toBe(false);
  });

  it("a moment with no length meets what is going on then, from its start", () => {
    expect(clashes([evening], "2101-11-21T18:00:00Z", "2101-11-21T18:00:00Z")).toBe(true);
    expect(clashes([evening], "2101-11-21T19:59:00Z", "2101-11-21T19:59:00Z")).toBe(true);
    expect(clashes([evening], "2101-11-21T20:00:00Z", "2101-11-21T20:00:00Z")).toBe(false);
    expect(clashes([evening], "2101-11-21T17:59:00Z", "2101-11-21T17:59:00Z")).toBe(false);
  });

  it("an all-day event, with no instants, meets nothing; nor anything malformed", () => {
    expect(clashes([evening], "", "")).toBe(false);
    expect(clashes([evening], null, null)).toBe(false);
    expect(clashes([evening], "2101-11-21T19:00:00Z", "soon")).toBe(false);
    expect(clashes([evening], "2101-11-21T19:00:00Z", "2101-11-21T18:30:00Z")).toBe(false);
    expect(clashes([], "2101-11-21T19:00:00Z", "2101-11-21T21:00:00Z")).toBe(false);
  });

  it("any of several busy times", () => {
    const morning = { allDay: false, start: "2101-11-22T08:00", end: "2101-11-22T09:00" };
    expect(clashes([evening, morning], "2101-11-22T08:30:00Z", "2101-11-22T10:00:00Z")).toBe(true);
  });
});

it("counts like the server", () => {
  expect(api.countText(1)).toBe("(1 event overlaps something of yours)");
  expect(api.countText(3)).toBe("(3 events overlap something of yours)");
});

it("says what Google's part was, or nothing", () => {
  expect(api.googleLine("shown")).toBe("Your Google busy times are counted too.");
  expect(api.googleLine("failed")).toBe("Couldn't load your Google busy times.");
  expect(api.googleLine("unavailable")).toBe(
    "Showing Google busy times isn't available to this account.",
  );
  expect(api.googleLine(undefined)).toBe("");
  expect(api.googleLine("none")).toBe("");
});
