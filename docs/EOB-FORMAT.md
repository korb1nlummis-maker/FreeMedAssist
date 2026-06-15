# EOB format (Explanation of Benefits)

An **EOB** is the *insurer's* side of a medical encounter: what the provider billed, what the plan
allowed, what the plan paid, and what **you** actually owe. FreeMedAssist cross-checks the hospital **bill**
(see `BILL-FORMAT.md`) against the EOB to catch the errors that hit *insured* patients hardest —
balance billing, out-of-network surprise billing, claims never filed, and copay mistakes.

`BILL-FORMAT.md` describes the **bill** (provider charges). This file describes the **EOB**
(insurer adjudication). They are different documents; FreeMedAssist reconciles one against the other.

## Shape

```json
{
  "eob_id": "EOB-MH-0042",
  "insurer": "Anthem Blue Cross Blue Shield",
  "plan_name": "PPO",
  "claim_id": "CLM-99812",
  "bill_id": "MH-2026-0042",
  "lines": [
    {
      "service_date": "2026-05-12",
      "code": "80053",
      "description": "Comprehensive metabolic panel",
      "billed": 210.00,
      "allowed": 14.00,
      "plan_paid": 11.20,
      "copay": 0.00,
      "coinsurance": 2.80,
      "deductible": 0.00,
      "patient_responsibility": 2.80,
      "network_status": "in"
    }
  ]
}
```

## Per-line fields

| field | meaning |
|---|---|
| `service_date` | `YYYY-MM-DD`; used (with `code`) to match the EOB line to a bill line |
| `code` | CPT/HCPCS code, same namespace as the bill (the primary match key) |
| `description` | plain description (for display + fallback matching) |
| `billed` | what the provider charged the insurer (should equal the bill's `line_total`) |
| `allowed` | the insurer-allowed amount after the network discount |
| `plan_paid` | what the insurer paid |
| `copay` / `coinsurance` / `deductible` | the parts of your share |
| `patient_responsibility` | **what you legitimately owe for this line** — the number the bill is checked against |
| `network_status` | `"in"` or `"out"` — how the insurer processed it (drives surprise-billing checks) |

All dollar fields are coerced tolerantly (`"$1,234.50"` → `1234.5`); a missing field is `null`,
**not** `0` (so "not provided" is never confused with "$0").

## Free-text (OCR) parsing

`eob_text.parse_eob_text(text)` is a best-effort parser for browser-OCR'd EOBs. EOB column order
varies by insurer; it assumes the common layout **Billed · Allowed · Plan Paid · Your
Responsibility** and always takes the **last** amount on a line as `patient_responsibility`. The
patient confirms the parsed numbers before any audit — the reliable path is the guided form.

## How FreeMedAssist uses it

`eob_watch.ingest_eob_data(eob)` turns each line into a `SourceRecord` with
`structured.kind = "eob-line"`. When any EOB records are present, `advocate.build_report`
composes `RuleBasedEobJudge` with the bill judge, emitting findings:
`balance-billing-possible`, `network-status-mismatch`, `eob-line-missing`, `copay-mismatch`,
`coordination-failure` — each with an action-plan playbook in `data/medical_actions.json`.
