/* FreeMedAssist sign-in version (app.html) — automated checks.
 *
 *   1. Structure: app.html carries the auth layer, the inlined engine, a locked body, an
 *      encrypted-only account record (no plaintext password), honest no-server wording, and
 *      a link back to the no-login version.
 *   2. Crypto: a real WebCrypto round-trip using the SAME algorithm as the app (PBKDF2 ->
 *      AES-GCM) proves the correct password decrypts, a wrong password fails, the vault
 *      round-trips, and ciphertext does not leak plaintext.
 *
 * Run:  node engine/signin_test.mjs   (exits 0 on success, 1 on any failure)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { webcrypto as crypto } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0; const fail = [];
const ck = (n, c, d) => { c ? pass++ : fail.push(n + (d ? ("  (" + d + ")") : "")); };

/* ---- 1. structure ---- */
const app = readFileSync(join(HERE, "..", "app.html"), "utf-8");
ck("app.html: auth overlay present", app.includes('id="fma-auth"'));
ck("app.html: sign-in + sign-up functions present", app.includes("fmaSignIn") && app.includes("fmaSignUp"));
ck("app.html: engine inlined (same as no-login version)", app.includes("FreeMedAssistEngine"));
ck("app.html: results renderer present (wizard intact)", app.includes("function renderResults"));
ck("app.html: body starts locked", app.includes('<body class="fma-locked">'));
ck("app.html: uses PBKDF2 + AES-GCM", app.includes("PBKDF2") && app.includes("AES-GCM"));
ck("app.html: account stores ONLY salt+iter+encrypted verifier (no password)",
  app.includes("{ user:u, salt:b64e(salt), iter:ITER, ver:ver }"));
ck("app.html: links back to the no-login version", app.includes('href="index.html"'));
ck("app.html: honest 'no server / no recovery' wording",
  /no server/i.test(app) && /(no password reset|cannot be recovered|can't be recovered)/i.test(app));

/* ---- 2. crypto round-trip (mirror of the app's algorithm) ---- */
const ITER = 210000;
async function deriveKey(pw, salt) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), { name: "PBKDF2" }, false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function enc(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { iv, ct };
}
async function dec(key, blob) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.iv }, key, blob.ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

const salt = crypto.getRandomValues(new Uint8Array(16));
const keyRight = await deriveKey("correcthorse9", salt);
const ver = await enc(keyRight, "FMA-OK");

let okRight = false; try { okRight = (await dec(keyRight, ver)) === "FMA-OK"; } catch (e) {}
ck("crypto: correct password decrypts the verifier", okRight);

const keyWrong = await deriveKey("wrongpassword", salt);
let wrongRejected = false; try { await dec(keyWrong, ver); } catch (e) { wrongRejected = true; }
ck("crypto: wrong password CANNOT decrypt (rejected)", wrongRejected);

const vault = [{ label: "Memorial Hospital", bill: { line_items: [{ code: "80053" }] } }];
const blob = await enc(keyRight, vault);
const back = await dec(keyRight, blob);
ck("crypto: vault round-trips intact", JSON.stringify(back) === JSON.stringify(vault));
ck("crypto: ciphertext hides the plaintext", !Buffer.from(blob.ct).toString("latin1").includes("Memorial"));

/* ---- report ---- */
if (fail.length === 0) {
  console.log("FreeMedAssist sign-in test PASSED: " + pass + " assertions (structure + WebCrypto round-trip).");
  process.exit(0);
} else {
  console.error("FreeMedAssist sign-in test FAILED: " + fail.length + " of " + (pass + fail.length) + " failed:");
  for (const f of fail) console.error("  X " + f);
  process.exit(1);
}
