// SPDX-License-Identifier: AGPL-3.0-or-later
import { followableLink } from "./link.js";

// Fetching a link someone typed (DESIGN §10 rc56/rc57) is the risk: server-side request
// forgery. So: https: only, at most MAX_REDIRECTS redirects each checked as the link was, at
// most MAX_BYTES within TIMEOUT_MS for the whole of it, and a plain GET with no cookies or
// credentials. Whether a host is a public address is the deployment's to answer, through the
// PublicGet port (rc57): Node checks inside the lookup its connection uses, a Worker asks DNS
// over HTTPS. Both refuse the same ranges, isPublicAddress below.

export const MAX_BYTES = 2 * 1024 * 1024;
export const TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;

/** The response surface a deployment gives: structural, so neither runtime's types leak in. */
export interface PublicResponse {
  readonly status: number;
  header(name: string): string | null;
  readonly body: {
    getReader(): {
      read(): Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
      cancel(): Promise<void>;
    };
  } | null;
}

/** Thrown by a PublicGet for a host that isn't a public address. */
export class AddressRefused extends Error {}

/**
 * The deployment's GET: to a host that is a public address only (else AddressRefused), never
 * following a redirect, sending only `headers`, and stopping when `signal` aborts.
 */
export type PublicGet = (
  url: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
) => Promise<PublicResponse>;

export interface Prior {
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export type FetchOutcome =
  | { readonly kind: "unchanged" } // 304: what is kept stands
  | {
      readonly kind: "fetched";
      readonly text: string;
      readonly etag: string | null;
      readonly lastModified: string | null;
    }
  | { readonly kind: "refused" } // a private address, or a redirect to what can't be followed
  | { readonly kind: "gone" } // the server says no: 4xx, or too large
  | { readonly kind: "failed" }; // it may work next time: network, timeout, 5xx

const USER_AGENT = "WhenDoWe calendar follower (+https://github.com/whendowe/whendowe)";

/** Read a body to its end, or null once it passes MAX_BYTES. */
async function readCapped(body: PublicResponse["body"]): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return all;
}

/** GET a followed calendar's address, conditionally on what it last gave. */
export async function fetchFeed(get: PublicGet, url: string, prior: Prior): Promise<FetchOutcome> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const headers: Record<string, string> = {
    accept: "text/calendar, text/plain;q=0.5, */*;q=0.1",
    "user-agent": USER_AGENT,
  };
  if (prior.etag !== null) headers["if-none-match"] = prior.etag;
  if (prior.lastModified !== null) headers["if-modified-since"] = prior.lastModified;

  let at = url;
  try {
    for (let hops = 0; ; hops++) {
      const res = await get(at, headers, signal);
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const location = res.header("location");
        await res.body?.getReader().cancel();
        if (location === null || hops >= MAX_REDIRECTS) return { kind: "refused" };
        // Each redirect is checked as the pasted link was: https:, no credentials, no port.
        let next: URL;
        try {
          next = new URL(location, at);
        } catch {
          return { kind: "refused" };
        }
        const link = followableLink(next.toString());
        if (!link.ok) return { kind: "refused" };
        at = link.url;
        continue;
      }
      if (res.status === 304) {
        await res.body?.getReader().cancel();
        return { kind: "unchanged" };
      }
      if (res.status < 200 || res.status >= 300) {
        await res.body?.getReader().cancel();
        return res.status >= 500 || res.status === 429 ? { kind: "failed" } : { kind: "gone" };
      }
      const bytes = await readCapped(res.body);
      if (bytes === null) return { kind: "gone" };
      return {
        kind: "fetched",
        text: new TextDecoder().decode(bytes),
        etag: res.header("etag"),
        lastModified: res.header("last-modified"),
      };
    }
  } catch (e) {
    if (e instanceof AddressRefused) return { kind: "refused" };
    return { kind: "failed" };
  }
}

// ---------------------------------------------------------------------------
// Which addresses are public
// ---------------------------------------------------------------------------

/** An IPv4 address as a 32-bit number, or null if it isn't one in dotted-quad form. */
function ipv4(text: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (m === null) return null;
  let n = 0;
  for (const part of m.slice(1)) {
    const octet = Number(part);
    if (octet > 255) return null;
    n = n * 256 + octet;
  }
  return n;
}

/** IPv4 ranges that aren't the public internet (RFC 6890 and friends): [base, prefix]. */
const V4_NOT_PUBLIC: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
];

function v4IsPublic(n: number): boolean {
  return V4_NOT_PUBLIC.every(([base, prefix]) => {
    const b = ipv4(base) ?? 0;
    const size = 2 ** (32 - prefix);
    return Math.floor(n / size) !== Math.floor(b / size);
  });
}

/** An IPv6 address as eight 16-bit groups, or null; an embedded IPv4 tail is read too. */
function ipv6(text: string): number[] | null {
  let t = text.toLowerCase();
  if (t.startsWith("[") && t.endsWith("]")) t = t.slice(1, -1);
  const zone = t.indexOf("%");
  if (zone >= 0) t = t.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(t) || !t.includes(":")) return null;
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(t);
  if (tail?.[1] !== undefined) {
    const v4 = ipv4(tail[1]);
    if (v4 === null) return null;
    t = `${t.slice(0, -tail[1].length)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = t.split("::");
  if (halves.length > 2) return null;
  const groups = (s: string) => (s === "" ? [] : s.split(":"));
  const head = groups(halves[0] ?? "");
  const rest = halves.length === 2 ? groups(halves[1] ?? "") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => Number.parseInt(g, 16));
}

function v6IsPublic(g: readonly number[]): boolean {
  const [a = 0, b = 0, , , , f = 0, x = 0, y = 0] = g;
  const v4 = x * 65536 + y;
  const zeroTo = (n: number) => g.slice(0, n).every((v) => v === 0);
  if (zeroTo(8)) return false; // ::
  if (zeroTo(7) && y === 1) return false; // ::1
  if (zeroTo(5) && f === 0xffff) return v4IsPublic(v4); // ::ffff:a.b.c.d
  if (zeroTo(6)) return v4IsPublic(v4); // ::a.b.c.d (deprecated, read as IPv4)
  if (a === 0x64 && b === 0xff9b && g.slice(2, 6).every((v) => v === 0)) return v4IsPublic(v4); // NAT64
  if ((a & 0xfe00) === 0xfc00) return false; // unique local
  if ((a & 0xffc0) === 0xfe80) return false; // link-local
  if ((a & 0xffc0) === 0xfec0) return false; // site-local (deprecated)
  if ((a & 0xff00) === 0xff00) return false; // multicast
  if (a === 0x2001 && b === 0x0db8) return false; // documentation
  if (a === 0x0100 && g.slice(1, 4).every((v) => v === 0)) return false; // discard-only, 100::/64
  if (a === 0x2002) return v4IsPublic(b * 65536 + (g[2] ?? 0)); // 6to4 carries an IPv4 address
  return true;
}

/** Whether an address (IPv4 or IPv6 text) is on the public internet. Anything unreadable isn't. */
export function isPublicAddress(address: string): boolean {
  const v4 = ipv4(address);
  if (v4 !== null) return v4IsPublic(v4);
  const v6 = ipv6(address);
  return v6 !== null && v6IsPublic(v6);
}

/** A URL host that is an IP address written out (IPv4 or [IPv6]), as the address; else null. */
export function literalAddress(host: string): string | null {
  if (ipv4(host) !== null) return host;
  return host.startsWith("[") && ipv6(host) !== null ? host.slice(1, -1) : null;
}
