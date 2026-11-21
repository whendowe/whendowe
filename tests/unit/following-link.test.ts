// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { followableLink, MAX_LINK_LENGTH } from "../../src/following/link.js";

// What can be followed (DESIGN §10 rc56): a pasted link -> the https: address to fetch.

const ID = "369opln61binpjem9t1nchbd68@group.calendar.google.com";
const ICAL = `https://calendar.google.com/calendar/ical/${encodeURIComponent(ID)}/public/basic.ics`;

describe("followableLink", () => {
  it("turns a Google embed link into its public iCal address", () => {
    expect(
      followableLink(
        `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(ID)}&ctz=Europe/Prague`,
      ),
    ).toEqual({ ok: true, url: ICAL });
  });

  it("turns a share link's cid into it, as the id or in base64", () => {
    const b64 = btoa(ID).replaceAll("=", "");
    expect(followableLink(`https://calendar.google.com/calendar/u/0?cid=${b64}`)).toEqual({
      ok: true,
      url: ICAL,
    });
    expect(
      followableLink(`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(ID)}`),
    ).toEqual({
      ok: true,
      url: ICAL,
    });
  });

  it("leaves a Google iCal address, and a Google link naming no calendar, as they are", () => {
    expect(followableLink(ICAL)).toEqual({ ok: true, url: ICAL });
    expect(followableLink("https://calendar.google.com/calendar/u/0?cid=!!")).toEqual({
      ok: true,
      url: "https://calendar.google.com/calendar/u/0?cid=!!",
    });
    expect(
      followableLink(`https://calendar.google.com/calendar/u/0?cid=${btoa("no-at-sign")}`),
    ).toMatchObject({ ok: true, url: expect.stringContaining("cid=") });
  });

  it("reads webcal: as https:, trims, keeps the query and drops the fragment", () => {
    expect(followableLink("  webcal://club.example/cal.ics?key=1#top ")).toEqual({
      ok: true,
      url: "https://club.example/cal.ics?key=1",
    });
    expect(followableLink("WEBCALS://club.example/cal.ics")).toEqual({
      ok: true,
      url: "https://club.example/cal.ics",
    });
  });

  it("refuses what isn't an https: link, credentials, another port, and the over-long", () => {
    expect(followableLink("")).toEqual({ ok: false, reason: "not-a-link" });
    expect(followableLink("swing school")).toEqual({ ok: false, reason: "not-a-link" });
    expect(followableLink(`https://a.example/${"x".repeat(MAX_LINK_LENGTH)}`)).toEqual({
      ok: false,
      reason: "not-a-link",
    });
    expect(followableLink("http://club.example/cal.ics")).toEqual({
      ok: false,
      reason: "not-https",
    });
    expect(followableLink("javascript:alert(1)")).toEqual({ ok: false, reason: "not-https" });
    expect(followableLink("https://me:pw@club.example/cal.ics")).toEqual({
      ok: false,
      reason: "credentials",
    });
    expect(followableLink("https://club.example:8443/cal.ics")).toEqual({
      ok: false,
      reason: "port",
    });
    expect(followableLink("https://club.example:443/cal.ics")).toEqual({
      ok: true,
      url: "https://club.example/cal.ics",
    });
  });
});
