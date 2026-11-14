// SPDX-License-Identifier: AGPL-3.0-or-later
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import { capabilityConfigOf, loadConfig } from "../../src/config.js";
import { sqliteStoragePort } from "../../src/db/sqlite.js";
import type { MailMessage } from "../../src/mail/port.js";
import { type CapabilityConfig, hasCapability } from "../../src/people/capability.js";
import { findPersonByEmail } from "../../src/people/person.js";
import { createApp } from "../../src/web/app.js";
import { CONFIRM_PATH, SIGN_IN_PATH } from "../../src/web/routes/auth.js";
import { OPERATOR_PATH } from "../../src/web/routes/operator.js";
import { loadMigrationSql } from "../conftest.js";

// The operator page (DESIGN §10 rc43): only the instance's operators see it, it shows
// addresses and capabilities only, and every grant and revoke is logged.

async function harness(capabilities?: CapabilityConfig) {
  const client = createClient({ url: ":memory:" });
  for (const sql of await loadMigrationSql()) await client.executeMultiple(sql);
  const storage = sqliteStoragePort(client);
  const sent: MailMessage[] = [];
  const app = createApp({
    auth: {
      storage,
      mail: {
        send: (m) => {
          sent.push(m);
          return Promise.resolve();
        },
      },
      publicBaseUrl: "https://whendowe.example",
      secureCookies: false,
      now: () => new Date().toISOString(),
      ...(capabilities === undefined ? {} : { capabilities }),
    },
  });
  return { app, sent, storage };
}
type H = Awaited<ReturnType<typeof harness>>;

const post = (fields: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(fields).toString(),
});

async function signIn(h: H, email: string): Promise<{ cookie: string; csrf: string }> {
  await h.app.request(SIGN_IN_PATH, post({ email }));
  const t =
    new URL(/https?:\/\/\S+/.exec(h.sent.at(-1)?.text ?? "")?.[0] ?? "").searchParams.get("t") ??
    "";
  const res = await h.app.request(CONFIRM_PATH, post({ t }));
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const home = await (await h.app.request("/", { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(home)?.[1] ?? "";
  return { cookie, csrf };
}

const GRANTED = capabilityConfigOf(
  loadConfig({
    CAPABILITIES_DEFAULT: "granted",
    OPERATOR_EMAILS: " Op@Example.org, second@example.org",
  }),
);

it("the configuration: `all` with no operators unless set; addresses normalised", () => {
  expect(capabilityConfigOf(loadConfig({}))).toEqual({ default: "all", operators: [] });
  expect(GRANTED).toEqual({
    default: "granted",
    operators: ["op@example.org", "second@example.org"],
  });
  expect(() => loadConfig({ CAPABILITIES_DEFAULT: "some" })).toThrow();
});

it("only an operator sees the page; signed out it asks to sign in; with no operators it doesn't exist", async () => {
  const none = await harness();
  const nobody = await signIn(none, "op@example.org");
  expect(
    (await none.app.request(OPERATOR_PATH, { headers: { cookie: nobody.cookie } })).status,
  ).toBe(404);

  const h = await harness(GRANTED);
  expect((await h.app.request(OPERATOR_PATH)).status).toBe(303);
  const ann = await signIn(h, "ann@example.org");
  expect((await h.app.request(OPERATOR_PATH, { headers: { cookie: ann.cookie } })).status).toBe(
    404,
  );
  expect(
    (
      await h.app.request(
        `${OPERATOR_PATH}/grant`,
        post({ csrf: ann.csrf, email: "ann@example.org", capability: "verify" }, ann.cookie),
      )
    ).status,
  ).toBe(404);
  const op = await signIn(h, "op@example.org");
  const res = await h.app.request(OPERATOR_PATH, { headers: { cookie: op.cookie } });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const text = await res.text();
  expect(text).toContain("<h1>Operator page</h1>");
  expect(text).toContain("This instance gives capabilities only to the accounts granted here.");
  expect(text).toContain("Nobody yet.");
});

it("an operator grants by address — before the first sign-in, too — and revokes; both are logged", async () => {
  const h = await harness(GRANTED);
  const op = await signIn(h, "op@example.org");
  const page = async () =>
    (await h.app.request(OPERATOR_PATH, { headers: { cookie: op.cookie } })).text();
  expect(
    (
      await h.app.request(
        `${OPERATOR_PATH}/grant`,
        post({ csrf: "x", email: "new@example.org", capability: "verify" }, op.cookie),
      )
    ).status,
  ).toBe(403);
  const bad = await h.app.request(
    `${OPERATOR_PATH}/grant`,
    post({ csrf: op.csrf, email: "nope", capability: "verify" }, op.cookie),
  );
  expect(bad.status).toBe(400);
  expect(await bad.text()).toContain("That isn't an email address.");
  expect(
    (
      await h.app.request(
        `${OPERATOR_PATH}/grant`,
        post({ csrf: op.csrf, email: "new@example.org", capability: "fly" }, op.cookie),
      )
    ).status,
  ).toBe(400);

  const granted = await h.app.request(
    `${OPERATOR_PATH}/grant`,
    post({ csrf: op.csrf, email: "New@Example.org", capability: "verify" }, op.cookie),
  );
  expect(granted.status).toBe(303);
  const person = await findPersonByEmail(h.storage, "new@example.org");
  if (person === null) throw new Error("expected the person");
  expect(await hasCapability(h.storage, GRANTED, person.id, "verify")).toBe(true);
  const after = await page();
  expect(after).toContain("new@example.org: Turn verifying on");
  expect(after).toMatch(/op@example\.org granted Turn verifying on to new@example\.org/);

  await h.app.request(
    `${OPERATOR_PATH}/revoke`,
    post({ csrf: op.csrf, person: person.id, capability: "verify" }, op.cookie),
  );
  expect(await hasCapability(h.storage, GRANTED, person.id, "verify")).toBe(false);
  const revoked = await page();
  expect(revoked).toContain("Nobody yet.");
  expect(revoked).toMatch(/op@example\.org revoked Turn verifying on from new@example\.org/);
  expect(
    (
      await h.app.request(
        `${OPERATOR_PATH}/revoke`,
        post({ csrf: op.csrf, capability: "verify" }, op.cookie),
      )
    ).status,
  ).toBe(400);
});

it("on an `all` instance the page says grants change nothing yet", async () => {
  const h = await harness({ default: "all", operators: ["op@example.org"] });
  const op = await signIn(h, "op@example.org");
  expect(
    await (await h.app.request(OPERATOR_PATH, { headers: { cookie: op.cookie } })).text(),
  ).toContain(
    "This instance gives every account every capability, so grants here change nothing until it is set to give them only to granted accounts.",
  );
});
