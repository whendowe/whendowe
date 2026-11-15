// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import type { Page } from "./fixtures.js";

/**
 * Busy times (DESIGN rc41). A fixture page is a file, where the picker's request for
 * them can only fail; these tests answer it instead, every time with `answer`, and
 * keep the URLs asked for. With `google`, the answer says what Google's part was (rc44).
 */
export async function answerBusy(
  page: Page,
  answer: { status: number; busy: unknown[]; google?: string },
): Promise<void> {
  // Plain JavaScript, run in the page: this project has no DOM types (see poll-machine.ts).
  await page.addInitScript({
    content: `(() => {
      const a = ${JSON.stringify(answer)};
      const asked = [];
      globalThis.wdAsked = asked;
      window.fetch = (input) => {
        asked.push(String(input));
        if (a.status === 0) return Promise.reject(new TypeError("offline"));
        const body = a.google === undefined ? { busy: a.busy } : { busy: a.busy, google: a.google };
        return Promise.resolve(new Response(JSON.stringify(body), {
          status: a.status,
          headers: { "content-type": "application/json" },
        }));
      };
    })();`,
  });
}
export const asked = async (page: Page) =>
  z.array(z.string()).parse(await page.evaluate("globalThis.wdAsked"));
