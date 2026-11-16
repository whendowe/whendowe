// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from "./fixtures.js";

// Ask when as a plain page (DESIGN §10 *Asking when*, rc46, A2) in a real browser: pages.ts
// leaves a question being written — A is a Thursday evening and a weekend, B another evening.

const FROZEN = new Date("2026-10-24T10:00:00+02:00");

async function open(page: Page, name: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.clock.setFixedTime(FROZEN);
  await page.goto(new URL(`./.pages/${name}.html`, import.meta.url).href);
  await page.mouse.move(0, 0);
  return errors;
}

test("a question being written: lettered options, or between, and inside, and what asking does", async ({
  page,
}) => {
  const errors = await open(page, "ask");
  await expect(page.getByText("Draft · step 1 of 4 · nobody has been told")).toBeVisible();
  await expect(page.locator(".option legend")).toHaveText(["A", "B"]);
  await expect(page.locator(".or")).toHaveText(["or"]);
  await expect(page.locator(".and")).toHaveText(["and"]);
  await expect(page.locator(".readback")).toHaveText(
    "Asking emails 2 people one question: does A or B suit for “Session 17”? One of them will happen.",
  );
  await expect(page.getByRole("button", { name: "Ask 2 people by email" })).toBeVisible();
  // The Days view: November 2026 in whole weeks; A's days carry its letter, B's too.
  await expect(page.locator(".days .nav strong")).toHaveText("November 2026");
  await expect(page.locator('.days a.letter[href="#o0"]')).toHaveCount(3); // the 5th, 7th, 8th
  await expect(page.locator('.days a.letter[href="#o1"]')).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Add 2026-11-20" })).toBeVisible();
  await expect(page).toHaveScreenshot("ask.png", { fullPage: true });
  expect(errors).toEqual([]);
});
