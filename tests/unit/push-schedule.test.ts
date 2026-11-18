// SPDX-License-Identifier: AGPL-3.0-or-later

import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { createTokenCipher } from "../../src/crypto/tokens.js";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import type { HttpRequestInit, HttpResponse } from "../../src/oauth/http.js";
import { GOOGLE_REVOKE_ENDPOINT, GOOGLE_TOKEN_ENDPOINT } from "../../src/oauth/token-exchange.js";
import { EVERYTHING } from "../../src/people/capability.js";
import { tickFailureLog, tickLog } from "../../src/reconcile/tick.js";
import type { OAuthRouteDeps } from "../../src/web/routes/oauth.js";
import { pushTickPorts } from "../../src/web/routes/oauth-deps.js";

// Scheduling the push tick (MVP-4 G2, part 4): what a tick logs (§14 — ids and reasons, never
// content, nothing for a quiet one), and the ports both targets build from the OAuth client.

it("a quiet or skipped tick logs nothing; anything else is counted by reason", () => {
  expect(tickLog("c1", { outcome: "skipped", decisions: [] })).toBeNull();
  expect(tickLog("c1", { outcome: "done", decisions: [] })).toBeNull();
  expect(
    tickLog("c1", {
      outcome: "done",
      decisions: [
        { eventId: "e1", reason: "skipped_unchanged" },
        { eventId: "e2", reason: "skipped_unchanged" },
      ],
    }),
  ).toBeNull();
  expect(
    tickLog("c1", {
      outcome: "done",
      decisions: [
        { eventId: "e1", reason: "pushed" },
        { eventId: "e2", reason: "skipped_unchanged" },
        { eventId: "e3", reason: "pushed" },
        { eventId: "e4", reason: "retry_scheduled" },
      ],
    }),
  ).toEqual({
    reason: "push_tick",
    connection: "c1",
    outcome: "done",
    pushed: 2,
    retry_scheduled: 1,
  });
  // A refused grant or a deferred token is said even with no decisions.
  expect(tickLog("c1", { outcome: "auth_error", decisions: [] })).toEqual({
    reason: "push_tick",
    connection: "c1",
    outcome: "auth_error",
  });
  expect(tickLog("c1", { outcome: "deferred", decisions: [] })?.outcome).toBe("deferred");
  expect(tickLog("c1", { outcome: "disconnected", decisions: [] })?.outcome).toBe("disconnected");
});

it("a tick that threw logs the error's kind, never its message", () => {
  const line = tickFailureLog("c1", new TypeError("SELECT title FROM … 'Dinner at Ann's'"));
  expect(line).toEqual({ reason: "push_tick_failed", connection: "c1", error: "TypeError" });
  expect(JSON.stringify(line)).not.toContain("Dinner");
  expect(tickFailureLog("c1", "boom")).toEqual({
    reason: "push_tick_failed",
    connection: "c1",
    error: "string",
  });
});

const reply = (status: number, body: unknown): HttpResponse => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

it("the ports refresh with this client's credentials, call this calendar, and link the event's page", async () => {
  const calls: { url: string; init: HttpRequestInit }[] = [];
  const oauth: OAuthRouteDeps = {
    storage: sqliteStoragePort(createClient({ url: ":memory:" })),
    cipher: await createTokenCipher([{ id: 1, material: `${"A".repeat(43)}=` }], 1),
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://whendowe.example/oauth/callback",
    now: () => "2101-12-01T09:00:00.000Z",
    newId: () => "id-1",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return url === GOOGLE_TOKEN_ENDPOINT
        ? reply(200, { access_token: "fresh", expires_in: 3600, token_type: "Bearer" })
        : reply(200, { items: [] });
    },
  };
  const ports = pushTickPorts(oauth, {
    publicBaseUrl: "https://whendowe.example",
    capabilities: EVERYTHING,
  });
  expect(ports.storage).toBe(oauth.storage);
  expect(ports.cipher).toBe(oauth.cipher);
  expect(ports.capabilities).toBe(EVERYTHING);
  expect(ports.now()).toBe("2101-12-01T09:00:00.000Z");
  expect(ports.newId()).toBe("id-1");
  expect(ports.newNonce()).not.toBe(ports.newNonce());
  expect(ports.eventUrl("e1")).toBe("https://whendowe.example/events/e1");

  expect(await ports.refresh("refresh-1")).toEqual({
    accessToken: "fresh",
    expiresAt: "2101-12-01T10:00:00.000Z",
  });
  const [refresh] = calls;
  expect(refresh?.url).toBe(GOOGLE_TOKEN_ENDPOINT);
  const form = new URLSearchParams(refresh?.init.body ?? "");
  expect(Object.fromEntries(form)).toMatchObject({
    client_id: "client-id",
    client_secret: "client-secret",
    refresh_token: "refresh-1",
    grant_type: "refresh_token",
  });

  const provider = ports.providerFor("cal@group", async () => "token-1");
  expect(await provider.findByMetadata("e1")).toBeNull();
  const lookup = calls[1];
  expect(lookup?.url).toMatch(
    /^https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/cal%40group\/events\?/,
  );
  expect(lookup?.init.headers.authorization).toBe("Bearer token-1");

  // Disconnecting gives the grant back (rc40): the refresh token, to Google's revoke endpoint.
  expect(await ports.revoke("refresh-1")).toBe(true);
  const revoke = calls[2];
  expect(revoke?.url).toBe(GOOGLE_REVOKE_ENDPOINT);
  expect(revoke?.init.body).toBe("token=refresh-1");
});

it("without a client's own fetch or ids, the defaults are used", async () => {
  const ports = pushTickPorts(
    {
      storage: sqliteStoragePort(createClient({ url: ":memory:" })),
      cipher: await createTokenCipher([{ id: 1, material: `${"A".repeat(43)}=` }], 1),
      clientId: "c",
      clientSecret: "s",
      redirectUri: "https://whendowe.example/oauth/callback",
      now: () => "2101-12-01T09:00:00.000Z",
    },
    { publicBaseUrl: "https://whendowe.example", capabilities: EVERYTHING },
  );
  expect(ports.newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  expect(ports.newId()).not.toBe(ports.newId());
});
