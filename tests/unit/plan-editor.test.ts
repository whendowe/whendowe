// SPDX-License-Identifier: AGPL-3.0-or-later
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { planAssets } from "../../src/web/plan-editor.js";

// The week-row editor's logic (DESIGN §10 rc19, slice P4): the script is extracted from
// the rendered assets and run without a document, so these examples check exactly what
// browsers get. The gestures themselves are driven in tests/browser/plans.spec.ts.

const assets = planAssets().value;
const source = assets.slice(assets.indexOf("<script>") + 8, assets.lastIndexOf("</script>"));
const sandbox: { WhenDoWePlanEditor?: unknown } = {};
runInNewContext(source, sandbox);
const fn = z.custom<(...args: unknown[]) => unknown>((v) => typeof v === "function");
const api = z
  .object({ tap: fn, dragged: fn, addDays: fn, isDay: fn })
  .parse(sandbox.WhenDoWePlanEditor);
const state = z.object({
  start: z.string(),
  end: z.string(),
  grab: z.enum(["start", "end"]).nullable(),
  commit: z.boolean(),
});
const range = z.object({ start: z.string(), end: z.string() });
const tap = (s: { start: string; end: string; grab: "start" | "end" | null }, k: string) =>
  state.parse(JSON.parse(JSON.stringify(api.tap(s, k))));
const dragged = (o: { start: string; end: string }, which: string, delta: number) =>
  range.parse(JSON.parse(JSON.stringify(api.dragged(o, which, delta))));

describe("the shipped script", () => {
  it("holds nothing a tagged template would cook (backslash, backtick, dollar-brace)", () => {
    expect(source).not.toMatch(/[\\`]|\$\{/);
  });
});

describe("tap to pick up, tap to put down", () => {
  const week = { start: "2026-11-09", end: "2026-11-15", grab: null };

  it("a middle day does nothing while no end is held", () => {
    expect(tap(week, "2026-11-12")).toEqual({ ...week, commit: false });
  });

  it("an end picks up; tapping it again puts it back", () => {
    const held = tap(week, "2026-11-15");
    expect(held).toEqual({ ...week, grab: "end", commit: false });
    expect(tap(held, "2026-11-15")).toEqual({ ...week, grab: null, commit: false });
  });

  it("put down in another week, the stretch spans the boundary", () => {
    const held = tap(week, "2026-11-15");
    expect(tap(held, "2026-11-18")).toEqual({
      start: "2026-11-09",
      end: "2026-11-18",
      grab: null,
      commit: true,
    });
  });

  it("ends that cross swap", () => {
    const held = tap(week, "2026-11-09");
    expect(tap(held, "2026-11-20")).toEqual({
      start: "2026-11-15",
      end: "2026-11-20",
      grab: null,
      commit: true,
    });
  });
});

describe("dragging by days", () => {
  const o = { start: "2026-11-09", end: "2026-11-15" };
  it("an end moves by the finger's days, across weeks and back", () => {
    expect(dragged(o, "end", 3)).toEqual({ start: "2026-11-09", end: "2026-11-18" });
    expect(dragged(o, "start", -2)).toEqual({ start: "2026-11-07", end: "2026-11-15" });
    expect(dragged(o, "end", -9)).toEqual({ start: "2026-11-06", end: "2026-11-09" });
  });
  it("the body moves the whole stretch", () => {
    expect(dragged(o, "body", 7)).toEqual({ start: "2026-11-16", end: "2026-11-22" });
  });
  it("months and years roll over", () => {
    expect(api.addDays("2026-12-30", 3)).toBe("2027-01-02");
    expect(api.isDay("2026-02-30")).toBe(false);
    expect(api.isDay("2026-02-28")).toBe(true);
  });
});
