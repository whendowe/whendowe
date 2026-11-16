// SPDX-License-Identifier: AGPL-3.0-or-later
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { askDragAssets } from "../../src/web/ask-drag.js";

// The Ask page's drag (DESIGN §10 *Asking when*, rc47): the script is extracted from the
// rendered assets and run without a document, so these examples check exactly what browsers
// get. The gestures themselves are driven in tests/browser/ask.spec.ts.

const assets = askDragAssets().value;
const source = assets.slice(assets.indexOf("<script>") + 8, assets.lastIndexOf("</script>"));
const sandbox: { WhenDoWeAskDrag?: unknown } = {};
runInNewContext(source, sandbox);
const fn = z.custom<(...args: unknown[]) => unknown>((v) => typeof v === "function");
const api = z
  .object({ spanAction: fn, gripAction: fn, between: fn })
  .parse(sandbox.WhenDoWeAskDrag);
const action = z.string().nullable();
const span = (a: string, b: string) => action.parse(api.spanAction(a, b));
const grip = (g: string, ends: string, a: string, b: string) =>
  action.parse(api.gripAction(g, ends, a, b));
const between = (k: string, a: string, b: string) => z.boolean().parse(api.between(k, a, b));

describe("the shipped script", () => {
  it("holds nothing a tagged template would cook (backslash, backtick, dollar-brace)", () => {
    expect(source).not.toMatch(/[\\`]|\$\{/);
  });
});

describe("what a finished drag asks for", () => {
  it("a span is ordered, whichever way it was dragged; ending where it began is a tap", () => {
    expect(span("2026-11-03", "2026-11-06")).toBe("span:2026-11-03:2026-11-06");
    expect(span("2026-11-06", "2026-11-03")).toBe("span:2026-11-03:2026-11-06");
    expect(span("2026-11-03", "2026-11-03")).toBeNull();
    expect(span("", "2026-11-03")).toBeNull();
    expect(span("2026-11-03", "")).toBeNull();
  });

  it("a grip moves the end it holds; holding both, the direction decides", () => {
    expect(grip("1:0", "end", "2026-11-03", "2026-11-05")).toBe("move:1:0:end:2026-11-05");
    expect(grip("1:0", "start", "2026-11-03", "2026-11-01")).toBe("move:1:0:start:2026-11-01");
    expect(grip("0:2", "both", "2026-11-03T19:00", "2026-11-03T21:00")).toBe(
      "move:0:2:end:2026-11-03T21:00",
    );
    expect(grip("0:2", "both", "2026-11-03T19:00", "2026-11-03T17:00")).toBe(
      "move:0:2:start:2026-11-03T17:00",
    );
  });

  it("a grip back where it began, or one that names no end, asks for nothing", () => {
    expect(grip("1:0", "end", "2026-11-03", "2026-11-03")).toBeNull();
    expect(grip("1:0", "middle", "2026-11-03", "2026-11-05")).toBeNull();
    expect(grip("", "end", "2026-11-03", "2026-11-05")).toBeNull();
    expect(grip("1:0", "end", "", "2026-11-05")).toBeNull();
    expect(grip("1:0", "end", "2026-11-03", "")).toBeNull();
  });

  it("the preview covers the days between, inclusive, either way", () => {
    expect(between("2026-11-04", "2026-11-03", "2026-11-05")).toBe(true);
    expect(between("2026-11-03", "2026-11-03", "2026-11-05")).toBe(true);
    expect(between("2026-11-05", "2026-11-05", "2026-11-03")).toBe(true);
    expect(between("2026-11-04", "2026-11-05", "2026-11-03")).toBe(true);
    expect(between("2026-11-06", "2026-11-03", "2026-11-05")).toBe(false);
    expect(between("2026-11-02", "2026-11-05", "2026-11-03")).toBe(false);
    expect(between("2026-11-04", "", "2026-11-05")).toBe(false);
  });
});
