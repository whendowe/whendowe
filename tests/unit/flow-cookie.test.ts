// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "../../src/crypto/base64.js";
import { createTokenCipher, type TokenCipher } from "../../src/crypto/tokens.js";
import {
  buildFlowClearCookie,
  buildFlowSetCookie,
  FLOW_COOKIE_NAME,
  FLOW_TTL_SECONDS,
  type OAuthFlow,
  readFlowCookie,
  sealFlow,
  unsealFlow,
} from "../../src/oauth/flow-cookie.js";
import { createCodeVerifier, createState } from "../../src/oauth/pkce.js";

// Unit rather than a both-runtime contract suite on purpose: the only platform
// primitives involved are the token cipher (already proven on Node and workerd by
// tests/contract/token-cipher.suite.ts) and encodeURIComponent/JSON, which are
// universal. Nothing new here is runtime-dependent.

const KEY_1 = { id: 1, material: `${"A".repeat(43)}=` };
const KEY_2 = { id: 2, material: `${"B".repeat(43)}=` };

const ISSUED_AT = 1_000_000;

async function cipher(): Promise<TokenCipher> {
  return createTokenCipher([KEY_1], 1);
}

function flow(overrides: Partial<OAuthFlow> = {}): OAuthFlow {
  return {
    state: createState(),
    verifier: createCodeVerifier(),
    personId: "person-1",
    issuedAt: ISSUED_AT,
    ...overrides,
  };
}

// --- round-trip ---

it("round-trips a flow through the cookie", async () => {
  const c = await cipher();
  const original = flow();
  const unsealed = await unsealFlow(c, await sealFlow(c, original), ISSUED_AT);
  expect(unsealed).toEqual(original);
});

it("does not leak the verifier or state into the cookie value", async () => {
  const c = await cipher();
  const original = flow();
  const sealed = await sealFlow(c, original);
  expect(sealed).not.toContain(original.verifier);
  expect(sealed).not.toContain(original.state);
});

it("produces a cookie-safe value", async () => {
  const c = await cipher();
  const sealed = await sealFlow(c, flow());
  // The cipher emits standard base64; percent-encoding must remove +, / and =
  // along with anything else that would confuse a cookie parser.
  for (const forbidden of ["+", "/", "=", ";", ",", " ", '"', "\\"]) {
    expect(sealed).not.toContain(forbidden);
  }
});

// --- integrity and confidentiality ---

it("rejects a tampered cookie on GCM authentication, not by accident", async () => {
  const c = await cipher();
  const sealed = await sealFlow(c, flow());

  // Flip one bit of the CIPHERTEXT rather than mangling the encoded string: a
  // length change or a broken %XX sequence would also throw, but for the wrong
  // reason, and the test would pass without ever exercising GCM's integrity check.
  const bytes = base64ToBytes(decodeURIComponent(sealed));
  const last = bytes.length - 1;
  bytes[last] = (bytes[last] ?? 0) ^ 0x01;
  const tampered = encodeURIComponent(bytesToBase64(bytes));

  expect(tampered).not.toBe(sealed);
  expect(tampered.length).toBe(sealed.length);
  await expect(unsealFlow(c, tampered, ISSUED_AT)).rejects.toThrow(/decryption failed/);
});

it("rejects a cookie sealed under a different key", async () => {
  const writer = await createTokenCipher([KEY_2], 2);
  const reader = await cipher();
  const sealed = await sealFlow(writer, flow());
  await expect(unsealFlow(reader, sealed, ISSUED_AT)).rejects.toThrow(/no token key/);
});

it("rejects a cookie that is not validly percent-encoded", async () => {
  const c = await cipher();
  // A client can send anything in a cookie header; a bare % is not decodable.
  await expect(unsealFlow(c, "%", ISSUED_AT)).rejects.toThrow(/not a valid encoded value/);
  await expect(unsealFlow(c, "%ZZ", ISSUED_AT)).rejects.toThrow(/not a valid encoded value/);
});

it("rejects a payload that is not valid JSON", async () => {
  const c = await cipher();
  const sealed = encodeURIComponent(await c.encrypt("not json at all"));
  await expect(unsealFlow(c, sealed, ISSUED_AT)).rejects.toThrow(/not valid JSON/);
});

it("rejects a payload that does not match the schema", async () => {
  const c = await cipher();
  const sealed = encodeURIComponent(await c.encrypt(JSON.stringify({ state: "only-state" })));
  await expect(unsealFlow(c, sealed, ISSUED_AT)).rejects.toThrow();
});

it("rejects a payload whose verifier violates RFC 7636", async () => {
  const c = await cipher();
  const sealed = encodeURIComponent(
    await c.encrypt(
      JSON.stringify({ state: "s", verifier: "too-short", personId: "p", issuedAt: ISSUED_AT }),
    ),
  );
  await expect(unsealFlow(c, sealed, ISSUED_AT)).rejects.toThrow(/43–128 characters/);
});

// --- expiry ---

it("accepts a flow inside its TTL", async () => {
  const c = await cipher();
  const sealed = await sealFlow(c, flow());
  await expect(unsealFlow(c, sealed, ISSUED_AT + FLOW_TTL_SECONDS)).resolves.toBeDefined();
});

it("rejects a flow past its TTL", async () => {
  const c = await cipher();
  const sealed = await sealFlow(c, flow());
  // Browser Max-Age is advisory — a client can simply keep sending the cookie, so
  // the expiry has to be enforced server-side too.
  await expect(unsealFlow(c, sealed, ISSUED_AT + FLOW_TTL_SECONDS + 1)).rejects.toThrow(/expired/);
});

it("tolerates small clock skew but rejects a future-dated flow", async () => {
  const c = await cipher();
  const sealed = await sealFlow(c, flow());
  await expect(unsealFlow(c, sealed, ISSUED_AT - 30)).resolves.toBeDefined();
  // Beyond tolerance: a future issuedAt would otherwise outlive the TTL.
  await expect(unsealFlow(c, sealed, ISSUED_AT - 120)).rejects.toThrow(/dated in the future/);
});

it("never puts the verifier into an error message (§13)", async () => {
  const c = await cipher();
  const original = flow();
  const sealed = await sealFlow(c, original);
  let message = "";
  try {
    await unsealFlow(c, sealed, ISSUED_AT + FLOW_TTL_SECONDS + 5);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toMatch(/expired/);
  expect(message).not.toContain(original.verifier);
});

// --- cookie headers ---

it("sets the cookie with the attributes §13 requires", async () => {
  const c = await cipher();
  const header = buildFlowSetCookie(await sealFlow(c, flow()));
  expect(header).toContain(`${FLOW_COOKIE_NAME}=`);
  expect(header).toContain("HttpOnly");
  expect(header).toContain("Secure");
  expect(header).toContain(`Max-Age=${FLOW_TTL_SECONDS}`);
  expect(header).toContain("Path=/oauth");
  // Lax, not Strict: Google returns the user by top-level GET navigation, which
  // Strict would drop — breaking every callback.
  expect(header).toContain("SameSite=Lax");
  expect(header).not.toContain("SameSite=Strict");
});

it("can omit Secure for environments that reject it on localhost", () => {
  expect(buildFlowSetCookie("v", { secure: false })).not.toContain("Secure");
  expect(buildFlowSetCookie("v", { secure: true })).toContain("Secure");
  expect(buildFlowSetCookie("v")).toContain("Secure");
});

it("clears the cookie with an empty value and Max-Age=0", () => {
  const header = buildFlowClearCookie();
  expect(header).toContain(`${FLOW_COOKIE_NAME}=;`);
  expect(header).toContain("Max-Age=0");
  expect(header).toContain("HttpOnly");
  expect(header).toContain("Path=/oauth");
});

// --- reading the request header ---

it("reads the cookie out of a Cookie header", () => {
  expect(readFlowCookie(`${FLOW_COOKIE_NAME}=abc123`)).toBe("abc123");
  expect(readFlowCookie(`other=1; ${FLOW_COOKIE_NAME}=abc123; another=2`)).toBe("abc123");
  expect(readFlowCookie(` ${FLOW_COOKIE_NAME}=abc123 `)).toBe("abc123");
});

it("returns null when the cookie is absent or empty", () => {
  expect(readFlowCookie(null)).toBeNull();
  expect(readFlowCookie(undefined)).toBeNull();
  expect(readFlowCookie("")).toBeNull();
  expect(readFlowCookie("other=1; another=2")).toBeNull();
  expect(readFlowCookie(`${FLOW_COOKIE_NAME}=`)).toBeNull();
  expect(readFlowCookie("malformed")).toBeNull();
});

it("does not confuse a similarly-named cookie", () => {
  // A prefix match here would let an attacker-set cookie shadow the real one.
  expect(readFlowCookie(`${FLOW_COOKIE_NAME}_extra=evil`)).toBeNull();
  expect(readFlowCookie(`x${FLOW_COOKIE_NAME}=evil`)).toBeNull();
  expect(readFlowCookie(`${FLOW_COOKIE_NAME}_extra=evil; ${FLOW_COOKIE_NAME}=good`)).toBe("good");
});

it("tolerates other cookies containing = in their values", () => {
  expect(readFlowCookie(`session=YWJjPT09; ${FLOW_COOKIE_NAME}=abc123`)).toBe("abc123");
});
