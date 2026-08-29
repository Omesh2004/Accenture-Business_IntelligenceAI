import { EncryptJWT } from "jose";
import hkdf from "@panva/hkdf";
import { randomUUID } from "node:crypto";
import type { BrowserContext } from "@playwright/test";

/**
 * Mint a NextAuth v4 session cookie.
 *
 * The dashboard authenticates through Google OAuth, which headless tests cannot complete. Sessions
 * are JWT-strategy, so a token encrypted with the same NEXTAUTH_SECRET is indistinguishable from a
 * real login — and that is what lets these tests reach the authenticated routes where the RBAC
 * bugs actually live, instead of stopping at the login screen.
 *
 * Implemented against `jose` directly rather than importing `next-auth`: that package peer-depends
 * on `next`, which drags the whole framework (and a conflicting @playwright/test peer) into a test
 * package that only needs to encrypt a small JSON payload.
 *
 * Mirrors next-auth@4 `encode()`: dir/A256GCM, key derived by HKDF-SHA256 with an empty salt and
 * next-auth's fixed info string. If dashboard auth ever moves to v5, this derivation changes.
 */
const SECRET = process.env.NEXTAUTH_SECRET || "nucleus-analytics-secret-key-2026";
const COOKIE = "analytics-dash.session-token";
const INFO = "NextAuth.js Generated Encryption Key";

async function derivedKey(secret: string): Promise<Uint8Array> {
  return hkdf("sha256", secret, "", INFO, 32);
}

export async function encodeSessionToken(email: string, maxAgeSeconds = 3600): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new EncryptJWT({ name: email.split("@")[0], email, sub: email, picture: "" })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt(now)
    .setExpirationTime(now + maxAgeSeconds)
    .setJti(randomUUID())
    .encrypt(await derivedKey(SECRET));
}

/**
 * Role is deliberately NOT passed in. The jwt callback recomputes it from rbac.json on every
 * request, so the EMAIL decides what the session may reach — which is the behaviour under test.
 */
export async function signIn(
  context: BrowserContext,
  email: string,
  baseURL: string,
): Promise<void> {
  const token = await encodeSessionToken(email);
  const { hostname } = new URL(baseURL);
  await context.addCookies([
    {
      name: COOKIE,
      value: token,
      domain: hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      expires: Math.floor(Date.now() / 1000) + 3600,
    },
  ]);
}

/** Emails that resolve to each role via rbac.json. */
export const USERS = {
  superAdmin: "omeshmehta70@gmail.com",
  appAdmin: "abhishekkumawat1008@gmail.com",
  normalUser: "nobody-in-rbac@example.com",
};
