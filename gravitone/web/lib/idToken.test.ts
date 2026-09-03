// The verifier is the whole of the studio's server-side identity, so what it
// REFUSES is the interesting part. Each case below is a token that is
// cryptographically fine and still not an identity here.
//
// Tokens are minted in-test with a throwaway RSA key whose self-signed
// certificate is served as Google's — the same shape verifyIdToken fetches.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, createSign, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetCertCache, verifyIdToken } from "./idToken";

const PROJECT = "gravitone-test";
const KID = "test-kid";

/** A self-signed cert for a fresh RSA key, plus the private key that signs
 *  tokens for it. Generated once for the file — keygen is the slow part. */
const { certPem, privateKey } = (() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dir = mkdtempSync(join(tmpdir(), "gravitone-idtoken-"));
  const keyPath = join(dir, "k.pem");
  const certPath = join(dir, "c.pem");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }) as string);
  // openssl ships with git-bash/node CI images; if it is absent the whole file
  // is skipped rather than silently asserting nothing.
  execFileSync("openssl", [
    "req", "-x509", "-new", "-key", keyPath, "-days", "1",
    "-subj", "/CN=securetoken.test", "-out", certPath,
  ], { stdio: "ignore" });
  const certPem = readFileSync(certPath, "utf8");
  rmSync(dir, { recursive: true, force: true });
  void publicKey;
  return { certPem, privateKey };
})();

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function mint(payload: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const h = b64({ alg: "RS256", kid: KID, typ: "JWT", ...header });
  const p = b64(payload);
  const signer = createSign("RSA-SHA256");
  signer.update(`${h}.${p}`);
  return `${h}.${p}.${signer.sign(privateKey).toString("base64url")}`;
}

const now = () => Math.floor(Date.now() / 1000);
const goodClaims = (over: Record<string, unknown> = {}) => ({
  iss: `https://securetoken.google.com/${PROJECT}`,
  aud: PROJECT,
  sub: "uid123",
  email: "a@example.com",
  iat: now() - 10,
  auth_time: now() - 10,
  exp: now() + 3600,
  ...over,
});

beforeEach(() => {
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = PROJECT;
  resetCertCache();
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ [KID]: certPem }), {
      headers: { "Content-Type": "application/json", "cache-control": "public, max-age=3600" },
    })));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
});

describe("verifyIdToken", () => {
  it("accepts a well-formed token and returns its uid", async () => {
    expect(new X509Certificate(certPem).publicKey).toBeTruthy();
    await expect(verifyIdToken(mint(goodClaims()))).resolves.toEqual({
      uid: "uid123", email: "a@example.com",
    });
  });

  it("refuses a token signed by someone else", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const h = b64({ alg: "RS256", kid: KID });
    const p = b64(goodClaims());
    const s = createSign("RSA-SHA256");
    s.update(`${h}.${p}`);
    await expect(verifyIdToken(`${h}.${p}.${s.sign(other).toString("base64url")}`)).resolves.toBeNull();
  });

  it("refuses a token whose payload was edited after signing", async () => {
    const token = mint(goodClaims());
    const [h, , sig] = token.split(".");
    const tampered = `${h}.${b64(goodClaims({ sub: "someone-else" }))}.${sig}`;
    await expect(verifyIdToken(tampered)).resolves.toBeNull();
  });

  it("refuses a token minted for a DIFFERENT Firebase project", async () => {
    // The one that matters most: anyone can create a Firebase project and get
    // Google to sign a real token. Audience is the whole defence.
    await expect(verifyIdToken(mint(goodClaims({ aud: "someone-elses-app" })))).resolves.toBeNull();
    await expect(verifyIdToken(mint(goodClaims({
      iss: "https://securetoken.google.com/someone-elses-app",
    })))).resolves.toBeNull();
  });

  it("refuses an expired token, and one issued in the future", async () => {
    await expect(verifyIdToken(mint(goodClaims({ exp: now() - 120 })))).resolves.toBeNull();
    await expect(verifyIdToken(mint(goodClaims({ iat: now() + 600 })))).resolves.toBeNull();
  });

  it("refuses `alg: none` and an unsigned token", async () => {
    const h = b64({ alg: "none", kid: KID });
    await expect(verifyIdToken(`${h}.${b64(goodClaims())}.`)).resolves.toBeNull();
    await expect(verifyIdToken("not-a-jwt")).resolves.toBeNull();
  });

  it("refuses a token naming a signing key Google does not publish", async () => {
    await expect(verifyIdToken(mint(goodClaims(), { kid: "made-up" }))).resolves.toBeNull();
  });

  it("refuses everything when no Firebase project is configured", async () => {
    delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    await expect(verifyIdToken(mint(goodClaims()))).resolves.toBeNull();
  });

  it("fetches Google's certificates once, then serves them from cache", async () => {
    await verifyIdToken(mint(goodClaims()));
    await verifyIdToken(mint(goodClaims()));
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});
