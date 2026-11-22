// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from "./fixtures.js";

// What's on when you're free (DESIGN §10 rc58), in a real browser: the next two weeks of what
// is followed, by day, each in its calendar's colour; what clashes left out, and shown dimmed
// by a link; a followed event's sheet with Invite people — links and a form, which work with
// JavaScript off as they do with it on (rc15).

const FROZEN = new Date("2026-10-24T10:00:00+02:00");

async function open(page: Page, name: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.clock.setFixedTime(FROZEN);
  await page.goto(new URL(`./.pages/${name}.html`, import.meta.url).href);
  await page.mouse.move(0, 0);
  return errors;
}

test("what's on when you're free, and what clashes, dimmed", async ({ page }) => {
  const errors = await open(page, "whats-on");
  await expect(page.getByRole("heading", { name: "What's on", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Thursday 29 October" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Game night" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Beginners' class" })).toBeVisible();
  // The social overlaps the DM's own Friday: left out, and said so.
  await expect(page.getByRole("link", { name: "Friday social" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Show what clashes" })).toBeVisible();
  await expect(page).toHaveScreenshot("whats-on.png", { fullPage: true });

  await open(page, "whats-on-clashes");
  const social = page.locator(".on > li.clash");
  await expect(social).toHaveCount(1);
  await expect(social).toContainText("Friday social");
  await expect(social).toContainText("You have something then");
  await expect(page).toHaveScreenshot("whats-on-clashes.png", { fullPage: true });
  expect(errors).toEqual([]);
});

test("a followed event's sheet, with Invite people", async ({ page }) => {
  const errors = await open(page, "whats-on-sheet");
  await expect(page.getByRole("heading", { name: "Friday social" })).toBeVisible();
  await expect(page.getByText("From Lindy Hop.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Invite people" })).toBeVisible();
  await expect(page).toHaveScreenshot("whats-on-sheet.png", { fullPage: true });
  expect(errors).toEqual([]);
});

test.describe("without JavaScript (DESIGN rc15: every form works without it)", () => {
  test.use({ javaScriptEnabled: false });

  test("clashes are a link, and Invite people a form", async ({ page }) => {
    await open(page, "whats-on");
    await expect(page.getByRole("link", { name: "Show what clashes" })).toHaveAttribute(
      "href",
      "/whats-on?clashes=1",
    );
    await open(page, "whats-on-sheet");
    const invite = page.locator("form", {
      has: page.getByRole("button", { name: "Invite people" }),
    });
    await expect(invite).toHaveAttribute("method", "post");
    await expect(invite.locator('input[name="csrf"]')).toHaveCount(1);
    await expect(invite.locator('input[name="e"]')).toHaveValue("social");
  });
});
