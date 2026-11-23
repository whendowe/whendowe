// SPDX-License-Identifier: AGPL-3.0-or-later
import { writeFileSync } from "node:fs";
import { test as base, type Page } from "@playwright/test";
import type { z } from "zod";
import { RAW_NAME, type runSchema, SCRIPTS } from "./coverage.js";

// Every browser test imports `test` from here. It records which parts of the pages' scripts
// ran — the picker's and, rc47, the Ask page's drag — (Chromium's JS coverage) and leaves
// the record in the test's output directory, for coverage.ts to merge after the run
// (DESIGN §9 rc17).
//
// V8 drops a script's counts when its page navigates away, so a test that opens the
// page more than once (the state machine) calls `pickerCoverage.flush()` before each
// navigation; everything recorded so far is kept, and recording starts afresh.

type Run = z.infer<typeof runSchema>;

/**
 * Hides the whole page for two frames and shows it again, then waits two more: everything is
 * drawn afresh, at once. A page can be painted before it has all been read — more often with
 * coverage slowing its scripts — and what is drawn later is drawn over what was there, so an
 * edge at a fraction of a pixel comes out a shade different from one load to the next. The
 * screenshots compare to zero pixels (playwright.config.ts), so each page is shown as it is
 * when drawn whole, whatever order it arrived in. It changes nothing on the page.
 */
const REDRAW = `new Promise((done) => {
  const frame = (f) => requestAnimationFrame(() => requestAnimationFrame(f));
  document.documentElement.style.visibility = "hidden";
  frame(() => {
    document.documentElement.style.visibility = "";
    frame(() => done(0));
  });
})`;

async function collect(page: Page, into: Run[]): Promise<void> {
  for (const e of await page.coverage.stopJSCoverage()) {
    const script = SCRIPTS.find((s) => e.source?.includes(s.marker) === true);
    if (script !== undefined && e.source !== undefined) {
      into.push({ script: script.name, source: e.source, functions: e.functions });
    }
  }
}

export const test = base.extend<{ pickerCoverage: { flush: () => Promise<void> } }>({
  // Every navigation by URL ends with the page drawn whole (REDRAW). Not without JavaScript:
  // no frame callback runs there, and with no script nothing is drawn over the first paint.
  page: async ({ page, javaScriptEnabled }, use) => {
    if (!javaScriptEnabled) {
      await use(page);
      return;
    }
    const goto = page.goto.bind(page);
    page.goto = async (url, options) => {
      const response = await goto(url, options);
      await page.evaluate(REDRAW);
      return response;
    };
    await use(page);
  },
  pickerCoverage: [
    async ({ page, javaScriptEnabled }, use, testInfo) => {
      // With scripts off there is nothing to record, and Chromium refuses to try.
      if (!javaScriptEnabled) {
        await use({ flush: () => Promise.resolve() });
        return;
      }
      const runs: Run[] = [];
      await page.coverage.startJSCoverage();
      await use({
        flush: async () => {
          await collect(page, runs);
          await page.coverage.startJSCoverage();
        },
      });
      await collect(page, runs);
      if (runs.length > 0) writeFileSync(testInfo.outputPath(RAW_NAME), JSON.stringify(runs));
    },
    { auto: true },
  ],
});

export { expect, type Page } from "@playwright/test";
