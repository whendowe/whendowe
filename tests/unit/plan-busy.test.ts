// SPDX-License-Identifier: AGPL-3.0-or-later
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { busyAssets, busySpans } from "../../src/web/plan-editor.js";

// The busy script of the plan pages and voting (DESIGN §10 rc41, B1b): extracted from the
// rendered assets and run without a document, so these check exactly what browsers get.
// The page itself is driven in tests/browser/plans.spec.ts.

const assets = busyAssets().value;
const source = assets.slice(assets.indexOf("<script>") + 8, assets.lastIndexOf("</script>"));
const sandbox: { WhenDoWePlanBusy?: unknown } = {};
runInNewContext(source, sandbox);
const fn = z.custom<(...args: unknown[]) => unknown>((v) => typeof v === "function");
const api = z
  .object({ spans: fn, dayText: fn, clashText: fn, asks: fn })
  .parse(sandbox.WhenDoWePlanBusy);
const spanList = z.array(z.object({ a: z.string(), z: z.string() }));
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const spans = (items: unknown) => spanList.parse(plain(api.spans(items)));
const dayText = (items: unknown, k: string) => z.string().parse(api.dayText(api.spans(items), k));
const clash = (items: unknown, attr: string) =>
  z.string().parse(api.clashText(api.spans(items), attr));
const asks = (keys: string[]) =>
  z.array(z.object({ from: z.string(), to: z.string() })).parse(plain(api.asks(keys)));

const evening = { allDay: false, start: "2101-11-21T18:00", end: "2101-11-21T20:00" };
const weekend = { allDay: true, from: "2101-11-26", to: "2101-11-27" };

it("holds nothing a tagged template would cook (backslash, backtick, dollar-brace)", () => {
  expect(source).not.toMatch(/[\\`]|\$\{/);
});

describe("spans", () => {
  it("timed as they come, whole days to the midnight after the last", () => {
    expect(spans([evening, weekend])).toEqual([
      { a: "2101-11-21T18:00", z: "2101-11-21T20:00" },
      { a: "2101-11-26T00:00", z: "2101-11-28T00:00" },
    ]);
  });

  it("skips anything malformed, empty or backwards", () => {
    expect(
      spans([
        null,
        "x",
        { allDay: false, start: "2101-11-21T18:00" },
        { allDay: false, start: "2101-02-30T18:00", end: "2101-03-01T18:00" },
        { allDay: false, start: "2101-11-21 18:00", end: "2101-11-21T20:00" },
        { allDay: false, start: "2101-11-21T20:00", end: "2101-11-21T20:00" },
        { allDay: true, from: "2101-11-27", to: "2101-11-26" },
        { allDay: true, from: "2101-11-26" },
      ]),
    ).toEqual([]);
    expect(spans("nope")).toEqual([]);
  });
});

describe("dayText", () => {
  it("what is on one day, clipped to it, earliest first, each once", () => {
    const late = { allDay: false, start: "2101-11-21T23:00", end: "2101-11-22T01:00" };
    expect(dayText([late, evening, evening], "2101-11-21")).toBe("18:00–20:00, 23:00–24:00");
    expect(dayText([late], "2101-11-22")).toBe("00:00–01:00");
    expect(dayText([weekend], "2101-11-27")).toBe("all day");
    expect(dayText([weekend, evening], "2101-11-28")).toBe("");
    // Ending at the day's first minute, or starting at the next day's, is not on it.
    const toMidnight = { allDay: false, start: "2101-11-20T22:00", end: "2101-11-21T00:00" };
    expect(dayText([toMidnight], "2101-11-21")).toBe("");
    expect(dayText([toMidnight], "2101-11-20")).toBe("22:00–24:00");
  });
});

describe("clashText", () => {
  const one = (e: { allDay: boolean; startLocal: string; endLocal: string }) => busySpans([e]);

  it("one time: busy then, or nothing; touching ends don't clash", () => {
    const at = (s: string, e: string) =>
      clash([evening], one({ allDay: false, startLocal: s, endLocal: e }));
    expect(at("2101-11-21T19:00", "2101-11-21T21:00")).toBe("You're busy then");
    expect(at("2101-11-21T17:00", "2101-11-21T18:30")).toBe("You're busy then");
    expect(at("2101-11-21T20:00", "2101-11-21T22:00")).toBe("");
    expect(at("2101-11-21T16:00", "2101-11-21T18:00")).toBe("");
    expect(
      clash(
        [],
        one({ allDay: false, startLocal: "2101-11-21T19:00", endLocal: "2101-11-21T21:00" }),
      ),
    ).toBe("");
  });

  it("whole days: how many of them have something on", () => {
    const days = one({ allDay: true, startLocal: "2101-11-20", endLocal: "2101-11-28" });
    expect(days).toBe("d:2101-11-20/2101-11-28");
    expect(clash([evening, weekend], days)).toBe("You're busy on 3 of these days");
    expect(
      clash([weekend], one({ allDay: true, startLocal: "2101-11-25", endLocal: "2101-11-26" })),
    ).toBe("");
  });

  it("several events: how many of them meet something", () => {
    const plan = busySpans([
      { allDay: false, startLocal: "2101-11-21T19:00", endLocal: "2101-11-21T21:00" },
      { allDay: true, startLocal: "2101-11-27", endLocal: "2101-11-28" },
      { allDay: false, startLocal: "2101-11-23T19:00", endLocal: "2101-11-23T21:00" },
    ]);
    expect(clash([evening, weekend], plan)).toBe("You're busy during 2 of these events");
    expect(clash([evening], plan)).toBe("You're busy during 1 of these events");
    expect(clash([], plan)).toBe("");
  });

  it("ignores what it can't read", () => {
    expect(clash([evening], "")).toBe("");
    expect(clash([evening], "x:2101-11-21T19:00/2101-11-21T21:00")).toBe("");
    expect(clash([evening], "t:2101-11-21T21:00/2101-11-21T19:00")).toBe("");
    expect(clash([evening], "t:2101-11-21T19:00")).toBe("");
    expect(clash([weekend], "d:2101-11-27/2101-11-27")).toBe("");
  });
});

it("an option's events go to the page to the minute, as stored times carry seconds", () => {
  expect(
    busySpans([
      { allDay: false, startLocal: "2101-11-21T18:00:00", endLocal: "2101-11-21T20:30:00" },
      { allDay: true, startLocal: "2101-11-26", endLocal: "2101-11-28" },
    ]),
  ).toBe("t:2101-11-21T18:00/2101-11-21T20:30 d:2101-11-26/2101-11-28");
});

describe("asks", () => {
  it("first to last day on screen, in at most 62-day requests, at most six of them", () => {
    expect(asks([])).toEqual([]);
    expect(asks(["2101-11-21", "2101-11-02", "x", "2101-11-30"])).toEqual([
      { from: "2101-11-02", to: "2101-11-30" },
    ]);
    expect(asks(["2101-01-01", "2101-03-03"])).toEqual([{ from: "2101-01-01", to: "2101-03-03" }]); // 62 days
    expect(asks(["2101-01-01", "2101-03-04"])).toEqual([
      { from: "2101-01-01", to: "2101-03-03" },
      { from: "2101-03-04", to: "2101-03-04" },
    ]);
    const year = asks(["2101-01-01", "2102-12-31"]);
    expect(year).toHaveLength(6);
    expect(year[5]).toEqual({ from: "2101-11-07", to: "2102-01-07" });
  });
});
