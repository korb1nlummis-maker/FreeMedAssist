# Sticking a medical bill in

FreeMedAssist audits an itemized bill given as JSON. Copy `bill_template.json`, fill it from your
**itemized** statement (the line-by-line one, not the summary), and run:

```
python freemedassist.py audit my_bill.json
```

## Fields
- `bill_id`, `provider`, `service_date` — labels only (free text / `YYYY-MM-DD`).
- `stated_total` — the total the bill claims; FreeMedAssist checks it against the sum of the lines.
- `line_items[]`:
  - `code` — the CPT/HCPCS code on the line (e.g. `99284`, `J1885`). HCPCS codes (a letter + 4
    digits, like `J1885`) are validated **live** against the official NLM reference to catch miscoding.
  - `description` — what the line says it is.
  - `qty`, `unit_price`, `line_total` — the numbers exactly as printed.
  - `reference_price` — *optional*: a typical / Medicare unit price if you know it, so overcharges
    get flagged. Leave `null` if unknown.

## What it checks
- Duplicate charges, implausible quantities, line math (`qty × unit ≠ total`), total mismatch.
- Price vs. your `reference_price`.
- **Code/description mismatch** against the official HCPCS reference (e.g. a drug billed under the
  wrong J-code — a common way an overcharge hides).
- With an LLM provider, also upcoding, unbundling, and subtler issues.

## Providers
`--provider rule` (free, no LLM) · `ollama` (free local) · `max-plan` (Claude subscription, no key) ·
`api-key` (Anthropic API). Add `--no-lookup` to skip the live code validation (fully offline).
