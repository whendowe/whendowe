// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import {
  AddressRefused,
  isPublicAddress,
  literalAddress,
  type PublicGet,
} from "../../src/following/fetch.js";

// The Worker's PublicGet (DESIGN §10 rc57): a Worker has no resolver, so a followed link's
// host is asked of DNS over HTTPS, and refused unless every address it has (A and AAAA) is
// public — the same ranges as Node, isPublicAddress. An IP written in the URL is checked as
// it is. Redirects are never followed here (`redirect: "manual"`): fetchFeed checks each.

const DOH = "https://cloudflare-dns.com/dns-query";

const dohAnswer = z.object({
  Status: z.number(),
  Answer: z.array(z.object({ type: z.number(), data: z.string() })).optional(),
});

/** The fetch this needs, structurally: the Worker's own, or a test's. */
export type WorkerFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly redirect: "manual";
    readonly signal: AbortSignal;
  },
) => Promise<Response>;

const RECORD = { A: 1, AAAA: 28 } as const;

async function addresses(
  fetchImpl: WorkerFetch,
  name: string,
  type: keyof typeof RECORD,
  signal: AbortSignal,
): Promise<string[]> {
  const res = await fetchImpl(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, {
    method: "GET",
    headers: { accept: "application/dns-json" },
    redirect: "manual",
    signal,
  });
  if (!res.ok) throw new Error("DNS over HTTPS failed");
  const answer = dohAnswer.parse(await res.json());
  // A CNAME is followed by the resolver; only the addresses it ends at are records of this type.
  return (answer.Answer ?? []).filter((a) => a.type === RECORD[type]).map((a) => a.data);
}

export function workerPublicGet(fetchImpl: WorkerFetch): PublicGet {
  return async (url, headers, signal) => {
    const host = new URL(url).hostname;
    const literal = literalAddress(host);
    if (literal !== null) {
      if (!isPublicAddress(literal)) throw new AddressRefused();
    } else {
      const found = [
        ...(await addresses(fetchImpl, host, "A", signal)),
        ...(await addresses(fetchImpl, host, "AAAA", signal)),
      ];
      // A name with no address can't be fetched anyway; one with any private address isn't.
      if (found.length === 0) throw new Error("no address");
      if (!found.every(isPublicAddress)) throw new AddressRefused();
    }
    const res = await fetchImpl(url, { method: "GET", headers, redirect: "manual", signal });
    return { status: res.status, header: (name) => res.headers.get(name), body: res.body };
  };
}
