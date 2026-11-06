// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { expect, type Page, test } from "./fixtures.js";

// The calendar feed on the account page (DESIGN §10 rc34), in a real browser: the link,
// Copy where the browser can, never the share sheet (a feed link is a secret), the two
// ways into a calendar app, and the line saying how slowly Google reads a feed.

const FROZEN = new Date("2026-10-24T10:00:00+02:00");

async function open(page: Page, name: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.clock.setFixedTime(FROZEN);
  await page.goto(new URL(`./.pages/${name}.html`, import.meta.url).href);
  await page.mouse.move(0, 0);
  return errors;
}

test("your calendar feed: the link to copy, the ways in, and how slowly Google reads it", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors = await open(page, "account-feed");
  const box = page.getByRole("textbox", { name: "Feed link" });
  await expect(box).toHaveValue(/^https:\/\/whendowe\.example\/feed\/[A-Za-z0-9_-]{43}\.ics$/);
  await expect(page.getByRole("button", { name: "Share…" })).toHaveCount(0);
  const webcal = (await box.inputValue()).replace(/^https:/, "webcal:");
  await expect(page.getByRole("link", { name: "Open in your calendar app" })).toHaveAttribute(
    "href",
    webcal,
  );
  await expect(page.getByRole("link", { name: "Add to Google Calendar" })).toHaveAttribute(
    "href",
    `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`,
  );
  await expect(page.getByText("Google Calendar checks a feed every few hours")).toBeVisible();
  // The link is new on every render; mask it, not the section.
  await page.locator("#feed").scrollIntoViewIfNeeded();
  await expect(page).toHaveScreenshot("account-feed.png", { mask: [box] });
  const copy = page.locator("[data-copy]");
  await copy.click();
  await expect(copy).toHaveText("Copied");
  const copied = z.string().parse(await page.evaluate("navigator.clipboard.readText()"));
  expect(copied).toBe(await box.inputValue());
  expect(errors).toEqual([]);
});
