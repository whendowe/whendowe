// SPDX-License-Identifier: AGPL-3.0-or-later
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import { request } from "node:https";
import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";
import {
  AddressRefused,
  isPublicAddress,
  literalAddress,
  type PublicGet,
} from "../../src/following/fetch.js";

// The Node deployment's PublicGet (DESIGN §10 rc57): a followed link's host must be a public
// address, and it is checked inside the lookup the connection itself uses — so a name can't
// answer "public" to a check and "private" to the connection a moment later (DNS rebinding).
// Every address a name has must be public, not only the one used. An IP written in the URL
// never reaches a lookup, so it is checked first. No agent: nothing is pooled or shared with
// other requests, and no redirect is followed (node:https never does).

type Resolve = (
  hostname: string,
  options: LookupAllOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/** A lookup that refuses a name with any address that isn't public. */
export function checkedLookup(resolve: Resolve = dnsLookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err !== null) {
        callback(err, "", 4);
        return;
      }
      const first = addresses[0];
      if (first === undefined || !addresses.every((a) => isPublicAddress(a.address))) {
        callback(new AddressRefused(), "", 4);
        return;
      }
      if (options.all === true) callback(null, addresses);
      else callback(null, first.address, first.family);
    });
  };
}

export function nodePublicGet(resolve?: Resolve): PublicGet {
  const lookup = checkedLookup(resolve);
  return (url, headers, signal) =>
    new Promise((settle, fail) => {
      const target = new URL(url);
      const literal = literalAddress(target.hostname);
      if (literal !== null && !isPublicAddress(literal)) {
        fail(new AddressRefused());
        return;
      }
      const req = request(
        target,
        { method: "GET", headers, signal, lookup, agent: false },
        (res) => {
          settle({
            status: res.statusCode ?? 0,
            header: (name) => {
              const value = res.headers[name.toLowerCase()];
              return typeof value === "string" ? value : (value?.[0] ?? null);
            },
            body: Readable.toWeb(res),
          });
        },
      );
      req.on("error", fail);
      req.end();
    });
}
