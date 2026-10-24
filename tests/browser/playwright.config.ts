// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig, devices } from "@playwright/test";

// The browser tier (DESIGN §9 rc16). Runs only inside the pinned Playwright image
// (scripts/browser.sh locally, the `browser` job in CI): reference screenshots are
// only comparable when fonts and anti-aliasing come from the same image.
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: false };
const desktop = { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 };

export default defineConfig({
  testDir: ".",
  outputDir: "./test-results",
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
  forbidOnly: true,
  reporter: [["list"]],
  // Exact: the pinned image renders identically run to run, and the default per-pixel
  // tolerance (0.2) let a changed option colour through unnoticed.
  expect: {
    toHaveScreenshot: { animations: "disabled", caret: "hide", threshold: 0, maxDiffPixels: 0 },
  },
  use: {
    ...devices["Desktop Chrome"],
    locale: "en-GB",
    timezoneId: "Europe/Prague",
  },
  projects: [
    { name: "phone-light", use: { ...phone, colorScheme: "light" } },
    { name: "phone-dark", use: { ...phone, colorScheme: "dark" } },
    { name: "desktop-light", use: { ...desktop, colorScheme: "light" } },
    { name: "desktop-dark", use: { ...desktop, colorScheme: "dark" } },
  ],
});
