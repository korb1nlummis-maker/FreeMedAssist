# FreeMedAssist — a free second opinion on your medical bill

**FreeMedAssist reads a medical bill and tells you, in plain language, three things:**

1. **What looks wrong** — duplicate charges, math errors, prices far above typical, services your insurance already discounted, surprise out-of-network bills, and more.
2. **The money you may get back or never owed** — charity care that can erase a hospital bill, Medicaid (which can even pay bills from the *past*), and tax help that puts money in your pocket.
3. **Exactly who to call and what to say** — real phone numbers, ready-to-send letters, and word-for-word scripts.

It is **free**, needs **no account**, uses **no AI**, and for a typed or pasted bill it works **completely offline** — nothing you type ever leaves your device.

> **One sentence:** Open the page, type or paste your bill, and FreeMedAssist shows you the errors, the money you may qualify for, and who to call — for free, with no login and no AI.

---

## Two versions

FreeMedAssist comes in two forms — pick whichever fits:

| | **`index.html`** — no-login | **`app.html`** — sign-in |
|---|---|---|
| Who it's for | Anyone — share the link with everyone | People who want to **save their bills** and come back to them |
| Sign-in | None | Username + password, **encrypted on your own device** |
| Where your data lives | Only in the page while it's open | Saved bills are **AES-GCM encrypted in your browser** — nothing uploaded, no server |
| Works by double-click (`file://`) | ✅ Yes | ❌ No — needs a hosted link (browsers only allow secure storage over https/localhost) |
| Engine and results | Identical | Identical |

Both run the **same deterministic engine** (no AI). The sign-in version is *generated from* the no-login one by [`build_signin.mjs`](build_signin.mjs), so the two never drift apart:

```bash
node build_signin.mjs      # regenerates app.html from index.html
```

Its privacy is real, not a login screen for show: your password derives a key (**PBKDF2**) that **encrypts your saved bills** (**AES-GCM**) in your browser's local storage. There is **no server and no password reset** — if you forget your password, the saved data can't be recovered, and nothing was ever uploaded to lose.

---

## Who FreeMedAssist is for

**Anyone with a medical bill** — but it was built especially for the people bills hit hardest:

- People who are **uninsured** or paying cash
- People with **low income** who may qualify for free or discounted care and don't know it
- **Elderly** patients and their family members sorting through confusing statements
- Anyone who got a **"surprise" bill**, a bill bigger than their insurance said they'd owe, or a bill that just doesn't add up

You do **not** need to be tech-savvy, have a lawyer, or pay anyone. If you can open a web page, you can use FreeMedAssist.

---

## How to use it

**The easiest way:** download this folder and **double-click `index.html`**. It opens in your web browser and runs right there on your computer. That's it — no install, no sign-up, no internet required for a typed or pasted bill.

Then:

1. **Enter your bill** — type it, paste it, or (optionally) take a photo. For typed or pasted bills everything stays on your device.
2. **Answer a few simple questions** — your state, household size, rough yearly income, and whether you have insurance. These unlock the "money you may qualify for" checks. You can skip them.
3. **Read your second opinion** — the problems found, the money you may get back, the legal protections on your side, and a step-by-step action plan with phone numbers, scripts, and printable letters.

> **A note on the optional photo reader:** typing or pasting a bill is 100% offline. If you choose to read a *photo* of a bill, the page loads a text-recognition tool from the internet the first time — and if the photo is too blurry to read accurately, **FreeMedAssist tells you so instead of guessing.** It will never pretend a bill is "clean" when it couldn't actually read it.

---

## The money it can get back

A medical bill is rarely the final word. FreeMedAssist looks for money in several places:

- **Billing errors you can dispute** — duplicates, math mistakes, and overcharges that come straight off the bill.
- **Charity care (financial assistance)** — nonprofit hospitals are *required by law* to offer it, and it can reduce or **completely erase** a qualifying bill. Most hospitals won't offer it unless you ask.
- **Medicaid** — if your income qualifies, it can pay the bill, and in many states it covers bills from **up to 3 months before you applied**.
- **Tax money you're owed** — free tax help (VITA) can claim refundable credits like the **Earned Income Tax Credit (EITC)**, sometimes a few thousand dollars, and check whether large medical costs are deductible.
- **Going-forward coverage** — if you're uninsured, subsidized Marketplace plans can cost as little as $0–$10/month, protecting you from the next bill.

FreeMedAssist always frames this honestly: it says what you *may* qualify for and tells you exactly how to find out — it never promises a result.

---

## How it works (no AI)

FreeMedAssist is **deterministic**: the same bill always produces the same answer, and you could check every step by hand. There is **no AI, no machine learning, and no guessing.**

- A set of **plain, auditable rules** checks the math and the prices on each line (the rules live in [`engine/freemedassist_engine.js`](engine/freemedassist_engine.js)).
- The eligibility checks use the **official 2026 federal poverty guidelines** — and they're **state-precise**: Alaska and Hawaii have their own (higher) guidelines, and Medicaid expansion status is handled state by state.
- The phone numbers, scripts, and letters come from a **cited reference file**, [`data/medical_actions.json`](data/medical_actions.json), so anyone can see and improve the sources.

### Cited sources

- **Federal Poverty Level** — HHS ASPE / annual Poverty Guidelines
- **Medicaid expansion status** — KFF, *Status of State Medicaid Expansion Decisions*
- **Tax help & credits** — IRS Topic No. 502 (medical expense deduction), IRS VITA (free tax prep), IRS EITC
- **Surprise-billing protections** — CMS / No Surprises Act (CMS No Surprises Help Desk 1-800-985-3059)

---

## Run the self-test

The engine ships with a self-contained test (no Python, no internet) that confirms the known-good outputs still hold:

```bash
node engine/selftest.mjs      # the engine: 55 assertions across 7 scenario groups
node engine/signin_test.mjs   # the sign-in version: structure + a real WebCrypto round-trip
```

The engine test checks the canonical scenarios — the **insured bill + EOB totaling $2,823.40** with the expected finding categories, the **uninsured low-income** bill, and a **clean bill** — plus **state-precise eligibility** (Alaska vs Hawaii vs the 48 contiguous states), the **recovery total**, **honest framing** (an error-free bill is never called "fairly priced"), and a guard that scans the shipped files for any false-reassurance wording. The sign-in test confirms `app.html` carries the auth layer + engine and that the encryption genuinely round-trips (right password decrypts, wrong password fails). Both **exit 0** on success.

> You only need [Node.js](https://nodejs.org) to run the test. You do **not** need Node to *use* FreeMedAssist — the app itself runs in any browser.

---

## Deploy it free on GitHub Pages

You can host FreeMedAssist for free so anyone can use it from a link:

1. Create a new repository on GitHub and upload these files (or push this repo).
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, pick your `main` branch and the `/ (root)` folder, and **Save**.
4. Wait a minute, then share the link GitHub gives you (it looks like `https://yourname.github.io/FreeMedAssist/`).

Because `index.html` is the verified standalone app at the repo root (and a `.nojekyll` file tells GitHub to serve everything as-is), the site *is* the app — no build step. The sign-in version is then at `https://yourname.github.io/FreeMedAssist/app.html`.

---

## How to contribute

The most valuable help is **keeping the phone numbers, scripts, and "what to say" wording accurate**. All of that lives in one file: [`data/medical_actions.json`](data/medical_actions.json).

To improve it, open a **pull request** that edits that file — fix a phone number, add a state resource, or sharpen a script. See [CONTRIBUTING.md](CONTRIBUTING.md) for the format and the golden rule: **keep it accurate and cited, and never fabricate.** The data layer is designed to self-update, so an accepted fix can reach everyone.

---

## Disclaimer

FreeMedAssist provides **general consumer guidance to help you ask better questions — it is not legal, financial, tax, or medical advice.** It does not represent any government agency, hospital, or insurer.

- **Always verify the numbers** against your own itemized bill, your insurance Explanation of Benefits (EOB), and the official sources cited above.
- Phone numbers and program rules change; **confirm them before relying on them.** Eligibility for Medicaid, charity care, and tax credits depends on your specific situation and varies by state.
- FreeMedAssist points you to official resources (HHS poverty guidelines, KFF Medicaid data, IRS Topic 502 / VITA / EITC, and the CMS No Surprises Act help desk). When in doubt, contact those sources or a qualified professional directly.

---

## License

[MIT](LICENSE) — free to use, modify, and share.
