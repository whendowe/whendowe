// SPDX-License-Identifier: AGPL-3.0-or-later
import { writeFileSync } from "node:fs";
import { test as base, type Page } from "@playwright/test";
import type { z } from "zod";
import { RAW_NAME, type runSchema } from "./coverage.js";

// Every browser test imports `test` from here. It records which parts of the picker's
// script ran (Chromium's JS coverage) and leaves the record in the test's output
// directory, for coverage.ts to merge after the run (DESIGN §9 rc17).
//
// V8 drops a script's counts when its page navigates away, so a test that opens the
// page more than once (the state machine) calls `pickerCoverage.flush()` before each
// navigation; everything recorded so far is kept, and recording starts afresh.

type Run = z.infer<typeof runSchema>;

async function collect(page: Page, into: Run[]): Promise<void> {
  for (const e of await page.coverage.stopJSCoverage()) {
    if (e.source?.includes("globalThis.WhenDoWePicker") === true) {
      into.push({ source: e.source, functions: e.functions });
    }
  }
}

export const test = base.extend<{ pickerCoverage: { flush: () => Promise<void> } }>({
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
