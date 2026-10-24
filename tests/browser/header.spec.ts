// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from "./fixtures.js";

// Every signed-in page names the account in use, and its menu switches, adds and signs
// out (DESIGN §13 rc18). pages.ts signs three example accounts into one browser, the DM
// last, so the menu has two accounts to switch to.

const FROZEN = new Date("2026-10-24T10:00:00+02:00");

async function open(page: Page, name: string): Promise<void> {
  await page.clock.setFixedTime(FROZEN);
  await page.goto(new URL(`./.pages/${name}.html`, import.meta.url).href);
}

/** The top of the page, with room below the header for the open menu. */
async function top(page: Page) {
  const width = page.viewportSize()?.width ?? 390;
  return { clip: { x: 0, y: 0, width, height: 420 } };
}

for (const name of ["home", "event-new", "poll-new"]) {
  test(`${name} says who is signed in`, async ({ page }) => {
    await open(page, name);
    const who = page.locator(".wd-who summary");
    await expect(who).toBeVisible();
    await expect(who).toContainText("Signed in as");
    await expect(who).toContainText("dm@example.org");
  });
}

test("the header, and its menu open", async ({ page }) => {
  await open(page, "home");
  await expect(page).toHaveScreenshot("header.png", await top(page));

  await page.locator(".wd-who summary").click();
  const menu = page.locator(".wd-menu");
  await expect(menu.getByRole("button", { name: "Switch to lea@example.org" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Switch to dm.work@example.org" })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Add another account" })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Sign out of dm@example.org" })).toBeVisible();
  await expect(
    menu.getByRole("button", { name: "Sign out of all accounts on this browser" }),
  ).toBeVisible();
  // The menu stays on screen at phone width.
  const box = await menu.boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  expect(box !== null && box.x >= 0 && box.x + box.width <= width).toBe(true);
  await expect(page).toHaveScreenshot("header-menu.png", await top(page));
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the menu still opens, and its actions are forms", async ({ page }) => {
    await open(page, "event-new");
    await page.locator(".wd-who summary").click();
    const menu = page.locator(".wd-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator('form[method="post"]')).toHaveCount(4);
  });
});

test("a page another account here can see offers the switch", async ({ page }) => {
  await open(page, "visible-elsewhere");
  await expect(page.locator(".wd-who summary")).toContainText("lea@example.org");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "This is visible to dm@example.org, also signed in here",
  );
  const main = page.locator("body > :not(header)");
  await expect(main.getByRole("button", { name: "Switch to dm@example.org" })).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page).toHaveScreenshot("visible-elsewhere.png", await top(page));
});
