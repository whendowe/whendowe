// SPDX-License-Identifier: AGPL-3.0-or-later
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { type Page, test } from "./fixtures.js";
import {
  type Action,
  act,
  chips,
  clock,
  grid,
  initial,
  LENGTHS,
  MAX,
  type Model,
  minutes,
  describe as name,
  options,
  read,
  rows,
  step,
} from "./poll-machine.js";

// The poll picker as a state machine (DESIGN §9 rc17). Hegel draws a sequence of the
// actions the page offers at each moment, takes each one on the real page and in the
// model, and checks the page against the model and the invariants after every step.
// On failure it shrinks to the shortest sequence of taps; that sequence goes into
// REGRESSIONS below, which replay in every run.
//
// Gate vs soak, as for the property suite: a small budget here, SOAK=1 for the nightly.
// The soak budget is what fits the hour with room: sequences grow longer as Hegel
// explores, and 400 of them took 59.8 minutes in the pinned image (2026-10-24); 300
// took about 32.
const SOAK = process.env.SOAK !== undefined;
const CASES = SOAK ? 300 : 30;
const STEPS = SOAK ? 60 : 25;
const FROZEN = new Date("2026-10-24T10:00:00+02:00");

/** Shrunken sequences the machine found, kept as plain replays (AGENTS.md). */
const REGRESSIONS: readonly { readonly why: string; readonly actions: readonly Action[] }[] = [
  {
    // Found by the machine, as shrunk (2026-10-24): a second time on a day, then
    // edited to the first's start, left the same option in two rows.
    why: "editing a time to another's on the same day keeps it once",
    actions: [
      { type: "tap", day: 0 },
      { type: "kind", kind: "times" },
      { type: "tap", day: 0 },
      { type: "tap", day: 0 },
      { type: "month", by: 1 },
      { type: "tap", day: 0 },
      { type: "start", time: "00:00" },
      { type: "tap", day: 0 },
      { type: "month", by: 1 },
      { type: "tap", day: 0 },
      { type: "month", by: 1 },
      { type: "tap", day: 0 },
      { type: "tap", day: 0 },
      { type: "month", by: 1 },
      { type: "month", by: -1 },
      { type: "tap", day: 0 },
      { type: "tap", day: 0 },
      { type: "tap", day: 0 },
      { type: "another", option: 2 },
      { type: "own", option: 2, time: "03:00" },
    ],
  },
  {
    // The same, by hand: the shortest way there.
    why: "another time this day, edited back to the shared start, keeps it once",
    actions: [
      { type: "tap", day: 10 },
      { type: "another", option: 0 },
      { type: "own", option: 0, time: "19:00" },
    ],
  },
  {
    // Found by the soak (2026-10-24): when the edited option is the last one and becomes
    // a repeat, the list shrinks under the edit. It was the harness that broke there,
    // sending a second change to an input that was gone; the page was right.
    why: "the last option, edited into a repeat, leaves the list one shorter",
    actions: [
      { type: "tap", day: 10 },
      // 19:00 plus three hours runs past midnight, so the new time goes before: 16:00.
      { type: "another", option: 0 },
      { type: "own", option: 1, time: "16:00" },
    ],
  },
];

function drawInt(tc: hegel.TestCase, min: number, max: number): number {
  return tc.draw(gs.integers({ minValue: min, maxValue: max }));
}
/**
 * A start time. Half the draws reuse a time the poll already has (the shared start, an
 * option's own start, or one a length later), because collisions are where options can
 * end up the same; the rest are any quarter hour, as the time inputs step.
 */
function drawTime(tc: hegel.TestCase, m: Model): string {
  const near = [m.start, ...m.times.map((t) => t.own ?? m.start)].flatMap((t) => [
    t,
    clock((minutes(t) + m.length) % 1440),
  ]);
  if (drawInt(tc, 0, 1) === 0) return near[drawInt(tc, 0, near.length - 1)] ?? m.start;
  return clock(drawInt(tc, 0, 95) * 15);
}

/** A day on screen. Half the draws are days that already hold options, where taps interact. */
function drawDay(tc: hegel.TestCase, m: Model): number {
  const days = grid(m.view);
  const busy = days
    .map((d, i) => ({ d, i }))
    .filter(({ d }) =>
      m.kind === "times"
        ? m.times.some((t) => t.date === d)
        : m.days.some((x) => x.from === d || x.to === d) || m.pending === d,
    )
    .map(({ i }) => i);
  if (busy.length > 0 && drawInt(tc, 0, 1) === 0) return busy[drawInt(tc, 0, busy.length - 1)] ?? 0;
  return drawInt(tc, 0, days.length - 1);
}

/** One of the actions the page offers right now. */
function drawAction(tc: hegel.TestCase, m: Model): Action {
  const n = options(m).length;
  const offered: (() => Action)[] = [
    () => ({ type: "tap", day: drawDay(tc, m) }),
    () => ({ type: "month", by: drawInt(tc, 0, 1) === 0 ? -1 : 1 }),
    () => ({ type: "kind", kind: drawInt(tc, 0, 1) === 0 ? "times" : "days" }),
  ];
  if (n > 0) {
    offered.push(
      () => ({ type: "again" }),
      () => ({ type: "remove", option: drawInt(tc, 0, n - 1) }),
    );
  }
  if (m.kind === "times") {
    offered.push(
      () => ({ type: "start", time: drawTime(tc, m) }),
      () => ({ type: "length", minutes: LENGTHS[drawInt(tc, 0, LENGTHS.length - 1)] ?? 60 }),
    );
    if (n > 0) {
      offered.push(
        () => ({ type: "another", option: drawInt(tc, 0, n - 1) }),
        () => ({ type: "own", option: drawInt(tc, 0, n - 1), time: drawTime(tc, m) }),
      );
    }
  }
  const c = chips(m);
  if (c > 0) offered.push(() => ({ type: "choose", chip: drawInt(tc, 0, c - 1) }));
  const pick = offered[drawInt(tc, 0, offered.length - 1)];
  if (pick === undefined) throw new Error("no action offered");
  return pick();
}

/** A fresh form. The coverage so far is kept first: navigating drops V8's counts. */
async function open(page: Page, coverage: { flush: () => Promise<void> }): Promise<string[]> {
  await coverage.flush();
  const errors: string[] = [];
  page.removeAllListeners("pageerror");
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(new URL("./.pages/poll-new.html", import.meta.url).href);
  return errors;
}

/** The page against the model, and the invariants the server relies on. */
async function check(page: Page, m: Model, errors: string[], log: string[]): Promise<void> {
  const fail = (what: string): never => {
    throw new Error(`${what}\n  after: ${log.join(" → ")}`);
  };
  if (errors.length > 0) fail(`script error: ${errors.join("; ")}`);
  const seen = await read(page);
  const filled = seen.rows.filter((r) => r.start !== "");
  // What the server refuses: more than its limit, or the same option twice.
  if (filled.length > MAX) fail(`${filled.length} options, over the limit of ${MAX}`);
  const keys = filled.map((r) => `${r.start}/${r.end}`);
  const twice = keys.find((k, i) => keys.indexOf(k) !== i);
  if (twice !== undefined) fail(`the same option twice: ${twice}`);
  if (keys.join() !== [...keys].sort().join()) fail(`rows out of order: ${keys.join(", ")}`);
  // The page against the model.
  const want = rows(m);
  const got = seen.rows.slice(0, want.length);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fail(`rows ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
  if (seen.rows.slice(want.length).some((r) => r.start !== "" || r.end !== "")) {
    fail("rows left over after the options");
  }
  if (seen.allDay !== (m.kind === "days")) fail(`allDay is ${seen.allDay} for ${m.kind}`);
  if (seen.listed !== want.length) fail(`${seen.listed} options listed, expected ${want.length}`);
  if (seen.chips !== chips(m)) fail(`${seen.chips} chips in the panel, expected ${chips(m)}`);
  const days = grid(m.view);
  if (seen.days.length !== days.length)
    fail(`${seen.days.length} days shown, expected ${days.length}`);
  if (m.kind === "times") {
    days.forEach((day, i) => {
      const n = m.times.filter((t) => t.date === day).length;
      const badge = seen.days[i]?.badge ?? "";
      if (badge !== (n > 1 ? `×${n}` : "")) fail(`${day} shows "${badge}" for ${n} times`);
    });
  }
}

/** Take an action on the page; if the page has no such control, say after what. */
async function take(page: Page, a: Action, log: readonly string[]): Promise<void> {
  try {
    await act(page, a);
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)}\n  after: ${log.join(" → ")}`);
  }
}

async function run(
  page: Page,
  coverage: { flush: () => Promise<void> },
  actions: readonly Action[],
): Promise<void> {
  const errors = await open(page, coverage);
  const m = initial();
  const log: string[] = [];
  await check(page, m, errors, log);
  for (const a of actions) {
    log.push(name(a));
    await take(page, a, log);
    step(m, a);
    await check(page, m, errors, log);
  }
}

test.describe("poll picker state machine", { tag: "@machine" }, () => {
  // A control the model offers but the page lacks would otherwise wait out the whole
  // test; as a quick failure, Hegel can shrink it like any other.
  test.use({ actionTimeout: 2_000 });
  // One project is enough: the logic does not depend on width or theme.
  test.beforeEach(({ browserName }, info) => {
    test.skip(info.project.name !== "phone-light" || browserName !== "chromium");
  });
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(FROZEN);
  });

  for (const r of REGRESSIONS) {
    test(`regression: ${r.why}`, async ({ page, pickerCoverage }) => {
      await run(page, pickerCoverage, r.actions);
    });
  }

  test("any sequence of actions keeps the form what the model and the server expect", async ({
    page,
    pickerCoverage,
  }) => {
    // A hang detector for this test, not an assertion: ~30 sequences of up to 25 steps
    // take about a minute in the pinned image, the soak budget about half an hour.
    test.setTimeout(SOAK ? 3_600_000 : 300_000);
    // At soak budget, say how far it has got and what fails as it fails: Hegel reports
    // only once it has finished shrinking, and a run that ends at the timeout says nothing.
    const began = Date.now();
    let cases = 0;
    let failing = 0;
    const progress = (what: string) => {
      if (SOAK)
        console.log(
          `machine: ${cases} sequences, ${Math.round((Date.now() - began) / 1000)} s — ${what}`,
        );
    };
    await hegel.testAsync(
      async (tc) => {
        cases++;
        if (cases % 25 === 0) progress(`${failing} failing`);
        const errors = await open(page, pickerCoverage);
        const m = initial();
        const log: string[] = [];
        await check(page, m, errors, log);
        const steps = drawInt(tc, 1, STEPS);
        try {
          for (let i = 0; i < steps; i++) {
            const a = drawAction(tc, m);
            log.push(name(a));
            await take(page, a, log);
            step(m, a);
            await check(page, m, errors, log);
          }
        } catch (e) {
          // Running out of drawn data is Hegel ending a case early, not a failure.
          if (!(e instanceof Error && e.name === "StopTestError")) {
            failing++;
            if (failing <= 3) progress(`failing: ${String(e).split("\n")[0]}`);
          }
          throw e;
        }
      },
      { testCases: CASES },
    );
  });
});
