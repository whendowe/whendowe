// SPDX-License-Identifier: AGPL-3.0-or-later
import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import { checkedLookup, nodePublicGet } from "../../deploy/node/public-address.js";
import { AddressRefused, fetchFeed } from "../../src/following/fetch.js";

// The Node deployment's address check (DESIGN §10 rc57): inside the lookup the connection
// uses, every address a name has must be public. A fake resolver stands in for DNS, so no
// test here reaches the network: a refused name never connects at all.

const resolver =
  (answers: Record<string, LookupAddress[]>) =>
  (
    hostname: string,
    _options: object,
    callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
  ) => {
    const found = answers[hostname];
    if (found === undefined) {
      const err: NodeJS.ErrnoException = new Error("ENOTFOUND");
      err.code = "ENOTFOUND";
      callback(err, []);
    } else {
      callback(null, found);
    }
  };

const v4 = (address: string): LookupAddress => ({ address, family: 4 });
const v6 = (address: string): LookupAddress => ({ address, family: 6 });

function lookupOnce(
  answers: Record<string, LookupAddress[]>,
  host: string,
  all: boolean,
): Promise<{ err: Error | null; address: unknown; family: unknown }> {
  return new Promise((settle) => {
    checkedLookup(resolver(answers))(host, { all }, (err, address, family) =>
      settle({ err, address, family }),
    );
  });
}

describe("checkedLookup", () => {
  const answers = {
    "club.example": [v4("93.184.216.34"), v6("2606:2800:220:1::1")],
    "rebind.example": [v4("93.184.216.34"), v4("127.0.0.1")],
    "inside.example": [v6("fd00::1")],
    "empty.example": [],
  };

  it("answers with a public name's addresses, one or all as asked", async () => {
    expect(await lookupOnce(answers, "club.example", false)).toEqual({
      err: null,
      address: "93.184.216.34",
      family: 4,
    });
    const all = await lookupOnce(answers, "club.example", true);
    expect(all.err).toBeNull();
    expect(all.address).toEqual(answers["club.example"]);
  });

  it("refuses a name with any address that isn't public, or none", async () => {
    for (const host of ["rebind.example", "inside.example", "empty.example"]) {
      expect((await lookupOnce(answers, host, false)).err).toBeInstanceOf(AddressRefused);
    }
  });

  it("passes a resolver's own failure on as it is", async () => {
    const { err } = await lookupOnce(answers, "nowhere.example", false);
    expect(err).not.toBeInstanceOf(AddressRefused);
    expect(err?.message).toBe("ENOTFOUND");
  });
});

describe("nodePublicGet", () => {
  const signal = () => AbortSignal.timeout(5000);

  it("refuses an IP written in the URL before any connection, and a name resolving inside", async () => {
    const get = nodePublicGet(resolver({ "local.example": [v4("127.0.0.1")] }));
    for (const url of [
      "https://127.0.0.1/cal.ics",
      "https://[::1]/cal.ics",
      "https://0x7f.1/cal.ics", // the URL parser reads it as 127.0.0.1
      "https://local.example/cal.ics",
    ]) {
      await expect(get(url, {}, signal())).rejects.toBeInstanceOf(AddressRefused);
    }
  });

  it("is refused through fetchFeed, as the outcome a person sees", async () => {
    const get = nodePublicGet(resolver({ "metadata.example": [v4("169.254.169.254")] }));
    expect(
      await fetchFeed(get, "https://metadata.example/latest", { etag: null, lastModified: null }),
    ).toEqual({ kind: "refused" });
  });
});
