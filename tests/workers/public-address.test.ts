// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { type WorkerFetch, workerPublicGet } from "../../deploy/cloudflare/public-address.js";
import { AddressRefused, fetchFeed } from "../../src/following/fetch.js";

// The Worker's address check (DESIGN §10 rc57) in workerd: DNS over HTTPS, every A and AAAA
// record public, redirects left to fetchFeed. A fake fetch stands in for both DNS and the
// calendar, so nothing here leaves the test.

type Records = Record<string, { A?: string[]; AAAA?: string[]; cname?: string }>;

function fakeFetch(records: Records, calendar: () => Response) {
  const asked: string[] = [];
  const fetchImpl: WorkerFetch = async (url, init) => {
    asked.push(url);
    const u = new URL(url);
    if (u.hostname === "cloudflare-dns.com") {
      expect(init.headers.accept).toBe("application/dns-json");
      const name = u.searchParams.get("name") ?? "";
      const type = u.searchParams.get("type") === "AAAA" ? "AAAA" : "A";
      const r = records[name];
      const answer = [
        ...(r?.cname === undefined ? [] : [{ type: 5, data: r.cname }]),
        ...(r?.[type] ?? []).map((data) => ({ type: type === "A" ? 1 : 28, data })),
      ];
      return Response.json({ Status: r === undefined ? 3 : 0, Answer: answer });
    }
    expect(init.redirect).toBe("manual");
    return calendar();
  };
  return { fetchImpl, asked };
}

const signal = () => AbortSignal.timeout(5000);

it("fetches a name whose every address is public, asking for both kinds of record", async () => {
  const { fetchImpl, asked } = fakeFetch(
    {
      "club.example": { A: ["93.184.216.34"], AAAA: ["2606:2800:220:1::1"], cname: "cdn.example" },
    },
    () => new Response("BEGIN:VCALENDAR", { headers: { etag: '"v1"' } }),
  );
  const out = await fetchFeed(workerPublicGet(fetchImpl), "https://club.example/cal.ics", {
    etag: null,
    lastModified: null,
  });
  expect(out).toEqual({
    kind: "fetched",
    text: "BEGIN:VCALENDAR",
    etag: '"v1"',
    lastModified: null,
  });
  expect(asked).toEqual([
    "https://cloudflare-dns.com/dns-query?name=club.example&type=A",
    "https://cloudflare-dns.com/dns-query?name=club.example&type=AAAA",
    "https://club.example/cal.ics",
  ]);
});

it("refuses a name with any private address, and an IP written in the URL, without fetching it", async () => {
  const { fetchImpl, asked } = fakeFetch(
    {
      "rebind.example": { A: ["93.184.216.34"], AAAA: ["fd00::1"] },
      "meta.example": { A: ["169.254.169.254"] },
    },
    () => new Response("should not be fetched"),
  );
  const get = workerPublicGet(fetchImpl);
  for (const url of [
    "https://rebind.example/",
    "https://meta.example/",
    "https://10.0.0.1/",
    "https://[::1]/",
  ]) {
    await expect(get(url, {}, signal())).rejects.toBeInstanceOf(AddressRefused);
  }
  expect(asked.every((u) => u.startsWith("https://cloudflare-dns.com/"))).toBe(true);
});

it("a name with no address fails, as something that may work later — not refused", async () => {
  const { fetchImpl } = fakeFetch({}, () => new Response(""));
  const get = workerPublicGet(fetchImpl);
  await expect(get("https://nowhere.example/", {}, signal())).rejects.not.toBeInstanceOf(
    AddressRefused,
  );
  expect(
    await fetchFeed(get, "https://nowhere.example/", { etag: null, lastModified: null }),
  ).toEqual({ kind: "failed" });
});

it("hands a redirect back unfollowed, for fetchFeed to check", async () => {
  const { fetchImpl } = fakeFetch(
    { "club.example": { A: ["93.184.216.34"] } },
    () => new Response(null, { status: 302, headers: { location: "https://10.0.0.1/" } }),
  );
  const res = await workerPublicGet(fetchImpl)("https://club.example/", {}, signal());
  expect(res.status).toBe(302);
  expect(res.header("location")).toBe("https://10.0.0.1/");
});
