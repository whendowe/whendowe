// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, type Page, test } from "./fixtures.js";

// The forms' own scripts, in a real browser (DESIGN §9 rc16). Every test drives a page
// rendered by the app (tests/browser/pages.ts) and asserts the only output the picker
// has — the plain fields the server parses — plus a screenshot of the form, compared
// against the committed reference for this project (width × theme).

const FROZEN = new Date("2026-10-24T10:00:00+02:00"); // a Saturday; the pages' "now" too

async function open(page: Page, name: string): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.clock.setFixedTime(FROZEN);
  await page.goto(new URL(`./.pages/${name}.html`, import.meta.url).href);
  return errors;
}

const value = (page: Page, name: string) => page.locator(`[name="${name}"]`).inputValue();
const checked = (page: Page, name: string) => page.locator(`[name="${name}"]`).isChecked();
const day = (page: Page, label: string) => page.getByRole("button", { name: label, exact: true });
const form = (page: Page) => page.locator("form[data-picker]");
// Scoped to the picker: the hidden plain fields carry the same labels.
const picker = (page: Page) => page.locator(".wd-picker");

test.describe("event form", () => {
  test("a new event: one tap, a start and a length", async ({ page }) => {
    const errors = await open(page, "event-new");
    await expect(page.locator("[data-picker-plain]")).toBeHidden();
    await expect(form(page)).toHaveScreenshot("event-new.png");

    await day(page, "Fri 30 Oct").click();
    await picker(page).getByLabel("Starts").fill("23:15");
    await picker(page).getByLabel("Length").selectOption("90");
    await expect(page.locator(".wd-summary")).toContainText(
      "Fri 30 Oct · 23:15–00:45 (ends Sat 31 Oct)",
    );
    expect(await checked(page, "allDay")).toBe(false);
    expect(await value(page, "start")).toBe("2026-10-30T23:15");
    expect(await value(page, "end")).toBe("2026-10-31T00:45");
    expect(errors).toEqual([]);
  });

  test("several days across the month boundary", async ({ page }) => {
    const errors = await open(page, "event-new");
    await picker(page).getByLabel("Length").selectOption("days");
    await day(page, "Sat 31 Oct").click();
    await page.getByRole("button", { name: "Next month" }).click();
    await day(page, "Mon 2 Nov").click();
    await expect(page.locator(".wd-summary")).toContainText("Sat 31 Oct – Mon 2 Nov");
    expect(await checked(page, "allDay")).toBe(true);
    expect(await value(page, "start")).toBe("2026-10-31T00:00");
    expect(await value(page, "end")).toBe("2026-11-02T00:00");
    await expect(form(page)).toHaveScreenshot("event-several-days.png");
    expect(errors).toEqual([]);
  });

  test("an edit opens on the event's own day and length", async ({ page }) => {
    const errors = await open(page, "event-edit");
    await expect(page.locator(".wd-summary")).toContainText("Fri 30 Oct · 19:00–22:00");
    await expect(picker(page).getByLabel("Length")).toHaveValue("180");
    await expect(form(page)).toHaveScreenshot("event-edit.png");
    expect(errors).toEqual([]);
  });
});

test.describe("poll form", () => {
  test("times: two on one Friday, and asking which to remove", async ({ page }) => {
    const errors = await open(page, "poll-new");
    await picker(page).getByLabel("Starts").fill("18:00");
    await picker(page).getByLabel("Starts").dispatchEvent("change");
    await day(page, "Fri 30 Oct").click();
    await day(page, "Sat 31 Oct").click();
    await page.getByRole("button", { name: "another time this day" }).first().click();
    expect(await value(page, "start_0")).toBe("2026-10-30T18:00");
    expect(await value(page, "start_1")).toBe("2026-10-30T21:00");
    expect(await value(page, "start_2")).toBe("2026-10-31T18:00");
    expect(await value(page, "start_3")).toBe("");
    expect(await checked(page, "allDay")).toBe(false);

    await day(page, "Fri 30 Oct").click(); // two times: ask, don't remove
    await expect(page.locator(".wd-chooser")).toContainText("Fri 30 Oct has 2 times");
    await expect(form(page)).toHaveScreenshot("poll-times-asking.png");
    await page.getByRole("button", { name: "B · 21:00–00:00" }).click();
    expect(await value(page, "start_1")).toBe("2026-10-31T18:00");
    expect(await value(page, "start_2")).toBe("");
    expect(errors).toEqual([]);
  });

  test("days: the dance camp's three overlapping stretches", async ({ page }) => {
    const errors = await open(page, "poll-new");
    await page.getByRole("button", { name: "A stretch of days" }).click();
    await page.getByRole("button", { name: "Next month" }).click();
    for (const [a, b] of [
      ["Sat 7 Nov", "Wed 11 Nov"],
      ["Wed 11 Nov", "Sun 15 Nov"],
      ["Sat 7 Nov", "Sun 15 Nov"],
    ] as const) {
      await page.getByRole("button", { name: a }).first().click();
      await page
        .getByRole("button", { name: new RegExp(`^${b}`) })
        .first()
        .click();
    }
    expect(await checked(page, "allDay")).toBe(true);
    expect([await value(page, "start_0"), await value(page, "end_0")]).toEqual([
      "2026-11-07T00:00",
      "2026-11-11T00:00",
    ]);
    expect([await value(page, "start_1"), await value(page, "end_1")]).toEqual([
      "2026-11-07T00:00",
      "2026-11-15T00:00",
    ]);
    expect([await value(page, "start_2"), await value(page, "end_2")]).toEqual([
      "2026-11-11T00:00",
      "2026-11-15T00:00",
    ]);
    // Wednesday 11 Nov carries all three options' bars.
    await expect(
      page.getByRole("button", { name: "Wed 11 Nov, in option A and B and C" }),
    ).toBeVisible();
    await expect(form(page)).toHaveScreenshot("poll-days-overlap.png");
    expect(errors).toEqual([]);
  });
});

test.describe("without JavaScript (DESIGN rc15: every form works without it)", () => {
  test.use({ javaScriptEnabled: false });

  for (const name of ["event-new", "poll-new"]) {
    test(`${name}: the plain fields are there, complete`, async ({ page }) => {
      await page.goto(new URL(`./.pages/${name}.html`, import.meta.url).href);
      await expect(page.locator("[data-picker-plain]")).toBeVisible();
      await expect(page.locator(".wd-picker")).toHaveCount(0);
      await expect(page.locator('[name="allDay"]')).toBeVisible();
      const firstStart = name === "event-new" ? "start" : "start_0";
      await expect(page.locator(`[name="${firstStart}"]`)).toBeVisible();
      await expect(page.locator('button[type="submit"]')).toBeVisible();
      await expect(form(page)).toHaveScreenshot(`${name}-no-js.png`);
    });
  }
});
