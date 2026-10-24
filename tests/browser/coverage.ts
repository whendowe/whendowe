// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

// Coverage of the picker's script, measured where all of it runs (DESIGN §9 rc17).
// vitest cannot see it: the script is a string inside src/web/picker.ts. Every browser
// test records Chromium's JS coverage for it (fixtures.ts). This global teardown
// merges those records, maps them back onto picker.ts lines, writes an lcov report
// and a summary, and, when asked to, enforces the thresholds below.
//
// Thresholds are ratchet-only: raise them as tests land, never lower them
// (AGENTS.md: never weaken the verifier). The state machine draws different sequences
// each run, so the figure moves a little: three full runs (2026-10-24) measured lines
// 88.7-90% and functions 92.3-93.4%. The floors sit a point below the lowest.

export const THRESHOLDS = { lines: 87, functions: 91 };

const PICKER = new URL("../../src/web/picker.ts", import.meta.url);
const RESULTS = new URL("./test-results/", import.meta.url);
const REPORT = new URL("./coverage/", import.meta.url);
export const RAW_NAME = "picker-coverage.json";

const rangeSchema = z.object({ startOffset: z.number(), endOffset: z.number(), count: z.number() });
const functionSchema = z.object({ functionName: z.string(), ranges: z.array(rangeSchema) });
export const runSchema = z.object({ source: z.string(), functions: z.array(functionSchema) });
type Run = z.infer<typeof runSchema>;

/** The script's text in picker.ts and the line it starts on (0-based). */
export function pickerScript(): { source: string; line: number } {
  const text = readFileSync(PICKER, "utf8");
  const open = "const PICKER_SCRIPT = html`<script>";
  const start = text.indexOf(open) + open.length;
  const end = text.indexOf("</script>`;", start);
  if (start < open.length || end === -1) throw new Error("picker.ts: PICKER_SCRIPT not found");
  return { source: text.slice(start, end), line: text.slice(0, start).split("\n").length - 1 };
}

/**
 * Which characters of the script ran, in one run. V8's ranges nest: a function's first
 * range is its whole extent, and the ranges after it carve out blocks with their own
 * counts. The innermost range containing a character decides it, so wider ranges
 * are applied first and narrower ones overwrite them.
 */
function executed(run: Run): Uint8Array {
  const ran = new Uint8Array(run.source.length);
  const ranges = run.functions.flatMap((f) => f.ranges);
  ranges.sort((a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset));
  for (const r of ranges) ran.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset);
  return ran;
}

export interface Coverage {
  /** picker.ts line (1-based) → whether every code character on it ran. */
  readonly lines: Map<number, boolean>;
  /** picker.ts line (1-based) of each function → its name and whether it ran. */
  readonly functions: Map<number, { name: string; ran: boolean }>;
}

/** Merge runs of the script and map them onto picker.ts. A run of other code is refused. */
export function mapCoverage(runs: readonly Run[], script = pickerScript()): Coverage {
  const ran = new Uint8Array(script.source.length);
  const functions = new Map<number, { name: string; ran: boolean }>();
  const lineAt = (offset: number) =>
    script.line + script.source.slice(0, offset).split("\n").length;
  for (const run of runs) {
    // The mapping is exact only if the page carries picker.ts's text verbatim.
    if (run.source !== script.source) throw new Error("coverage run is not picker.ts's script");
    const r = executed(run);
    for (let i = 0; i < r.length; i++) if (r[i] === 1) ran[i] = 1;
    for (const f of run.functions) {
      const extent = f.ranges[0];
      // The first entry is the whole script, not a function.
      if (extent === undefined || (extent.startOffset === 0 && f.functionName === "")) continue;
      const line = lineAt(extent.startOffset);
      const seen = functions.get(line);
      functions.set(line, {
        name: f.functionName === "" ? "(anonymous)" : f.functionName,
        ran: (seen?.ran ?? false) || extent.count > 0,
      });
    }
  }
  const lines = new Map<number, boolean>();
  let offset = 0;
  script.source.split("\n").forEach((text, i) => {
    const code = text.trim();
    // Blank lines, comments, and lines of nothing but closing punctuation are not code:
    // V8 marks the tail of a block after a return as unexecuted, braces included.
    const isCode = code !== "" && !/^(\/\/|\/\*|\*)/.test(code) && !/^[\s{}()[\];,]*$/.test(code);
    if (isCode) {
      let all = true;
      for (let c = 0; c < text.length; c++) {
        if (text[c] !== " " && ran[offset + c] !== 1) all = false;
      }
      lines.set(script.line + i + 1, all);
    }
    offset += text.length + 1;
  });
  return { lines, functions };
}

function percent(hit: number, total: number): number {
  return total === 0 ? 100 : Math.floor((hit / total) * 1000) / 10;
}

export function summarize(c: Coverage) {
  const lineHits = [...c.lines.values()].filter(Boolean).length;
  const fnHits = [...c.functions.values()].filter((f) => f.ran).length;
  const missed = [...c.lines].filter(([, hit]) => !hit).map(([line]) => line);
  // Consecutive missed lines as ranges: "412-415, 590".
  const spans: string[] = [];
  for (let i = 0; i < missed.length; i++) {
    const from = missed[i];
    while (i + 1 < missed.length && (missed[i + 1] ?? 0) === (missed[i] ?? 0) + 1) i++;
    spans.push(from === missed[i] ? `${from}` : `${from}-${missed[i]}`);
  }
  return {
    lines: { hit: lineHits, total: c.lines.size, pct: percent(lineHits, c.lines.size) },
    functions: { hit: fnHits, total: c.functions.size, pct: percent(fnHits, c.functions.size) },
    missed: spans.join(", "),
  };
}

export function lcov(c: Coverage): string {
  const out = ["TN:browser", "SF:src/web/picker.ts"];
  for (const [line, f] of c.functions) out.push(`FN:${line},${f.name}@${line}`);
  for (const [line, f] of c.functions) out.push(`FNDA:${f.ran ? 1 : 0},${f.name}@${line}`);
  const s = summarize(c);
  out.push(`FNF:${s.functions.total}`, `FNH:${s.functions.hit}`);
  for (const [line, hit] of c.lines) out.push(`DA:${line},${hit ? 1 : 0}`);
  out.push(`LF:${s.lines.total}`, `LH:${s.lines.hit}`, "end_of_record", "");
  return out.join("\n");
}

/** Every run the tests recorded (fixtures.ts writes one file per test). */
function recordedRuns(): Run[] {
  let files: string[];
  try {
    files = readdirSync(RESULTS, { recursive: true, encoding: "utf8" });
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(RAW_NAME))
    .flatMap((f) =>
      z.array(runSchema).parse(JSON.parse(readFileSync(new URL(f, RESULTS), "utf8"))),
    );
}

export default function report(): void {
  const runs = recordedRuns();
  if (runs.length === 0) return; // nothing ran the picker: a filtered run
  const c = mapCoverage(runs);
  const s = summarize(c);
  mkdirSync(REPORT, { recursive: true });
  writeFileSync(new URL("lcov.info", REPORT), lcov(c));
  console.log(
    `\npicker.ts (browser): lines ${s.lines.hit}/${s.lines.total} (${s.lines.pct}%), ` +
      `functions ${s.functions.hit}/${s.functions.total} (${s.functions.pct}%)` +
      (s.missed === "" ? "" : `\n  not run: ${s.missed}`),
  );
  // Only a full run is measured against the thresholds; scripts/browser.sh and CI set
  // this when no filter is given, so `--grep` while working never trips it.
  if (process.env.COVERAGE_THRESHOLDS !== "1") return;
  const low: string[] = [];
  if (s.lines.pct < THRESHOLDS.lines) low.push(`lines ${s.lines.pct}% < ${THRESHOLDS.lines}%`);
  if (s.functions.pct < THRESHOLDS.functions)
    low.push(`functions ${s.functions.pct}% < ${THRESHOLDS.functions}%`);
  if (low.length > 0) throw new Error(`picker.ts coverage below its threshold: ${low.join(", ")}`);
}
