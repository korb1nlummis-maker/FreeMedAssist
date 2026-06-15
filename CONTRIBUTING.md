# Contributing to FreeMedAssist

Thank you for helping people understand and fight their medical bills. The single
most valuable contribution is **keeping the help accurate** — the phone numbers,
the scripts, and the "what to say" wording that real people read aloud on the phone.

## The golden rule

> **Keep it accurate and cited. Never fabricate.**

Every phone number, program, deadline, and legal claim must be **real and verifiable**.
If you can't point to an official source (a government agency, a hospital policy, a
statute, or a reputable nonprofit), don't add it. When in doubt, leave it out — a
missing tip is far better than a wrong one, because people act on what FreeMedAssist tells them.

## What lives where

- **`data/medical_actions.json`** — the phone numbers, scripts ("say"), handling tips,
  and resources. **This is the file most contributions should touch.** It is designed
  to self-update: an accepted change here flows to everyone who uses the data layer.
- **`engine/freemedassist_engine.js`** — the deterministic rules (bill math, price checks,
  eligibility, rights). Changes here must keep the self-test green and stay rule-based
  (no AI, no network calls).
- **`index.html`** — the standalone app (the engine is inlined here verbatim). If you
  change the engine, the inlined copy must be updated to match.

## How to propose an update to a phone number, script, or resource

1. **Fork** the repository and create a branch.
2. **Edit `data/medical_actions.json`.** Match the existing shape:
   - `resources[]` entries have `key`, `name`, `phone` (and/or `url`), a plain-language
     `for`, and `free`. Add `state` (e.g. `"IN"`) for state-specific resources.
   - `playbooks` and `programs` entries have a `title`, a `call` list (who to contact),
     a `say` script (what to read aloud — placeholders like `[ACCOUNT]`, `[CODE]`,
     `[DESCRIPTION]`, `[AMOUNT]` are filled in automatically), and `handle` tips.
   - Bump the top-level `version` (a date works well) and keep the `disclaimer` honest.
3. **Cite your source** in the pull-request description — the official page or document
   you verified the number or rule against, and the date you checked it.
4. **Run the self-test** to make sure nothing broke:
   ```bash
   node engine/selftest.mjs
   ```
   It must print a PASS and exit 0.
5. **Open a pull request.** Describe what you changed and why, with your citation.

## Style

- Write scripts and tips at a **plain-reading level** — short sentences someone can read
  out loud while stressed. No jargon without explaining it.
- Be **honest about uncertainty**: say what someone *may* qualify for and how to find
  out. Never promise an outcome.
- Keep the tone calm, respectful, and on the patient's side.

## Things we will not accept

- Made-up or unverified phone numbers, deadlines, or legal claims.
- AI-generated advice presented as fact, or any feature that sends a user's bill data
  off their device without consent.
- Anything that pressures users to pay, buy, or sign up for something.

Thank you for keeping FreeMedAssist trustworthy. People rely on it.
