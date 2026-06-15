/* FreeMedAssist self-test — self-contained, NO Python dependency.
 *
 * Loads engine/freemedassist_engine.js exactly as a browser <script> would (read the file,
 * evaluate it in global scope so it attaches globalThis.FreeMedAssistEngine), then asserts the
 * known-good outputs for the canonical scenarios that prove the engine still behaves.
 *
 * Run:  node engine/selftest.mjs
 * Exits 0 on success, 1 on any failed assertion.
 *
 * What it checks:
 *   1. Insured bill + EOB  -> total flagged $2,823.40, the 13 expected finding categories,
 *      FREE care + Medicaid (expansion), recovery bill_savings 2823.4.
 *   2. Uninsured low-income (bill only) -> $1,122.00 flagged, FREE care + Medicaid.
 *   3. Clean bill -> no findings, total 0, recovery present.
 *   4. State-precise eligibility -> 48-state vs Alaska vs Hawaii FPL differ as expected,
 *      and Medicaid expansion vs non-expansion (TX coverage-gap) resolves correctly.
 *   5. Recovery total equals the sum of kept dollar impacts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// --- Load the plain-script engine the way a browser would: evaluate it so the engine's
//     IIFE receives globalThis as `root` and attaches globalThis.FreeMedAssistEngine.
const engineSrc = readFileSync(join(HERE, "freemedassist_engine.js"), "utf-8");
(0, eval)(engineSrc);
const S = globalThis.FreeMedAssistEngine;
if (!S) {
  console.error("FAIL: FreeMedAssistEngine global was not set by freemedassist_engine.js");
  process.exit(1);
}

/* -------------------------------------------------------------------------
 * Canonical fixtures (inlined so this test needs no other files).
 * These mirror freemedassist/feeds/medical/sample_bill.json + sample_eob.json.
 * ----------------------------------------------------------------------- */
const SAMPLE_BILL = {
  bill_id: "MH-2026-0042",
  provider: "Memorial Hospital",
  service_date: "2026-05-12",
  stated_total: 2295.0,
  currency: "USD",
  line_items: [
    { code: "80053", description: "Comprehensive metabolic panel", qty: 1, unit_price: 210.0, line_total: 210.0, reference_price: 160.0 },
    { code: "80053", description: "Comprehensive metabolic panel", qty: 1, unit_price: 210.0, line_total: 210.0, reference_price: 160.0 },
    { code: "J1885", description: "Ibuprofen 200mg", qty: 2, unit_price: 50.0, line_total: 100.0, reference_price: 3.0 },
    { code: "99284", description: "Emergency dept visit, level 4", qty: 1, unit_price: 1500.0, line_total: 1500.0, reference_price: 900.0 },
    { code: "36415", description: "Routine venipuncture", qty: 2, unit_price: 12.0, line_total: 27.0, reference_price: 10.0 },
    { code: "85025", description: "Complete blood count (CBC)", qty: 1, unit_price: 48.0, line_total: 48.0, reference_price: 30.0 },
  ],
};

const SAMPLE_EOB = {
  eob_id: "EOB-MH-0042",
  insurer: "Anthem Blue Cross Blue Shield",
  plan_name: "PPO",
  claim_id: "CLM-99812",
  bill_id: "MH-2026-0042",
  lines: [
    { service_date: "2026-05-12", code: "80053", description: "Comprehensive metabolic panel", billed: 210.0, allowed: 14.0, plan_paid: 11.2, copay: 0.0, coinsurance: 2.8, deductible: 0.0, patient_responsibility: 2.8, network_status: "in" },
    { service_date: "2026-05-12", code: "J1885", description: "Ibuprofen 200mg", billed: 100.0, allowed: 6.0, plan_paid: 4.8, copay: 0.0, coinsurance: 1.2, deductible: 0.0, patient_responsibility: 1.2, network_status: "in" },
    { service_date: "2026-05-12", code: "99284", description: "Emergency dept visit, level 4", billed: 1500.0, allowed: 650.0, plan_paid: 520.0, copay: 0.0, coinsurance: 130.0, deductible: 0.0, patient_responsibility: 130.0, network_status: "out" },
    { service_date: "2026-05-12", code: "36415", description: "Routine venipuncture", billed: 27.0, allowed: 8.0, plan_paid: 6.4, copay: 0.0, coinsurance: 1.6, deductible: 0.0, patient_responsibility: 1.6, network_status: "in" },
  ],
};

const CLEAN_BILL = {
  bill_id: "CLN-1",
  provider: "Clean Clinic",
  service_date: "2026-05-12",
  stated_total: 100.0,
  line_items: [
    { code: "99213", description: "Office visit", qty: 1, unit_price: 60.0, line_total: 60.0 },
    { code: "85610", description: "Prothrombin time", qty: 1, unit_price: 40.0, line_total: 40.0 },
  ],
};

/* -------------------------------------------------------------------------
 * Tiny assertion harness.
 * ----------------------------------------------------------------------- */
let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    passed++;
  } else {
    failures.push(name + (detail ? "  (" + detail + ")" : ""));
  }
}
function eqNum(name, got, want) {
  check(name, typeof got === "number" && Math.abs(got - want) < 0.005, "got " + got + ", want " + want);
}
function sameSet(name, got, want) {
  const a = [...got].sort();
  const b = [...want].sort();
  check(name, a.length === b.length && a.every((x, i) => x === b[i]),
    "got [" + a.join(",") + "], want [" + b.join(",") + "]");
}

function gate() {
  return new S.DecideGate(new S.DecideConfig({
    min_confidence: 0.5, min_dollar_impact: 10, min_severity: 1, max_alerts: 30,
  }));
}
function advise(caseObj, bill, eob) {
  return S.advise({ case: caseObj, bill, eob: eob || null, gate: gate() });
}

/* -------------------------------------------------------------------------
 * Scenario 1 — Insured bill + EOB. Known-good: total $2,823.40, 13 findings.
 * ----------------------------------------------------------------------- */
{
  const c = S.Case({
    patient_name: "Jordan Rivers", county: "Marion", state: "IN",
    household_size: 1, annual_income: 18000.0,
    provider: "Memorial Hospital", uninsured: false,
    primary: S.Insurance({ kind: "employer", network_status: "in" }),
    supplemental: S.Insurance({ kind: "supplement" }),
  });
  const out = advise(c, SAMPLE_BILL, SAMPLE_EOB);

  eqNum("insured: total_flagged == 2823.40", out.total_flagged, 2823.4);
  eqNum("insured: recovery.bill_savings == 2823.40", out.recovery.bill_savings, 2823.4);
  check("insured: 13 findings kept", out._rep.kept.length === 13, "got " + out._rep.kept.length);

  // The expected category multiset across the 13 kept findings.
  const cats = out._rep.kept.map((f) => f.category).sort();
  const wantCats = [
    "balance-billing-possible", "balance-billing-possible", "balance-billing-possible", "balance-billing-possible",
    "bill-total-mismatch",
    "coordination-failure",
    "duplicate-charge",
    "eob-line-missing", "eob-line-missing",
    "network-status-mismatch",
    "price-vs-reference", "price-vs-reference", "price-vs-reference",
  ].sort();
  check("insured: finding categories match", cats.length === wantCats.length && cats.every((x, i) => x === wantCats[i]),
    "got [" + cats.join(",") + "]");

  check("insured: likely FREE care", out.eligibility.free === true);
  check("insured: likely Medicaid", out.eligibility.medicaid === true);
  check("insured: medicaid basis expansion", out.eligibility.medicaid_basis === "expansion");
  check("insured: region 48", out.eligibility.region === "48");
  eqNum("insured: fpl_percent ~112.8", out.eligibility.fpl_percent, 112.8);

  // Recovery total must equal the sum of kept dollar impacts.
  const sumImpacts = out._rep.kept.reduce((a, f) => a + (f.dollar_impact || 0), 0);
  eqNum("insured: recovery == sum(kept impacts)", out.recovery.bill_savings, Math.round(sumImpacts * 100) / 100);
}

/* -------------------------------------------------------------------------
 * Scenario 2 — Uninsured low-income, bill only. Known-good: $1,122.00, 5 findings.
 * ----------------------------------------------------------------------- */
{
  const c = S.Case({
    patient_name: "Pat Lee", state: "IN",
    household_size: 3, annual_income: 22000.0,
    provider: "County General", uninsured: true,
    primary: S.Insurance(), supplemental: null,
  });
  const out = advise(c, SAMPLE_BILL, null);

  eqNum("uninsured: total_flagged == 1122.00", out.total_flagged, 1122.0);
  eqNum("uninsured: recovery.bill_savings == 1122.00", out.recovery.bill_savings, 1122.0);
  check("uninsured: 5 findings kept", out._rep.kept.length === 5, "got " + out._rep.kept.length);
  sameSet("uninsured: finding categories",
    out._rep.kept.map((f) => f.category),
    ["bill-total-mismatch", "duplicate-charge", "price-vs-reference", "price-vs-reference", "price-vs-reference"]);
  check("uninsured: likely FREE care", out.eligibility.free === true);
  check("uninsured: likely Medicaid", out.eligibility.medicaid === true);
  eqNum("uninsured: fpl_percent ~80.5", out.eligibility.fpl_percent, 80.5);
}

/* -------------------------------------------------------------------------
 * Scenario 3 — Clean bill. Known-good: no findings, total 0.
 * ----------------------------------------------------------------------- */
{
  const c = S.Case({
    patient_name: "Sam Doe", state: "IN", household_size: 2, annual_income: 120000.0,
    provider: "Clean Clinic", uninsured: false,
    primary: S.Insurance({ kind: "employer", network_status: "in" }), supplemental: null,
  });
  const out = advise(c, CLEAN_BILL, null);

  check("clean: 0 findings kept", out._rep.kept.length === 0, "got " + out._rep.kept.length);
  eqNum("clean: total_flagged == 0", out.total_flagged, 0.0);
  check("clean: recovery present", out.recovery && Array.isArray(out.recovery.avenues) && out.recovery.avenues.length >= 2);
  check("clean: not free / not medicaid", out.eligibility.free === false && out.eligibility.medicaid === false);
}

/* -------------------------------------------------------------------------
 * Scenario 4 — State-precise eligibility (the new layer).
 * 2026 HHS poverty guidelines: a household of 1 has DIFFERENT FPLs in the
 * 48 contiguous states ($15,960), Alaska ($19,950), and Hawaii ($18,360).
 * The same income therefore yields a different FPL % in each region.
 * ----------------------------------------------------------------------- */
{
  // federalPovertyLevel(householdSize, state) — region-specific base for household of 1.
  eqNum("FPL h1 48-state == 15960", S.federalPovertyLevel(1, "IN"), 15960.0);
  eqNum("FPL h1 Alaska == 19950", S.federalPovertyLevel(1, "AK"), 19950.0);
  eqNum("FPL h1 Hawaii == 18360", S.federalPovertyLevel(1, "HI"), 18360.0);

  // Same $20,000 income, household of 1: AK/HI guidelines are higher, so the
  // FPL percentage is LOWER there than in the 48 contiguous states.
  const pct48 = S.fplPercent(20000.0, 1, "IN");
  const pctAK = S.fplPercent(20000.0, 1, "AK");
  const pctHI = S.fplPercent(20000.0, 1, "HI");
  check("state-precise: 48-state pct > Hawaii pct > Alaska pct",
    pct48 > pctHI && pctHI > pctAK,
    "48=" + pct48 + " HI=" + pctHI + " AK=" + pctAK);
  eqNum("48-state pct(20k,h1) ~125.3", pct48, 125.3);
  eqNum("Alaska pct(20k,h1) ~100.3", pctAK, 100.3);
  eqNum("Hawaii pct(20k,h1) ~108.9", pctHI, 108.9);

  // Region label resolves correctly and is exposed on the eligibility screen.
  check("region label AK", S.fplRegion("ak") === "AK");
  check("region label HI", S.fplRegion("Hi") === "HI");
  check("region label 48 (IN)", S.fplRegion("IN") === "48");

  // Medicaid expansion vs non-expansion. IN expanded; TX did not (coverage gap).
  check("an expansion state (IN) resolves as expansion", S.isExpansionState("IN") === true);
  check("Texas is NOT an expansion state", S.isExpansionState("TX") === false);

  const inElig = S.eligibilityScreen(S.Case({ state: "IN", household_size: 1, annual_income: 18000.0 }));
  check("IN low income -> medicaid true (expansion)", inElig.likely_medicaid === true && inElig.medicaid_basis === "expansion");

  const txElig = S.eligibilityScreen(S.Case({ state: "TX", household_size: 1, annual_income: 18000.0 }));
  check("TX low income -> medicaid false, coverage-gap basis",
    txElig.likely_medicaid === false && txElig.medicaid_basis === "coverage-gap",
    "medicaid=" + txElig.likely_medicaid + " basis=" + txElig.medicaid_basis);
}

/* -------------------------------------------------------------------------
 * Scenario 5 — nationwide contacts (NO Indiana) + printable letters that say
 * exactly where to mail them. Uses a Texas patient to prove no state-specific
 * (Indiana) leakage reaches a user outside Indiana.
 * ----------------------------------------------------------------------- */
{
  const c = S.Case({
    patient_name: "Jordan Rivers", state: "TX", household_size: 1, annual_income: 18000.0,
    provider: "Memorial Hospital", uninsured: false,
    primary: S.Insurance({ kind: "employer", network_status: "in" }),
    supplemental: S.Insurance({ kind: "supplement" }),
  });
  const out = advise(c, SAMPLE_BILL, SAMPLE_EOB);

  // Printable letters exist and tell the reader exactly where to mail them.
  const letters = out.letters || [];
  check("letters: at least 2 generated", letters.length >= 2, "got " + letters.length);
  check("letters: every letter has a non-empty body", letters.every((l) => typeof l.body === "string" && l.body.length > 80));
  check("letters: tells the reader where to mail it",
    letters.some((l) => l.body.includes("Mail this to the billing address")));

  // Nationwide: nothing a user sees (steps, resources, letters) is Indiana-specific.
  const userVisible = JSON.stringify({ steps: out.steps, resources: out.resources, letters: out.letters });
  check("nationwide: no 'Indiana' shown to a user", !userVisible.includes("Indiana"));
  check("nationwide: no 'FSSA' shown to a user", !userVisible.includes("FSSA"));
  check("nationwide: a national Medicaid pointer is present",
    userVisible.includes("medicaid.gov") || userVisible.includes("Your state Medicaid"));
}

/* -------------------------------------------------------------------------
 * Scenario 6 — honest framing + parser fidelity (the "no false complaints" bar).
 *  (a) The offline engine has NO price benchmark, so a lone inflated charge yields
 *      0 structural findings. The headline must therefore NEVER imply the bill is
 *      fine: it must drop "we didn't spot a billing error", warn the price is not
 *      verified, and still point to a concrete action.
 *  (b) Real hospital "summary" bills list single-word departments (LABORATORY,
 *      RADIOLOGY). Those must parse; totals / "amount you owe" / short noise must not.
 * ----------------------------------------------------------------------- */
{
  // (a) honest framing on an error-free but overpriced bill
  const c = S.Case({
    patient_name: "Dana Cruz", state: "CA", household_size: 1, annual_income: 60000.0,
    provider: "Big Hospital", uninsured: false,
    primary: S.Insurance({ kind: "employer", network_status: "in" }), supplemental: null,
  });
  const over = advise(c, { bill_id: "OV", line_items: [
    { code: "70450", description: "CT head without contrast", qty: 1, unit_price: 6500.0, line_total: 6500.0 },
  ] }, null);
  check("honest: overpriced lone line has 0 structural findings", over._rep.kept.length === 0, "got " + over._rep.kept.length);
  check("honest: headline drops the falsely-reassuring 'didn't spot a billing error'",
    !/didn'?t spot a billing error/i.test(over.headline), over.headline.slice(0, 120));
  check("honest: headline warns the price is not verified",
    /does not mean the price is fair/i.test(over.headline), over.headline.slice(0, 220));
  check("honest: headline still points to a concrete action",
    /itemized|financial[- ]assistance|negotiat|lower it/i.test(over.headline));

  // (b) parser captures single-word department lines, drops totals/noise
  const sb = S.parseBillText(
    "PHARMACY - GENERAL CLASSIFICATION  2,863.17\n" +
    "MED/SURG SUPPLIES  1,840.00\n" +
    "LABORATORY  1,200.00\n" +
    "RADIOLOGY  1,100.00\n" +
    "EMERGENCY ROOM  996.83"
  );
  check("parser: all 5 summary lines parse", sb.line_items.length === 5, "got " + sb.line_items.length);
  const descs = sb.line_items.map((li) => li.description.toUpperCase()).join("|");
  check("parser: single-word departments captured (LABORATORY + RADIOLOGY)",
    /LABORATORY/.test(descs) && /RADIOLOGY/.test(descs), descs);

  const noisy = S.parseBillText(
    "Subtotal  4,000.00\nAmount you owe  9,000.00\nTax  12.00\nLABORATORY  1,200.00"
  );
  const ndescs = noisy.line_items.map((li) => li.description.toUpperCase());
  check("parser: keeps the real department line among noise", ndescs.some((d) => /LABORATORY/.test(d)), ndescs.join("|"));
  check("parser: still drops totals / 'amount you owe'",
    !ndescs.some((d) => /SUBTOTAL|AMOUNT YOU OWE/.test(d)), ndescs.join("|"));
}

/* -------------------------------------------------------------------------
 * Scenario 7 — shipped-file honesty guard. The engine-only tests above cannot
 * see copy baked into index.html's UI (e.g. the empty-findings card), so scan
 * BOTH shipped files: the false-reassurance phrases must be gone, and the honest
 * "the price may not be fair" caveat must be present in each.
 * ----------------------------------------------------------------------- */
{
  const indexHtml = readFileSync(join(HERE, "..", "index.html"), "utf-8");
  const files = [["engine/freemedassist_engine.js", engineSrc], ["index.html", indexHtml]];
  for (const [fname, src] of files) {
    check(fname + ": no 'spot a billing error' false reassurance", !/spot a billing error/i.test(src), fname);
    check(fname + ": no \"that's good news\" false reassurance", !/that'?s good news/i.test(src), fname);
    check(fname + ": carries the honest 'price may not be fair' caveat", /does not mean the price is fair/i.test(src), fname);
  }
}

/* -------------------------------------------------------------------------
 * Report.
 * ----------------------------------------------------------------------- */
if (failures.length === 0) {
  console.log("FreeMedAssist self-test PASSED: " + passed + " assertions across 7 scenario groups.");
  console.log("  - insured bill+EOB total $2,823.40 with expected categories");
  console.log("  - uninsured low-income $1,122.00");
  console.log("  - clean bill (no findings)");
  console.log("  - state-precise eligibility (AK vs HI vs 48-state) + recovery total");
  console.log("  - nationwide contacts (no Indiana) + printable letters with where-to-mail");
  console.log("  - honest framing on overpriced bills + summary-bill parser fidelity");
  console.log("  - shipped-file honesty guard (no false reassurance in engine OR index.html)");
  process.exit(0);
} else {
  console.error("FreeMedAssist self-test FAILED: " + failures.length + " of " + (passed + failures.length) + " assertions failed:");
  for (const f of failures) console.error("  X " + f);
  process.exit(1);
}
