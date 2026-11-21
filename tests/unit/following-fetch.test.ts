// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  AddressRefused,
  fetchFeed,
  isPublicAddress,
  literalAddress,
  MAX_BYTES,
  MAX_REDIRECTS,
  type PublicGet,
  type PublicResponse,
} from "../../src/following/fetch.js";

// The safe fetch of a followed calendar (DESIGN §10 rc56/rc57), over a fake PublicGet.

const enc = new TextEncoder();

function response(
  status: number,
  headers: Record<string, string> = {},
  chunks: Uint8Array[] = [],
): PublicResponse & { cancelled: () => boolean } {
  let cancelled = false;
  let i = 0;
  return {
    status,
    header: (name) => headers[name.toLowerCase()] ?? null,
    body: {
      getReader: () => ({
        read: async () => {
          const value = chunks[i++];
          return value === undefined ? { done: true } : { done: false, value };
        },
        cancel: async () => {
          cancelled = true;
        },
      }),
    },
    cancelled: () => cancelled,
  };
}

interface Call {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

function fake(...answers: (PublicResponse | Error)[]): { get: PublicGet; calls: Call[] } {
  const calls: Call[] = [];
  const get: PublicGet = async (url, headers) => {
    calls.push({ url, headers });
    const next = answers.shift();
    if (next === undefined) throw new Error("no more answers");
    if (next instanceof Error) throw next;
    return next;
  };
  return { get, calls };
}

const NONE = { etag: null, lastModified: null };
const URL1 = "https://club.example/cal.ics";

describe("fetchFeed", () => {
  it("returns the body with what it gave for a conditional request next time", async () => {
    const { get, calls } = fake(
      response(200, { etag: '"v1"', "last-modified": "Sat, 21 Nov 2026 10:00:00 GMT" }, [
        enc.encode("BEGIN:VCAL"),
        enc.encode("ENDAR"),
      ]),
    );
    expect(await fetchFeed(get, URL1, NONE)).toEqual({
      kind: "fetched",
      text: "BEGIN:VCALENDAR",
      etag: '"v1"',
      lastModified: "Sat, 21 Nov 2026 10:00:00 GMT",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(URL1);
    // A plain GET: no cookies, no credentials, nothing conditional when there's nothing prior.
    expect(calls[0]?.headers).toEqual({
      accept: "text/calendar, text/plain;q=0.5, */*;q=0.1",
      "user-agent": "WhenDoWe calendar follower (+https://github.com/whendowe/whendowe)",
    });
  });

  it("asks conditionally with what the last fetch gave, and a 304 is unchanged", async () => {
    const { get, calls } = fake(response(304));
    expect(await fetchFeed(get, URL1, { etag: '"v1"', lastModified: "then" })).toEqual({
      kind: "unchanged",
    });
    expect(calls[0]?.headers).toMatchObject({
      "if-none-match": '"v1"',
      "if-modified-since": "then",
    });
  });

  it(`follows up to ${MAX_REDIRECTS} redirects, each checked as a pasted link is`, async () => {
    const to = (location: string) => response(302, { location });
    const { get, calls } = fake(
      to("/moved.ics"),
      to("webcal://other.example/cal.ics"),
      to("https://third.example/cal.ics#x"),
      response(200, {}, [enc.encode("ok")]),
    );
    expect(await fetchFeed(get, URL1, NONE)).toMatchObject({ kind: "fetched", text: "ok" });
    expect(calls.map((c) => c.url)).toEqual([
      URL1,
      "https://club.example/moved.ics",
      "https://other.example/cal.ics",
      "https://third.example/cal.ics",
    ]);
  });

  it("refuses a redirect too many, one to http: or another port, and one with no location", async () => {
    const to = (location: string) => response(301, { location });
    const four = fake(to("/a"), to("/b"), to("/c"), to("/d"));
    expect(await fetchFeed(four.get, URL1, NONE)).toEqual({ kind: "refused" });
    expect(four.calls).toHaveLength(MAX_REDIRECTS + 1);
    for (const bad of [
      "http://club.example/cal.ics",
      "https://club.example:8080/x",
      "https://u:p@x.example/",
    ]) {
      expect(await fetchFeed(fake(to(bad)).get, URL1, NONE)).toEqual({ kind: "refused" });
    }
    expect(await fetchFeed(fake(response(302)).get, URL1, NONE)).toEqual({ kind: "refused" });
  });

  it("is refused when the deployment says the address isn't public", async () => {
    expect(await fetchFeed(fake(new AddressRefused()).get, URL1, NONE)).toEqual({
      kind: "refused",
    });
  });

  it(`stops past ${MAX_BYTES} bytes, and cancels the body`, async () => {
    const big = response(200, {}, [new Uint8Array(MAX_BYTES), new Uint8Array(1)]);
    expect(await fetchFeed(fake(big).get, URL1, NONE)).toEqual({ kind: "gone" });
    expect(big.cancelled()).toBe(true);
    const exact = response(200, {}, [new Uint8Array(MAX_BYTES)]);
    expect(await fetchFeed(fake(exact).get, URL1, NONE)).toMatchObject({ kind: "fetched" });
  });

  it("tells a server's no (4xx) from what may work next time (5xx, 429, a network error)", async () => {
    for (const status of [400, 403, 404, 410]) {
      expect(await fetchFeed(fake(response(status)).get, URL1, NONE)).toEqual({ kind: "gone" });
    }
    for (const status of [429, 500, 503]) {
      expect(await fetchFeed(fake(response(status)).get, URL1, NONE)).toEqual({ kind: "failed" });
    }
    expect(await fetchFeed(fake(new TypeError("network")).get, URL1, NONE)).toEqual({
      kind: "failed",
    });
    expect(await fetchFeed(fake(response(101)).get, URL1, NONE)).toEqual({ kind: "gone" });
  });
});

describe("fetchFeed — answers with no body, and odd ones", () => {
  const bare = (status: number, headers: Record<string, string> = {}): PublicResponse => ({
    status,
    header: (name) => headers[name.toLowerCase()] ?? null,
    body: null,
  });

  it("reads no body as an empty one, and skips a read that brings nothing", async () => {
    expect(await fetchFeed(fake(bare(200)).get, URL1, NONE)).toMatchObject({
      kind: "fetched",
      text: "",
    });
    let n = 0;
    const gappy: PublicResponse = {
      status: 200,
      header: () => null,
      body: {
        getReader: () => ({
          read: async () => {
            n++;
            if (n === 1) return { done: false };
            if (n === 2) return { done: false, value: enc.encode("ok") };
            return { done: true };
          },
          cancel: async () => {},
        }),
      },
    };
    expect(await fetchFeed(fake(gappy).get, URL1, NONE)).toMatchObject({
      kind: "fetched",
      text: "ok",
    });
  });

  it("a redirect, a 304 or a refusal with no body is still read as one", async () => {
    const moved = fake(bare(302, { location: "/b" }), bare(200));
    expect(await fetchFeed(moved.get, URL1, NONE)).toMatchObject({ kind: "fetched" });
    expect(await fetchFeed(fake(bare(304)).get, URL1, NONE)).toEqual({ kind: "unchanged" });
    expect(await fetchFeed(fake(bare(404)).get, URL1, NONE)).toEqual({ kind: "gone" });
  });

  it("follows a 300 with a location, and refuses a location that isn't a URL", async () => {
    const multiple = fake(response(300, { location: "/chosen.ics" }), response(200));
    expect(await fetchFeed(multiple.get, URL1, NONE)).toMatchObject({ kind: "fetched" });
    expect(multiple.calls[1]?.url).toBe("https://club.example/chosen.ics");
    expect(await fetchFeed(fake(response(302, { location: "https://[" })).get, URL1, NONE)).toEqual(
      {
        kind: "refused",
      },
    );
  });
});

describe("isPublicAddress", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.191",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.9",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::127.0.0.1",
    "64:ff9b::10.0.0.1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1%eth0",
    "fec0::1",
    "ff02::1",
    "2001:db8::1",
    "100::1",
    "2002:c0a8:0101::1",
    "not an address",
    "1.2.3",
    "1.2.3.256",
    "1::2::3",
    "1:2:3:4:5:6:7:8:9",
    "12345::1",
    "a8.8.8.8",
    "8.8.8.8a",
    "[2606:4700::1111",
    "2606:4700::1111]",
    "zz",
    "::ffff:1.2.3.999",
    "1:2:3:4::5:6:7:8",
  ])("%s is not public", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "172.15.255.255",
    "172.32.0.0",
    "100.63.255.255",
    "100.128.0.0",
    "169.253.0.1",
    "192.169.0.1",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "2a00:1450:4001::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::8.8.8.8",
    "2002:0808:0808::1",
    "1:2:3:4:5:6:7:8",
    "1:2:3:4:5:6::7",
    "2606:4700::1111%eth0",
    "::ffff:18.8.8.8",
    "::ffff:8.8.8.18",
    "2606:4700::ffff:a00:1",
    "64:ff9c::a00:1",
    "65:ff9b::a00:1",
    "64:ff9b:0:0:0:1:a00:1",
    "2001:4860:4860::8888",
    "2606:db8::1",
    "100:0:0:1::1",
    "2606::1",
    "2002:c000:0101::1",
  ])("%s is public", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("literalAddress", () => {
  it("reads an IP host as its address, and a name as none", () => {
    expect(literalAddress("10.0.0.1")).toBe("10.0.0.1");
    expect(literalAddress("[::1]")).toBe("::1");
    expect(literalAddress("club.example")).toBeNull();
    expect(literalAddress("::1")).toBeNull(); // a URL host writes IPv6 in brackets
    expect(literalAddress("[zz]")).toBeNull();
  });
});
