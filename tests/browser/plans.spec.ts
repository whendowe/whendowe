// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from "./fixtures.js";

// The plan pages (DESIGN §10 rc19) in a real browser. pages.ts renders a game table of
// three where Lea's plan answers the DM's, and a pair drawing week-long stretches.
// Screenshots are of the viewport: the header and the sheet are sticky, so what a phone
// shows at the top of the page is what is compared.

const FROZEN = new Date("2026-10-24T10:00:00+02:00");

async function open(page: Page, name: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.clock.setFixedTime(FROZEN);
  await page.goto(new URL(`./.pages/${name}.html`, import.meta.url).href);
  await page.mouse.move(0, 0);
  return errors;
}

test("a plan that answers another says what it changes, in words", async ({ page }) => {
  const errors = await open(page, "plan-answer");
  const head = page.locator(".head");
  await expect(head).toContainText("answers A");
  await expect(head).toContainText("on the table");
  await head.getByText("2 changes from A").click();
  await expect(head.locator(".wl li")).toHaveText([
    "Session 16 moved Thu 19 Nov → Thu 26 Nov",
    "New: Session 18, Sat 12 Dec, 15:00–21:00",
  ]);
  // The week it left keeps a ghost of it; the week it went to marks it moved.
  await expect(page.locator("#w-2026-11-16 .rib.ghost")).toContainText("Session 16");
  await expect(page.locator("#w-2026-11-23 .rib.plan .badge")).toHaveText("moved");
  await expect(page.locator("#w-2026-11-02 .st")).toHaveText("same as A");
  // The organizer of a group of three accepts; the vote is three buttons.
  await expect(page.getByRole("group", { name: "Your vote" }).getByRole("button")).toHaveText([
    "Yes",
    "If need be",
    "No",
  ]);
  await expect(page.getByRole("link", { name: "Accept…" })).toBeVisible();
  await head.getByText("2 changes from A").click();
  await expect(page).toHaveScreenshot("plan-answer.png");
  expect(errors).toEqual([]);
});

test("a stretch across a week boundary is one event, and its ends carry grips", async ({
  page,
}) => {
  const errors = await open(page, "plan-draft");
  const scout = page.locator(".rib", { hasText: "Scout trip" });
  await expect(scout).toHaveCount(2);
  await expect(scout.nth(0)).toContainText("Scout trip: dm on standby ›");
  await expect(scout.nth(1)).toContainText("‹ Scout trip: dm on standby");

  await open(page, "plan-draft-editing");
  const sel = page.locator(".rib.sel");
  await expect(sel).toHaveCount(1);
  await expect(sel.locator(".grip")).toHaveCount(2);
  // Each grip sits over its day: Monday's left edge, Sunday's right edge.
  const box = async (sel: string) =>
    (await page.locator(sel).boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
  const mon = await box('#w-2026-11-09 .dh[data-k="2026-11-09"]');
  const sun = await box('#w-2026-11-09 .dh[data-k="2026-11-15"]');
  const s = await box(".rib.sel .grip.s");
  const e = await box(".rib.sel .grip.e");
  expect(Math.abs(s.x - mon.x)).toBeLessThan(6);
  expect(Math.abs(e.x + e.width - (sun.x + sun.width))).toBeLessThan(6);
  await expect(page.getByLabel("What is it")).toHaveValue("With lea");
  await expect(page.locator('[name="from"]')).toHaveValue("2026-11-09");
  await expect(page.locator('[name="to"]')).toHaveValue("2026-11-15");
  await expect(page).toHaveScreenshot("plan-draft-editing.png");
  expect(errors).toEqual([]);
});

test("the thread: what waits for you, the plans, and their history", async ({ page }) => {
  const errors = await open(page, "plan-thread");
  await expect(page.getByRole("heading", { name: "Waiting for your vote" })).toBeVisible();
  await expect(page.locator(".msg")).toHaveCount(2);
  // Both were sent at the pages' one fixed moment, so their order is a tie: check each.
  await expect(
    page.locator(".list li", { hasText: "lea put “lea's changes to A” on the table" }),
  ).toHaveCount(1);
  await expect(
    page.locator(".list li", { hasText: "dm put “Every other Thursday” on the table" }),
  ).toHaveCount(1);
  await expect(page).toHaveScreenshot("plan-thread.png");
  expect(errors).toEqual([]);
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the editor shows only the fields for its kind, and every action is a form", async ({
    page,
  }) => {
    await open(page, "plan-draft-editing");
    await expect(page.locator(".ed .stretch").first()).toBeVisible();
    await expect(page.locator(".ed .timed")).toBeHidden();
    await page.getByLabel("A time on a day").check();
    await expect(page.locator(".ed .timed")).toBeVisible();
    await expect(page.locator(".ed .stretch").first()).toBeHidden();
    await expect(page.locator('form[method="post"] button[name="shift"]')).toHaveCount(4);
    // Days and ribbons are links: tapping one is a GET of the same page.
    await expect(page.locator('.dh[href*="day=2026-11-11"]')).toHaveCount(1);
  });
});
