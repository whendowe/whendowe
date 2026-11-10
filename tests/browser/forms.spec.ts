// SPDX-License-Identifier: AGPL-3.0-or-later
import { answerBusy, asked } from "./busy.js";
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
/**
 * The form as a reference screenshot. The pointer stays wherever the last click left
 * it, and a page scrolled for the capture can slide a control under it and draw that
 * control hovered. Off the page first, so the image never depends on the pointer.
 */
async function shot(page: Page, name: string): Promise<void> {
  await page.mouse.move(0, 0);
  await expect(form(page)).toHaveScreenshot(name);
}
// Scoped to the picker: the hidden plain fields carry the same labels.
const picker = (page: Page) => page.locator(".wd-picker");

test.describe("event form", () => {
  test("a new event: one tap, a start and a length", async ({ page }) => {
    const errors = await open(page, "event-new");
    await expect(page.locator("[data-picker-plain]")).toBeHidden();
    await shot(page, "event-new.png");

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
    await shot(page, "event-several-days.png");
    expect(errors).toEqual([]);
  });

  test("an edit opens on the event's own day and length", async ({ page }) => {
    const errors = await open(page, "event-edit");
    await expect(page.locator(".wd-summary")).toContainText("Fri 30 Oct · 19:00–22:00");
    await expect(picker(page).getByLabel("Length")).toHaveValue("180");
    await shot(page, "event-edit.png");
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
    await shot(page, "poll-times-asking.png");
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
    await shot(page, "poll-days-overlap.png");
    expect(errors).toEqual([]);
  });
});

const BUSY = [
  { allDay: false, start: "2026-10-30T18:00", end: "2026-10-30T20:00" },
  { allDay: true, from: "2026-11-02", to: "2026-11-02" },
];
const busyLine = (page: Page) => page.locator(".wd-busyline");

test.describe("busy times while you pick (rc41)", () => {
  test("the event form marks busy days and says when a time clashes", async ({ page }) => {
    await answerBusy(page, { status: 200, busy: BUSY });
    const errors = await open(page, "event-new");
    const friday = day(page, "Fri 30 Oct, busy 18:00–20:00");
    await expect(friday).toHaveClass(/wd-busy/);
    await expect(day(page, "Thu 29 Oct")).not.toHaveClass(/wd-busy/);
    await expect(busyLine(page)).toBeHidden(); // today has nothing on
    // The weeks on screen, in the form's zone: October 2026 runs Mon 28 Sep to Sun 1 Nov.
    expect(await asked(page)).toEqual([
      expect.stringMatching(/^\/busy\?from=2026-09-28&to=2026-11-01&tz=[^&]+$/),
    ]);

    await friday.click(); // at the form's 19:00, for an hour
    await expect(busyLine(page)).toHaveText("You're busy then · that day: 18:00–20:00");
    await shot(page, "event-busy.png");
    await picker(page).getByLabel("Starts").fill("20:00");
    await expect(busyLine(page)).toHaveText("Busy that day: 18:00–20:00");
    expect(await value(page, "start")).toBe("2026-10-30T20:00"); // still only advice
    await picker(page).getByLabel("Length").selectOption("days"); // Fri 30 Oct to Sun 1 Nov
    await expect(busyLine(page)).toHaveText("You're busy on 1 of these days");

    await page.getByRole("button", { name: "Next month" }).click();
    await expect(day(page, "Mon 2 Nov, busy all day")).toHaveClass(/wd-busy/);
    expect((await asked(page))[1]).toMatch(/^\/busy\?from=2026-10-26&to=2026-12-06&tz=/);
    await page.getByRole("button", { name: "Previous month" }).click();
    expect(await asked(page)).toHaveLength(2); // October is asked once
    expect(errors).toEqual([]);
  });

  test("editing leaves the event itself out", async ({ page }) => {
    await answerBusy(page, { status: 200, busy: [] });
    const errors = await open(page, "event-edit");
    await expect(page.locator(".wd-summary")).toContainText("Fri 30 Oct · 19:00–22:00");
    expect(await asked(page)).toEqual([expect.stringMatching(/&except=[0-9a-f-]{36}$/)]);
    await expect(page.locator(".wd-busy")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("the poll form flags the options you're busy for", async ({ page }) => {
    await answerBusy(page, { status: 200, busy: BUSY });
    const errors = await open(page, "poll-new");
    await day(page, "Fri 30 Oct, busy 18:00–20:00").click(); // 19:00 for 3 hours
    await day(page, "Sat 31 Oct").click();
    const options = page.locator(".wd-opts li");
    await expect(options.nth(0)).toContainText("You're busy then");
    await expect(options.nth(1)).not.toContainText("busy");
    await shot(page, "poll-busy.png");

    await page.getByRole("button", { name: "A stretch of days" }).click();
    await day(page, "Thu 29 Oct").click();
    await page.getByRole("button", { name: /^Sun 1 Nov/ }).click();
    await expect(options.nth(0)).toContainText("You're busy on 1 of these days");
    expect(errors).toEqual([]);
  });

  for (const [what, status] of [
    ["a refused answer", 500],
    ["no answer at all", 0],
  ] as const) {
    test(`${what} shows nothing, and the picker works as before`, async ({ page }) => {
      await answerBusy(page, { status, busy: BUSY });
      const errors = await open(page, "event-new");
      await day(page, "Fri 30 Oct").click();
      await expect(page.locator(".wd-summary")).toContainText("Fri 30 Oct · 19:00–20:00");
      expect(await value(page, "start")).toBe("2026-10-30T19:00");
      await expect(page.locator(".wd-busy")).toHaveCount(0);
      await expect(busyLine(page)).toBeHidden();
      expect(await asked(page)).toHaveLength(1);
      expect(errors).toEqual([]);
    });
  }
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
      // The form's own button: the page header has buttons too (rc18).
      await expect(form(page).locator('button[type="submit"]')).toBeVisible();
      await shot(page, `${name}-no-js.png`);
    });
  }
});
