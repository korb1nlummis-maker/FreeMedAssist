/* FreeMedAssist medical-bill engine — PLAIN-JS faithful port of the Python engine in
 * freemedassist/feeds/medical/*. NO import/export, NO modules, NO fetch,
 * NO Node-only APIs. Exposes ONE global: globalThis.FreeMedAssistEngine.
 *
 * Runs unchanged in a browser <script> from file:// AND loadable in Node via
 * fs.readFileSync + (0,eval)/new Function for testing.
 *
 * OFFLINE SCOPE (mirrors the live engine's graceful skips):
 *   Supported offline:
 *     bill: line-math-error, price-vs-reference, duplicate-charge, unbundling,
 *           quantity-anomaly, bill-total-mismatch, summary-bill-not-itemized
 *     eob:  balance-billing-possible, network-status-mismatch, eob-line-missing,
 *           copay-mismatch, coordination-failure
 *     eligibility (FPL charity/Medicaid), rights/protections, action plan, letters
 *   Dropped offline (require network enrichment that does not exist here):
 *     above-medicare-benchmark (needs live CMS Medicare-allowed pricing)
 *     code-description-mismatch (needs NLM official code descriptions)
 *   Both already skip lines lacking medicare_allowed / official_description in the
 *   Python rule_judge, so passing un-enriched records reproduces the live offline result.
 *   For charity-care, provider_nonprofit is treated as unknown (rights surfaces
 *   charity-care-501r whenever nonprofit is not explicitly False).
 */
(function (root) {
  "use strict";

  /* ---------------------------------------------------------------------------
   * Python-compatible numeric helpers
   * ------------------------------------------------------------------------- */

  // Python 3 round(): banker's rounding (round-half-to-even) on the decimal value.
  // We mirror it closely enough for the cents-level math the engine performs.
  function pyRound(value, ndigits) {
    if (value === null || value === undefined) return value;
    if (ndigits === undefined) ndigits = 0;
    if (!isFinite(value)) return value;
    var m = Math.pow(10, ndigits);
    var x = value * m;
    var floor = Math.floor(x);
    var diff = x - floor;
    var rounded;
    var EPS = 1e-9;
    if (Math.abs(diff - 0.5) < EPS) {
      // half: round to even
      rounded = (floor % 2 === 0) ? floor : floor + 1;
    } else {
      rounded = Math.round(x);
    }
    var result = rounded / m;
    // normalize -0
    if (result === 0) result = 0;
    return result;
  }

  // Python f"{x:,.2f}" / f"{x:,.0f}" — thousands-separated fixed-point.
  // Python's float __format__ rounds half-to-even (same as round()), NOT half-away-from-zero
  // like JS toFixed. We round with pyRound first so e.g. f"{80.5:.0f}" == "80", not "81".
  function fmtMoney(x, decimals) {
    if (decimals === undefined) decimals = 2;
    var rounded = pyRound(x, decimals);
    var neg = rounded < 0;
    var v = Math.abs(rounded);
    // After pyRound the value is already at the target precision; toFixed only zero-pads now.
    var s = v.toFixed(decimals);
    var parts = s.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    var out = parts.join(".");
    return (neg ? "-" : "") + out;
  }

  /* ---------------------------------------------------------------------------
   * jsonout.to_float_or_none
   * ------------------------------------------------------------------------- */
  function toFloatOrNone(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "boolean") return null; // isinstance(value, bool) excluded in Python
    if (typeof value === "number") {
      if (!isFinite(value)) return null;
      return value;
    }
    var s = String(value).replace(/\$/g, "").replace(/,/g, "").trim();
    if (!s) return null;
    var low = s.toLowerCase();
    if (low === "null" || low === "none" || low === "n/a" || low === "na") return null;
    var f = Number(s);
    if (isNaN(f) || !isFinite(f)) return null;
    return f;
  }

  /* ---------------------------------------------------------------------------
   * schema: Severity
   * ------------------------------------------------------------------------- */
  var Severity = { TRIVIAL: 0, LOW: 1, MODERATE: 2, HIGH: 3, CRITICAL: 4 };
  var SEV_NAME = { 0: "trivial", 1: "low", 2: "moderate", 3: "high", 4: "critical" };

  // SourceRecord/Finding are plain objects here. structured defaults to {}.

  /* ---------------------------------------------------------------------------
   * bill_text.parse_bill_text  &  eob_text.parse_eob_text
   * ------------------------------------------------------------------------- */
  var RE_CODE = /\b([A-Z]\d{4}|\d{5})\b/;
  // _MONEY: ordered alternation matters (longest/most-specific first), global to findall.
  var MONEY_SRC = "\\$\\s?\\d[\\d,]*(?:\\.\\d{2})?|\\d{1,3}(?:,\\d{3})+(?:\\.\\d{2})?|\\d+\\.\\d{2}";
  function newMoneyRe() { return new RegExp(MONEY_SRC, "g"); }
  var RE_SKIP = /\b(total|subtotal|balance|amount\s+you\s+owe|you\s+owe|statement|account|patient|insurance|admit|discharge|payments?|adjustments?|charges|facility|primary|secondary|page|previous|deposit)\b/i;

  function moneyVal(token) {
    return parseFloat(token.replace(/\$/g, "").replace(/,/g, "").replace(/ /g, ""));
  }

  function findAllMoney(line) {
    var re = newMoneyRe();
    var out = [];
    var m;
    while ((m = re.exec(line)) !== null) {
      out.push(m[0]);
      if (m.index === re.lastIndex) re.lastIndex++; // guard zero-width (shouldn't happen)
    }
    return out;
  }

  function reSubMoney(line, repl) {
    return line.replace(newMoneyRe(), repl);
  }

  // Python re.findall(r"[A-Za-z]{3,}", s) count
  function countWords3(s) {
    var m = s.match(/[A-Za-z]{3,}/g);
    return m ? m.length : 0;
  }

  function pyStripChars(s, chars) {
    // strip leading/trailing chars in the set `chars`
    var start = 0, end = s.length;
    while (start < end && chars.indexOf(s[start]) !== -1) start++;
    while (end > start && chars.indexOf(s[end - 1]) !== -1) end--;
    return s.slice(start, end);
  }

  function parseBillText(text) {
    var items = [];
    var lines = (text || "").split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      var tokens = findAllMoney(line);
      if (tokens.length === 0) continue;
      var amounts = tokens.map(moneyVal);
      var withoutMoney = reSubMoney(line, " ");
      var m = RE_CODE.exec(withoutMoney);
      var code = m ? m[1] : "";
      var desc;
      if (m) {
        desc = withoutMoney.slice(0, m.index) + " " + withoutMoney.slice(m.index + m[0].length);
      } else {
        desc = withoutMoney;
      }
      desc = desc.replace(/\s+/g, " ");
      desc = pyStripChars(desc, " -:|\t.");
      desc = desc.replace(/^\d+\s+/, "");
      desc = desc.trim();
      if (!code) {
        if (RE_SKIP.test(desc)) continue;
        // Keep a line with two descriptive words, OR a single long department word
        // (LABORATORY, RADIOLOGY, PHARMACY) — still drops short noise (Tax, Fee, Due).
        if (countWords3(desc) < 2 && !/[A-Za-z]{5,}/.test(desc)) continue;
      }
      var total = amounts[amounts.length - 1];
      var unit = total, qty = 1;
      if (amounts.length >= 2 && amounts[0] > 0) {
        var ratio = total / amounts[0];
        if (Math.abs(ratio - Math.round(ratio)) < 0.01 && Math.round(ratio) >= 1) {
          unit = amounts[0];
          qty = Math.round(ratio);
        }
      }
      items.push({
        code: code, description: desc, qty: qty,
        unit_price: pyRound(unit, 2), line_total: pyRound(total, 2)
      });
    }
    return { provider: "", line_items: items };
  }

  function parseEobText(text) {
    var lines = [];
    var rows = (text || "").split(/\r\n|\r|\n/);
    for (var i = 0; i < rows.length; i++) {
      var line = rows[i].trim();
      var tokens = findAllMoney(line);
      if (tokens.length < 2) continue;
      var amounts = tokens.map(moneyVal);
      var withoutMoney = reSubMoney(line, " ");
      var m = RE_CODE.exec(withoutMoney);
      var code = m ? m[1] : "";
      var desc;
      if (m) {
        desc = withoutMoney.slice(0, m.index) + " " + withoutMoney.slice(m.index + m[0].length);
      } else {
        desc = withoutMoney;
      }
      desc = desc.replace(/\s+/g, " ");
      desc = pyStripChars(desc, " -:|\t.");
      desc = desc.replace(/^\d+\s+/, "");
      desc = desc.trim();
      if (!code) {
        if (RE_SKIP.test(desc)) continue;
        // Keep a line with two descriptive words, OR a single long department word
        // (LABORATORY, RADIOLOGY, PHARMACY) — still drops short noise (Tax, Fee, Due).
        if (countWords3(desc) < 2 && !/[A-Za-z]{5,}/.test(desc)) continue;
      }
      var billed = amounts[0];
      var patientResponsibility = amounts[amounts.length - 1];
      var allowed = amounts.length >= 3 ? amounts[1] : null;
      var planPaid = amounts.length >= 4 ? amounts[2] : null;
      lines.push({
        code: code, description: desc,
        billed: pyRound(billed, 2),
        allowed: allowed !== null ? pyRound(allowed, 2) : null,
        plan_paid: planPaid !== null ? pyRound(planPaid, 2) : null,
        patient_responsibility: pyRound(patientResponsibility, 2),
        network_status: ""
      });
    }
    return { insurer: "", lines: lines };
  }

  /* ---------------------------------------------------------------------------
   * watch.ingest_bill_data  &  eob_watch.ingest_eob_data
   * ------------------------------------------------------------------------- */
  function safeDate(value) {
    // Python datetime.strptime(value, "%Y-%m-%d").date(); else None.
    if (!value) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
    if (!m) return null;
    return String(value); // we keep the ISO string; advocate doesn't read occurred_on for parity
  }

  function numOr(value, def) {
    var c = toFloatOrNone(value);
    return c !== null ? c : def;
  }

  function ingestBillData(data) {
    data = data || {};
    var billId = String(data.bill_id !== undefined && data.bill_id !== null ? data.bill_id : "BILL");
    var provider = data.provider !== undefined ? data.provider : "Unknown provider";
    var source = provider + " — bill " + billId;
    var occurred = safeDate(data.service_date);

    var records = [];
    var lineItems = data.line_items || [];
    for (var i = 0; i < lineItems.length; i++) {
      var li = lineItems[i];
      var struct = {};
      for (var k in li) { if (Object.prototype.hasOwnProperty.call(li, k)) struct[k] = li[k]; }
      struct.kind = "line";
      struct.qty = Math.trunc(numOr(li.qty, 1));
      struct.unit_price = numOr(li.unit_price, 0.0);
      struct.line_total = numOr(li.line_total, 0.0);
      if (li.reference_price !== undefined && li.reference_price !== null) {
        struct.reference_price = toFloatOrNone(li.reference_price);
      }
      records.push({
        feed: "medical", source: source,
        record_id: billId + ":L" + (i + 1),
        raw_text: String(li.description !== undefined && li.description !== null ? li.description : ""),
        structured: struct, occurred_on: occurred, url: null
      });
    }
    records.push({
      feed: "medical", source: source,
      record_id: billId + ":SUMMARY",
      raw_text: "bill total",
      structured: {
        kind: "summary",
        stated_total: toFloatOrNone(data.stated_total),
        provider: provider,
        bill_id: billId
      },
      occurred_on: occurred, url: null
    });
    return records;
  }

  var EOB_MONEY_FIELDS = ["billed", "allowed", "plan_paid", "copay", "coinsurance", "deductible", "patient_responsibility"];

  function ingestEobData(data) {
    data = data || {};
    var eobId = String(data.eob_id !== undefined && data.eob_id !== null ? data.eob_id : "EOB");
    var insurer = data.insurer !== undefined ? data.insurer : "Unknown insurer";
    var source = insurer + " — EOB " + eobId;

    var records = [];
    var ls = data.lines || [];
    for (var i = 0; i < ls.length; i++) {
      var li = ls[i];
      var struct = {};
      for (var k in li) { if (Object.prototype.hasOwnProperty.call(li, k)) struct[k] = li[k]; }
      struct.kind = "eob-line";
      struct.code = String(li.code !== undefined && li.code !== null ? li.code : "").trim();
      for (var j = 0; j < EOB_MONEY_FIELDS.length; j++) {
        var fld = EOB_MONEY_FIELDS[j];
        struct[fld] = toFloatOrNone(li[fld]);
      }
      struct.network_status = String(li.network_status || "").trim().toLowerCase();
      records.push({
        feed: "medical", source: source,
        record_id: eobId + ":E" + (i + 1),
        raw_text: String(li.description !== undefined && li.description !== null ? li.description : ""),
        structured: struct,
        occurred_on: safeDate(li.service_date), url: null
      });
    }
    records.push({
      feed: "medical", source: source,
      record_id: eobId + ":EOBSUMMARY",
      raw_text: "EOB totals",
      structured: {
        kind: "eob-summary",
        insurer: insurer,
        eob_id: eobId,
        plan_name: data.plan_name !== undefined ? data.plan_name : "",
        claim_id: data.claim_id !== undefined ? data.claim_id : "",
        bill_id: data.bill_id !== undefined ? data.bill_id : ""
      },
      occurred_on: null, url: null
    });
    return records;
  }

  /* ---------------------------------------------------------------------------
   * rule_judge.RuleBasedMedicalJudge
   * ------------------------------------------------------------------------- */
  var REF_MULT = 1.5;
  var MEDICARE_MULT = 4.0;
  var QTY_SANITY_MAX = 24;

  var BUNDLES = {
    "80053": ["82947", "84520", "82565", "82310", "84295", "84132",
              "82435", "82374", "84155", "82040", "82247", "84075", "84450", "84460"],
    "80048": ["82947", "84520", "82565", "82310", "84295", "84132", "82435", "82374"],
    "85025": ["85027", "85004"]
  };

  function severityFor(dollars) {
    if (dollars >= 1000) return Severity.CRITICAL;
    if (dollars >= 300) return Severity.HIGH;
    if (dollars >= 75) return Severity.MODERATE;
    if (dollars >= 10) return Severity.LOW;
    return Severity.TRIVIAL;
  }

  function mkFinding(o) {
    // defaults mirror the dataclass
    return {
      record_id: o.record_id,
      flagged: o.flagged,
      category: o.category,
      summary: o.summary,
      severity: o.severity,
      confidence: o.confidence,
      recommended_action: o.recommended_action,
      evidence: o.evidence !== undefined ? o.evidence : "",
      dollar_impact: o.dollar_impact !== undefined ? o.dollar_impact : null,
      deadline: o.deadline !== undefined ? o.deadline : null,
      dedupe_key: o.dedupe_key !== undefined ? o.dedupe_key : null
    };
  }

  function structGet(r, key, def) {
    var v = r.structured ? r.structured[key] : undefined;
    return v !== undefined ? v : (def !== undefined ? def : undefined);
  }

  var RuleBasedMedicalJudge = {
    assess: function (records) {
      var lines = records.filter(function (r) { return structGet(r, "kind") === "line"; });
      var findings = [];
      findings = findings.concat(this._line_math(lines));
      findings = findings.concat(this._reference_overage(lines));
      findings = findings.concat(this._medicare_benchmark(lines));
      findings = findings.concat(this._duplicates(lines));
      findings = findings.concat(this._unbundling(lines));
      findings = findings.concat(this._quantity_sanity(lines));
      findings = findings.concat(this._code_mismatch(lines));
      findings = findings.concat(this._total_reconciliation(records, lines));
      findings = findings.concat(this._summary_bill(records, lines));
      return findings;
    },

    _summary_bill: function (records, lines) {
      if (lines.length < 5) return [];
      var codeless = lines.filter(function (r) {
        return !String(structGet(r, "code", "")).trim();
      });
      if (codeless.length < 0.7 * lines.length) return [];
      var sum = 0;
      for (var i = 0; i < lines.length; i++) sum += (structGet(lines[i], "line_total") || 0);
      var total = pyRound(sum, 2);
      var summary = null;
      for (var j = 0; j < records.length; j++) {
        if (structGet(records[j], "kind") === "summary") { summary = records[j]; break; }
      }
      var recordId = summary ? summary.record_id : "SUMMARY";
      return [mkFinding({
        record_id: recordId, flagged: true, category: "summary-bill-not-itemized",
        summary: "This looks like a SUMMARY bill — charges lumped into department categories, not an " +
          "itemized list. Overcharges, duplicate items, and services you never got hide in these " +
          "big category totals.",
        severity: Severity.HIGH, confidence: 0.8,
        recommended_action: "Request a FULLY ITEMIZED bill (every code, drug, and supply with its own " +
          "price) before paying — you have the right to one — then check that here.",
        evidence: codeless.length + " of " + lines.length + " lines have no procedure code; charges total about $" + fmtMoney(total, 2),
        dollar_impact: null
      })];
    },

    _line_math: function (lines) {
      var out = [];
      for (var i = 0; i < lines.length; i++) {
        var r = lines[i], s = r.structured;
        var expected = pyRound(s.qty * s.unit_price, 2);
        var billed = pyRound(s.line_total, 2);
        var diff = pyRound(Math.abs(expected - billed), 2);
        if (diff > 0.005) {
          out.push(mkFinding({
            record_id: r.record_id, flagged: true, category: "line-math-error",
            summary: r.raw_text + ": quantity × unit price does not equal the billed line total.",
            severity: severityFor(diff), confidence: 0.9,
            recommended_action: "Ask the provider for a corrected itemized line.",
            evidence: s.qty + " × $" + s.unit_price.toFixed(2) + " = $" + expected.toFixed(2) + ", billed $" + billed.toFixed(2),
            dollar_impact: diff
          }));
        }
      }
      return out;
    },

    _reference_overage: function (lines) {
      var out = [];
      for (var i = 0; i < lines.length; i++) {
        var r = lines[i], s = r.structured;
        var ref = s.reference_price;
        if (ref && s.unit_price > ref * REF_MULT) {
          var impact = pyRound((s.unit_price - ref) * s.qty, 2);
          out.push(mkFinding({
            record_id: r.record_id, flagged: true, category: "price-vs-reference",
            summary: r.raw_text + ": unit price $" + s.unit_price.toFixed(2) + " is well above a typical $" + ref.toFixed(2) + ".",
            severity: severityFor(impact), confidence: 0.7,
            recommended_action: "Request a price justification or the self-pay / Medicare rate.",
            evidence: "billed $" + s.unit_price.toFixed(2) + "/unit vs reference $" + ref.toFixed(2) + "/unit",
            dollar_impact: impact
          }));
        }
      }
      return out;
    },

    _medicare_benchmark: function (lines) {
      // Offline: medicare_allowed is never present (no live CMS pricing), so this never fires.
      var out = [];
      for (var i = 0; i < lines.length; i++) {
        var r = lines[i], s = r.structured;
        var allowed = s.medicare_allowed;
        if (!allowed || allowed <= 0 || s.reference_price) continue;
        var unit = s.unit_price !== undefined ? s.unit_price : 0.0;
        if (unit >= allowed * MEDICARE_MULT) {
          var mult = unit / allowed;
          var qty = s.qty !== undefined ? s.qty : 1;
          var impact = pyRound((unit - allowed) * qty, 2);
          var geo = s.medicare_geo !== undefined ? s.medicare_geo : "your area";
          out.push(mkFinding({
            record_id: r.record_id, flagged: true, category: "above-medicare-benchmark",
            summary: r.raw_text + ": billed $" + fmtMoney(unit, 2) + "/unit — about " + fmtMoney(mult, 0) +
              "× the Medicare-allowed $" + fmtMoney(allowed, 2) + " in " + geo + ".",
            severity: severityFor(impact), confidence: 0.65,
            recommended_action: "Ask for the cash/self-pay or Medicare rate; charges many times the " +
              "Medicare benchmark are often negotiable.",
            evidence: "billed $" + fmtMoney(unit, 2) + "/unit vs Medicare-allowed $" + fmtMoney(allowed, 2) +
              "/unit in " + geo + " (~" + fmtMoney(mult, 0) + "x)",
            dollar_impact: impact,
            dedupe_key: "medicare:" + r.record_id
          }));
        }
      }
      return out;
    },

    _duplicates: function (lines) {
      var out = [];
      var seen = {}; // key -> record_id
      for (var i = 0; i < lines.length; i++) {
        var r = lines[i], s = r.structured;
        var key = JSON.stringify([s.code !== undefined ? s.code : null, r.raw_text, pyRound(s.unit_price, 2)]);
        if (Object.prototype.hasOwnProperty.call(seen, key)) {
          out.push(mkFinding({
            record_id: r.record_id, flagged: true, category: "duplicate-charge",
            summary: r.raw_text + ": appears to be billed more than once.",
            severity: severityFor(s.line_total), confidence: 0.95,
            recommended_action: "Ask the provider to remove the duplicate line.",
            evidence: "identical to line " + seen[key] + " (code " + (s.code !== undefined ? s.code : "undefined") + ", $" + s.unit_price.toFixed(2) + ")",
            dollar_impact: pyRound(s.line_total, 2),
            dedupe_key: "dup:" + r.record_id
          }));
        } else {
          seen[key] = r.record_id;
        }
      }
      return out;
    },

    _unbundling: function (lines) {
      var codesPresent = {};
      for (var i = 0; i < lines.length; i++) {
        var c = structGet(lines[i], "code");
        codesPresent[c === undefined ? "__undef__" : c] = true;
      }
      var out = [];
      for (var k = 0; k < lines.length; k++) {
        var r = lines[k];
        var code = structGet(r, "code");
        var panel = null;
        for (var p in BUNDLES) {
          if (!Object.prototype.hasOwnProperty.call(BUNDLES, p)) continue;
          var inPresent = Object.prototype.hasOwnProperty.call(codesPresent, p);
          if (inPresent && BUNDLES[p].indexOf(code) !== -1) { panel = p; break; }
        }
        if (panel !== null) {
          var impact = pyRound(r.structured.line_total, 2);
          out.push(mkFinding({
            record_id: r.record_id, flagged: true, category: "unbundling",
            summary: r.raw_text + ": billed separately though panel " + panel + " (which includes it) is also billed.",
            severity: severityFor(impact), confidence: 0.65,
            recommended_action: "Ask whether this is already included in the panel and should be removed.",
            evidence: "code " + code + " is a component of panel " + panel,
            dollar_impact: impact
          }));
        }
      }
      return out;
    },

    _quantity_sanity: function (lines) {
      var out = [];
      for (var i = 0; i < lines.length; i++) {
        var r = lines[i];
        var qty = structGet(r, "qty", 0);
        if (qty > QTY_SANITY_MAX) {
          out.push(mkFinding({
            record_id: r.record_id, flagged: true, category: "quantity-anomaly",
            summary: r.raw_text + ": quantity " + qty + " is implausibly high for a single bill.",
            severity: Severity.HIGH, confidence: 0.6,
            recommended_action: "Confirm the units billed; a misplaced quantity can multiply a charge.",
            evidence: "billed quantity = " + qty,
            dollar_impact: null
          }));
        }
      }
      return out;
    },

    _code_mismatch: function (lines) {
      // Offline: official_description never present (no NLM enrichment), so this never fires.
      var out = [];
      for (var i = 0; i < lines.length; i++) {
        var r = lines[i], s = r.structured;
        var official = s.official_description;
        if (!official) continue;
        var billedWords = setFrom(r.raw_text.toLowerCase().match(/[a-z]{4,}/g));
        var officialWords = setFrom(official.toLowerCase().match(/[a-z]{4,}/g));
        if (Object.keys(billedWords).length && Object.keys(officialWords).length && !intersects(billedWords, officialWords)) {
          out.push(mkFinding({
            record_id: r.record_id, flagged: true, category: "code-description-mismatch",
            summary: r.raw_text + ": worth double-checking — code " + (s.code !== undefined ? s.code : "undefined") +
              " officially means \"" + official + "\". It may just be worded differently, or it may be miscoded.",
            severity: Severity.MODERATE, confidence: 0.55,
            recommended_action: "Ask the provider to confirm this code matches the service. A genuine " +
              "mismatch can hide a higher charge; often it's just different wording for the same thing.",
            evidence: "code " + (s.code !== undefined ? s.code : "undefined") + " = '" + official + "', but the line reads '" + r.raw_text + "'",
            dollar_impact: null
          }));
        }
      }
      return out;
    },

    _total_reconciliation: function (records, lines) {
      var summary = null;
      for (var j = 0; j < records.length; j++) {
        if (structGet(records[j], "kind") === "summary") { summary = records[j]; break; }
      }
      if (summary === null) return [];
      var stated = structGet(summary, "stated_total");
      if (stated === null || stated === undefined) return [];
      var sum = 0;
      for (var i = 0; i < lines.length; i++) sum += lines[i].structured.line_total;
      var computed = pyRound(sum, 2);
      var diff = pyRound(Math.abs(stated - computed), 2);
      if (diff <= 0.005) return [];
      return [mkFinding({
        record_id: summary.record_id, flagged: true, category: "bill-total-mismatch",
        summary: "The bill total does not match the sum of its itemized lines.",
        severity: severityFor(diff), confidence: 0.85,
        recommended_action: "Request a corrected total or a full itemized statement.",
        evidence: "lines sum to $" + fmtMoney(computed, 2) + ", bill states $" + fmtMoney(stated, 2),
        dollar_impact: diff
      })];
    }
  };

  function setFrom(arr) {
    var o = {};
    if (arr) for (var i = 0; i < arr.length; i++) o[arr[i]] = true;
    return o;
  }
  function intersects(a, b) {
    for (var k in a) if (Object.prototype.hasOwnProperty.call(a, k) && Object.prototype.hasOwnProperty.call(b, k)) return true;
    return false;
  }

  /* ---------------------------------------------------------------------------
   * eob_judge.RuleBasedEobJudge
   * ------------------------------------------------------------------------- */
  var BALANCE_BILLING_MIN = 25.0;
  var COPAY_MISMATCH_MIN = 1.0;
  var MISSING_LINE_MIN = 25.0;

  function eobSeverityFor(dollars) {
    var d = dollars || 0.0;
    if (d >= 1000) return Severity.CRITICAL;
    if (d >= 300) return Severity.HIGH;
    if (d >= 75) return Severity.MODERATE;
    if (d >= 10) return Severity.LOW;
    return Severity.TRIVIAL;
  }

  var RuleBasedEobJudge = {
    assess: function (records, caseObj) {
      var bills = records.filter(function (r) { return structGet(r, "kind") === "line"; });
      var eobs = records.filter(function (r) { return structGet(r, "kind") === "eob-line"; });
      if (eobs.length === 0) return [];

      var remaining = eobs.slice();
      var matched = []; // [b, e]
      var unmatchedBills = [];
      for (var i = 0; i < bills.length; i++) {
        var b = bills[i];
        var code = String(structGet(b, "code", "")).trim();
        var hit = null, idx = -1;
        if (code) {
          for (var j = 0; j < remaining.length; j++) {
            if (String(structGet(remaining[j], "code", "")).trim() === code) { hit = remaining[j]; idx = j; break; }
          }
        }
        if (hit === null) {
          var bt = structGet(b, "line_total");
          if (bt !== null && bt !== undefined) {
            for (var k = 0; k < remaining.length; k++) {
              if (structGet(remaining[k], "billed") === bt) { hit = remaining[k]; idx = k; break; }
            }
          }
        }
        if (hit !== null) {
          remaining.splice(idx, 1);
          matched.push([b, hit]);
        } else {
          unmatchedBills.push(b);
        }
      }

      var primaryInNetwork = !!caseObj && caseObj.primary && caseObj.primary.network_status === "in";
      var hasSecondary = !!caseObj && caseObj.supplemental !== null && caseObj.supplemental !== undefined;

      var findings = [];
      for (var m = 0; m < matched.length; m++) {
        findings = findings.concat(this._reconcile_pair(matched[m][0], matched[m][1], primaryInNetwork));
      }

      for (var u = 0; u < unmatchedBills.length; u++) {
        var ub = unmatchedBills[u];
        var ubt = structGet(ub, "line_total") || 0.0;
        if (ubt >= MISSING_LINE_MIN) {
          findings.push(mkFinding({
            record_id: ub.record_id, flagged: true, category: "eob-line-missing",
            summary: ub.raw_text + ": this charge has no matching line on your insurance EOB.",
            severity: eobSeverityFor(ubt), confidence: 0.6,
            recommended_action: "Ask your insurer whether this service was ever submitted, and ask the " +
              "provider to bill your insurance before billing you.",
            evidence: "billed $" + fmtMoney(ubt, 2) + " with no corresponding EOB line",
            dollar_impact: null,
            dedupe_key: "eob-missing:" + ub.record_id
          }));
        }
      }

      if (hasSecondary && matched.length) {
        var owedSum = 0;
        for (var o = 0; o < matched.length; o++) {
          owedSum += (structGet(matched[o][1], "patient_responsibility") || 0.0);
        }
        var owed = pyRound(owedSum, 2);
        if (owed > 0) {
          var anchor = matched[0][1];
          findings.push(mkFinding({
            record_id: anchor.record_id, flagged: true, category: "coordination-failure",
            summary: "Your secondary/supplemental plan may not have been billed before you were asked to pay.",
            severity: Severity.MODERATE, confidence: 0.55,
            recommended_action: "Confirm BOTH your primary and secondary plans were billed; your secondary " +
              "should cover much of the remaining balance before you owe anything out of pocket.",
            evidence: "EOB shows $" + fmtMoney(owed, 2) + " in patient responsibility and you have secondary coverage",
            dollar_impact: null,
            dedupe_key: "eob-coordination"
          }));
        }
      }
      return findings;
    },

    _reconcile_pair: function (b, e, primaryInNetwork) {
      var out = [];
      var bt = structGet(b, "line_total");
      var pr = structGet(e, "patient_responsibility");
      var eobNet = String(structGet(e, "network_status") || "").toLowerCase();

      if (primaryInNetwork && eobNet === "out") {
        out.push(mkFinding({
          record_id: b.record_id, flagged: true, category: "network-status-mismatch",
          summary: b.raw_text + ": you were in-network, but your insurer processed this as OUT-of-network.",
          severity: Severity.HIGH, confidence: 0.7,
          recommended_action: "This may be a surprise bill protected by the No Surprises Act — you likely owe " +
            "only your in-network share. Dispute it and call the CMS No Surprises Help Desk 1-800-985-3059.",
          evidence: "your coverage is in-network but the EOB shows out-of-network adjudication",
          dollar_impact: null,
          dedupe_key: "eob-network:" + b.record_id
        }));
      }

      if (bt !== null && bt !== undefined && pr !== null && pr !== undefined) {
        var diff = pyRound(bt - pr, 2);
        if (diff >= BALANCE_BILLING_MIN) {
          out.push(mkFinding({
            record_id: b.record_id, flagged: true, category: "balance-billing-possible",
            summary: b.raw_text + ": the bill charges $" + fmtMoney(bt, 2) + ", but your EOB says you owe only $" + fmtMoney(pr, 2) + ".",
            severity: eobSeverityFor(diff), confidence: 0.7,
            recommended_action: "If you've given them your insurance, ask the provider to rebill you the " +
              "insurance-adjusted amount shown on your EOB — you should not be charged the full price.",
            evidence: "bill $" + fmtMoney(bt, 2) + " vs EOB patient responsibility $" + fmtMoney(pr, 2) + " (difference $" + fmtMoney(diff, 2) + ")",
            dollar_impact: diff,
            dedupe_key: "eob-balance:" + b.record_id
          }));
        } else if (diff > COPAY_MISMATCH_MIN) {
          out.push(mkFinding({
            record_id: b.record_id, flagged: true, category: "copay-mismatch",
            summary: b.raw_text + ": the bill is $" + fmtMoney(diff, 2) + " more than your EOB patient responsibility.",
            severity: eobSeverityFor(diff), confidence: 0.6,
            recommended_action: "Ask the provider to correct the amount to match your EOB.",
            evidence: "bill $" + fmtMoney(bt, 2) + " vs EOB $" + fmtMoney(pr, 2),
            dollar_impact: diff,
            dedupe_key: "eob-copay:" + b.record_id
          }));
        }
      }
      return out;
    }
  };

  /* ---------------------------------------------------------------------------
   * decide.DecideGate  (+ config.DecideConfig)
   * ------------------------------------------------------------------------- */
  function DecideConfig(opts) {
    opts = opts || {};
    this.min_confidence = opts.min_confidence !== undefined ? opts.min_confidence : 0.55;
    this.min_dollar_impact = opts.min_dollar_impact !== undefined ? opts.min_dollar_impact : 25.0;
    this.min_severity = opts.min_severity !== undefined ? opts.min_severity : 2;
    this.max_alerts = opts.max_alerts !== undefined ? opts.max_alerts : 8;
  }

  function InMemorySeenStore() { this._seen = {}; }
  InMemorySeenStore.prototype.has = function (k) { return Object.prototype.hasOwnProperty.call(this._seen, k); };
  InMemorySeenStore.prototype.add = function (k) { this._seen[k] = true; };

  function DecideGate(config, seenStore) {
    this.config = config || new DecideConfig();
    this.store = seenStore || new InMemorySeenStore();
  }
  DecideGate.prototype._key = function (f) {
    return f.dedupe_key || (f.category + ":" + f.record_id);
  };
  DecideGate.prototype._is_material = function (f) {
    if (f.dollar_impact !== null && f.dollar_impact !== undefined) {
      return f.dollar_impact >= this.config.min_dollar_impact;
    }
    if (f.deadline !== null && f.deadline !== undefined) return true;
    return f.severity >= this.config.min_severity;
  };
  DecideGate.prototype.filter = function (findings) {
    var dropped = [];
    var candidates = []; // [f, key]
    var runSeen = {};
    for (var i = 0; i < findings.length; i++) {
      var f = findings[i];
      var key = this._key(f);
      if (!f.flagged) {
        dropped.push([f, "not flagged by Judge"]);
      } else if (f.confidence < this.config.min_confidence) {
        dropped.push([f, "low confidence " + f.confidence.toFixed(2) + " < " + this.config.min_confidence.toFixed(2)]);
      } else if (!this._is_material(f)) {
        dropped.push([f, "immaterial (below dollar/severity threshold)"]);
      } else if (this.store.has(key) || Object.prototype.hasOwnProperty.call(runSeen, key)) {
        dropped.push([f, "duplicate of already-alerted '" + key + "'"]);
      } else {
        runSeen[key] = true;
        candidates.push([f, key]);
      }
    }

    // Stable sort by (int(severity), dollar_impact or 0.0) reverse=True.
    // Python's sort is stable; reverse=True reverses comparison but preserves the
    // original order among equal keys. Emulate via decorate-with-index.
    var decorated = candidates.map(function (c, idx) { return { c: c, idx: idx }; });
    decorated.sort(function (A, B) {
      var fa = A.c[0], fb = B.c[0];
      var sa = fa.severity, sb = fb.severity;
      if (sa !== sb) return sb - sa; // higher severity first
      var da = (fa.dollar_impact !== null && fa.dollar_impact !== undefined) ? fa.dollar_impact : 0.0;
      var db = (fb.dollar_impact !== null && fb.dollar_impact !== undefined) ? fb.dollar_impact : 0.0;
      if (da !== db) return db - da; // higher impact first
      return A.idx - B.idx; // stable: preserve original order for ties
    });

    var cap = this.config.max_alerts;
    var kept = [];
    for (var rank = 0; rank < decorated.length; rank++) {
      var f2 = decorated[rank].c[0];
      var key2 = decorated[rank].c[1];
      if (cap && cap > 0 && rank >= cap) {
        dropped.push([f2, "capped: ranked below the top " + cap + " this run"]);
      } else {
        this.store.add(key2);
        kept.push(f2);
      }
    }
    return { kept: kept, dropped: dropped };
  };

  /* ---------------------------------------------------------------------------
   * pipeline.run  (only the parts build_report uses)
   * ------------------------------------------------------------------------- */
  function pipelineRun(feed, records, judge, gate) {
    gate = gate || new DecideGate();
    var findings = judge.assess(records);
    var res = gate.filter(findings);
    return { records: records, findings: findings, kept: res.kept, dropped: res.dropped };
  }

  /* ---------------------------------------------------------------------------
   * eligibility
   * ------------------------------------------------------------------------- */
  // 2026 HHS Poverty Guidelines (annual). Source: HHS ASPE 2026 / Federal Register 2026-00755.
  var FPL_BASE = 15960.0;       // 48 contiguous states + DC, household of 1
  var FPL_PER_PERSON = 5680.0;  // 48 contiguous states + DC, each additional person
  // Region-specific 2026 HHS guidelines (base = household of 1, increment = each additional person).
  var FPL_REGIONS = {
    "48": { base: 15960.0, increment: 5680.0 },  // 48 contiguous states + DC
    "AK": { base: 19950.0, increment: 7100.0 },  // Alaska
    "HI": { base: 18360.0, increment: 6530.0 }   // Hawaii
  };
  // Medicaid expansion status (2026). Source: KFF Status of State Medicaid Expansion Decisions.
  // These 10 states have NOT expanded; all other states + DC have expanded.
  var NON_EXPANSION_STATES = { AL: 1, FL: 1, GA: 1, KS: 1, MS: 1, SC: 1, TN: 1, TX: 1, WI: 1, WY: 1 };
  var MEDICAID_PCT = 138.0;     // ACA-expansion adult cutoff
  var WISCONSIN_PCT = 100.0;    // Wisconsin (non-expansion) covers adults up to 100% FPL
  var FREE_CARE_PCT = 200.0;
  var DISCOUNT_PCT = 400.0;

  function fplRegion(state) {
    var s = (state || "").trim ? (state || "").trim().toUpperCase() : String(state || "").toUpperCase();
    if (s === "AK") return "AK";
    if (s === "HI") return "HI";
    return "48";
  }
  function federalPovertyLevel(householdSize, state) {
    var region = FPL_REGIONS[fplRegion(state)];
    return region.base + region.increment * (Math.max(1, Math.trunc(householdSize)) - 1);
  }
  function fplPercent(annualIncome, householdSize, state) {
    if (annualIncome === null || annualIncome === undefined) return null;
    var fpl = federalPovertyLevel(householdSize, state);
    return fpl ? pyRound(annualIncome / fpl * 100, 1) : null;
  }
  function isExpansionState(state) {
    var s = (String(state || "")).trim().toUpperCase();
    return !Object.prototype.hasOwnProperty.call(NON_EXPANSION_STATES, s);
  }

  // Expansion-aware Medicaid decision. Returns { medicaid, basis, notes }.
  function medicaidDecision(state, pct) {
    var s = (String(state || "")).trim().toUpperCase();
    var notes = [];
    if (isExpansionState(s)) {
      if (pct <= MEDICAID_PCT) {
        notes.push("Your income is in the range that often qualifies for Medicaid in your state, which " +
          "can even pay bills retroactively. Eligibility varies by state — apply through your " +
          "state Medicaid office.");
        return { medicaid: true, basis: "expansion", notes: notes };
      }
      return { medicaid: false, basis: null, notes: notes };
    }
    if (s === "WI" && pct <= WISCONSIN_PCT) {
      notes.push("Wisconsin covers adults up to 100% of the poverty level, so on this income you likely " +
        "qualify for Medicaid (BadgerCare) — apply through your state Medicaid office; it can even " +
        "pay recent bills retroactively.");
      return { medicaid: true, basis: "wisconsin-100", notes: notes };
    }
    if (pct <= MEDICAID_PCT) {
      var gap = "Your state did not expand Medicaid, so adults may not qualify on income alone — but STILL apply: " +
        "you may qualify if you are pregnant, disabled, or caring for a child, and if your income is just " +
        "over the poverty line you likely qualify for nearly-free Marketplace coverage.";
      if (s === "GA") {
        gap += " Georgia runs a partial Medicaid program (Pathways) with a work requirement — check whether " +
          "you meet it.";
      }
      notes.push(gap);
      return { medicaid: false, basis: "coverage-gap", notes: notes };
    }
    return { medicaid: false, basis: null, notes: notes };
  }

  function eligibilityScreen(caseObj) {
    var region = fplRegion(caseObj.state);
    var pct = fplPercent(caseObj.annual_income, caseObj.household_size, caseObj.state);
    if (pct === null) {
      return {
        fpl_percent: null, likely_medicaid: false, likely_free_care: false, likely_discounted_care: false,
        notes: ["Add household size and yearly income to check charity-care and Medicaid eligibility — " +
          "it's the single biggest way to reduce or even erase a hospital bill."],
        region: region, medicaid_basis: null
      };
    }
    var dec = medicaidDecision(caseObj.state, pct);
    var medicaid = dec.medicaid;
    var free = pct <= FREE_CARE_PCT;
    var discount = FREE_CARE_PCT < pct && pct <= DISCOUNT_PCT;
    var notes = [];
    var pct0 = fmtMoney(pct, 0); // f"{pct:.0f}"
    if (free) {
      notes.push("At about " + pct0 + "% of the federal poverty level, you very likely qualify for " +
        "FREE or heavily reduced care. Nonprofit hospitals are required by law to offer " +
        "financial assistance — apply for it; most will not offer it to you first.");
    } else if (discount) {
      notes.push("At about " + pct0 + "% of the federal poverty level, you likely qualify for a " +
        "SLIDING-SCALE DISCOUNT under the hospital's financial-assistance policy. Request it.");
    } else {
      notes.push("At about " + pct0 + "% of the federal poverty level you're above the usual charity-care " +
        "minimums — but ask anyway. Many hospitals set their thresholds higher than the minimum, " +
        "several states require assistance regardless, and you still have full billing-error and " +
        "appeal rights. Request the financial-assistance policy and a payment plan; there's no " +
        "downside to asking.");
    }
    for (var ni = 0; ni < dec.notes.length; ni++) notes.push(dec.notes[ni]);
    if (caseObj.provider_nonprofit === false) {
      notes.push("This provider may be for-profit, so financial assistance isn't federally required — but " +
        "many offer it anyway and several states mandate it. Ask regardless.");
    }
    return {
      fpl_percent: pct, likely_medicaid: medicaid, likely_free_care: free,
      likely_discounted_care: discount, notes: notes, region: region, medicaid_basis: dec.basis
    };
  }

  /* ---------------------------------------------------------------------------
   * rights / protections
   * ------------------------------------------------------------------------- */
  function getKind(ins) { return ins && ins.kind !== undefined ? ins.kind : ""; }

  function _insured(c) { return !c.uninsured; }
  function _uninsured(c) { return !!c.uninsured; }
  function _nonprofit_or_unknown(c) { return c.provider_nonprofit !== false; }
  function _low_income(c) {
    var pct = fplPercent(c.annual_income, c.household_size, c.state);
    return pct !== null && pct <= 138.0;
  }
  function _primary_is() {
    var kinds = Array.prototype.slice.call(arguments);
    return function (c) { return (!c.uninsured) && kinds.indexOf(getKind(c.primary)) !== -1; };
  }
  function _has_medicaid(c) {
    var sup = c.supplemental;
    return (!c.uninsured) && (getKind(c.primary) === "medicaid" ||
      (sup !== null && sup !== undefined && getKind(sup) === "medicaid"));
  }
  function _commercial(c) {
    return (!c.uninsured) && ["marketplace", "employer", "commercial"].indexOf(getKind(c.primary)) !== -1;
  }
  function _primary_out_of_network(c) {
    return (!c.uninsured) && (c.primary && c.primary.network_status === "out");
  }
  function _has_supplemental(c) { return c.supplemental !== null && c.supplemental !== undefined; }

  var PROTECTIONS = [
    { key: "no-surprises-act", title: "You can't be balance-billed for surprise care",
      summary: "If you had an emergency, or an out-of-network doctor treated you at an in-network hospital, " +
        "federal law says you owe only your normal in-network share — not the difference. If you were " +
        "billed more than that, it's likely illegal: dispute it and file a complaint.",
      citation: "No Surprises Act (2022) · CMS No Surprises Help Desk 1-800-985-3059",
      applies: _insured },
    { key: "surprise-billing-out-of-network", title: "An out-of-network 'surprise' bill may not be yours to pay",
      summary: "If you were treated at an in-network hospital but a service was processed as out-of-network, " +
        "or you had emergency care, federal law usually limits you to your in-network share — not the " +
        "full out-of-network price. If your EOB shows out-of-network when you expected in-network, " +
        "dispute the bill and file a complaint.",
      citation: "No Surprises Act (2022) · CMS No Surprises Help Desk 1-800-985-3059",
      applies: _primary_out_of_network },
    { key: "medicare-assignment", title: "Medicare limits what you can be charged",
      summary: "If you have Medicare, a provider who accepts assignment can't bill you more than the " +
        "Medicare-approved amount — you owe only your deductible and coinsurance. A charge above that " +
        "is wrong; check it against your Medicare Summary Notice.",
      citation: "Medicare assignment / limiting charge — Social Security Act §1848(g) · 1-800-MEDICARE",
      applies: _primary_is("medicare") },
    { key: "medicaid-no-balance-billing", title: "Medicaid providers can't bill you the balance",
      summary: "If you have Medicaid and the provider accepts it, they generally cannot bill you the balance " +
        "for covered services — only small allowed copays. Being billed beyond that may be illegal; " +
        "report it to your state Medicaid office.",
      citation: "Social Security Act §1902(n)(3)(B); 42 CFR §447.15",
      applies: _has_medicaid },
    { key: "insurer-appeal-rights", title: "You can appeal a denied or underpaid claim",
      summary: "If your health plan denied or underpaid a claim, you have the right to a free internal appeal " +
        "and then an independent external review. Don't accept a denial at face value — appeal in writing " +
        "before the deadline on the denial letter.",
      citation: "Affordable Care Act claims & appeals rule, 29 CFR §2590.715-2719",
      applies: _commercial },
    { key: "coordination-of-benefits", title: "Your secondary/supplemental plan should pay before you do",
      summary: "With more than one plan, your primary pays first and your secondary/supplemental covers the " +
        "gaps. Make sure BOTH plans were billed before you're asked to pay anything out of pocket.",
      citation: "Coordination of benefits (NAIC model regulation; your plan documents)",
      applies: _has_supplemental },
    { key: "good-faith-estimate", title: "A written price before care (if you're uninsured)",
      summary: "If you're uninsured or paying cash, the provider must give you a written 'Good Faith Estimate' " +
        "up front. If the final bill is at least $400 above that estimate, you can formally dispute it.",
      citation: "No Surprises Act — Good Faith Estimate & Patient-Provider Dispute Resolution",
      applies: _uninsured },
    { key: "charity-care-501r", title: "Financial assistance can reduce or erase the bill",
      summary: "Nonprofit hospitals are required by law to have a financial-assistance policy, and can't charge " +
        "qualifying patients more than insured patients pay. Ask for the policy and apply — you can do it " +
        "even after the bill arrives, and many hospitals never offer it on their own.",
      citation: "IRS §501(r) — Financial Assistance Policy & Amounts Generally Billed limit",
      applies: _nonprofit_or_unknown },
    { key: "medicaid-retroactive", title: "Medicaid may pay bills you already received",
      summary: "With low income, Medicaid can cover medical bills from up to 3 months before you applied — so " +
        "applying now may wipe out a recent bill. The exact window and rules vary by state; apply through " +
        "your state Medicaid office.",
      citation: "Medicaid retroactive eligibility, 42 U.S.C. §1396a(a)(34) (varies by state)",
      applies: _low_income },
    { key: "itemized-bill", title: "Demand an itemized bill — errors hide in summaries",
      summary: "Always request a fully itemized bill showing every code and charge. Summary bills hide duplicate " +
        "charges, services never given, and miscoded items. You can't fight what you can't see — and you " +
        "have the right to see it.",
      citation: "Standard patient right; many states require itemization on request",
      applies: function (c) { return true; } },
    { key: "medical-debt-credit", title: "Strong limits protect your credit from medical debt",
      summary: "The credit bureaus keep medical collections under $500 — and any PAID medical debt — OFF your " +
        "credit report, with a 12-month grace period before any medical debt can appear. Don't let a " +
        "collector scare you with credit threats.",
      citation: "Equifax/Experian/TransUnion policy (2023); note: the 2025 CFPB removal rule was vacated in court July 2025",
      applies: function (c) { return true; } },
    { key: "debt-validation-fdcpa", title: "Make a collector prove the debt before you pay",
      summary: "If a debt collector contacts you, you can demand written validation within 30 days, and they must " +
        "verify the debt before collecting further. Never pay a medical bill in collections until it's been " +
        "validated and you've checked it for errors.",
      citation: "Fair Debt Collection Practices Act, 15 U.S.C. §1692g",
      applies: function (c) { return true; } },
    // --- Tax / cash-back recovery layer (money you can get back), always-honest framing ---
    { key: "aca-marketplace-subsidy", title: "Going forward, subsidized coverage may cost you almost nothing",
      summary: "If you are uninsured, you may get heavily subsidized Marketplace coverage going forward — many " +
        "low-income people pay $0–$10/month. healthcare.gov or 1-800-318-2596.",
      citation: "HealthCare.gov / ACA premium tax credits — 1-800-318-2596",
      applies: _uninsured },
    { key: "medical-expense-deduction", title: "Big medical costs may be tax-deductible",
      summary: "If you itemize your taxes and your out-of-pocket medical costs were more than 7.5% of your income, " +
        "you can deduct the part above 7.5%. Most lower-income filers take the standard deduction instead, so " +
        "this helps mainly if you itemize — free tax help can tell you which is better.",
      citation: "IRS Topic No. 502 / Publication 502 — IRS VITA free tax help 1-800-906-9887, irs.gov/vita",
      applies: function (c) { return true; } },
    { key: "free-tax-help-eitc", title: "Free tax help can get you money back (like the EITC)",
      summary: "Free tax preparation (VITA) can make sure you claim refundable credits you are owed, like the Earned " +
        "Income Tax Credit (EITC), which can be a few thousand dollars back. irs.gov/vita, 1-800-906-9887; " +
        "irs.gov/eitc.",
      citation: "IRS VITA (irs.gov/vita, 1-800-906-9887) · IRS EITC (irs.gov/eitc)",
      applies: function (c) { return true; } }
  ];

  function applicableProtections(caseObj) {
    return PROTECTIONS.filter(function (p) { return p.applies(caseObj); });
  }

  /* ---------------------------------------------------------------------------
   * action_plan  (with embedded medical_actions.json)
   * ------------------------------------------------------------------------- */
  function actionFill(text, finding, caseObj) {
    var details = (finding && finding.details) || {};
    var struct = (details.structured) || {};
    var amount = struct.unit_price;
    var med = struct.medicare_allowed;
    var multiple = null;
    if (typeof amount === "number" && typeof med === "number" && med > 0) {
      multiple = pyRound(amount / med);
    }
    var desc = struct.description;
    if (desc === undefined || desc === null) {
      var summ = (finding && finding.summary) || "this line";
      desc = summ.split(":")[0];
    }
    var repl = {
      "[CODE]": String(struct.code !== undefined && struct.code !== null && struct.code !== "" ? struct.code : "____"),
      "[DESCRIPTION]": String(desc || "this line"),
      "[AMOUNT]": typeof amount === "number" ? fmtMoney(amount, 2) : "____",
      "[N]": multiple ? String(multiple) : "several",
      "[ACCOUNT]": "(your account number)"
    };
    for (var key in repl) {
      if (Object.prototype.hasOwnProperty.call(repl, key)) {
        text = text.split(key).join(repl[key]);
      }
    }
    return text;
  }

  function buildActionPlan(findings, protections, caseObj, data) {
    data = data || MEDICAL_ACTIONS_JSON;
    var playbooks = data.playbooks || {};
    var programs = data.programs || {};
    var steps = [];
    var seen = {};
    findings = findings || [];
    for (var i = 0; i < findings.length; i++) {
      var f = findings[i];
      var cat = f.category;
      var pb = playbooks[cat];
      if (pb && !Object.prototype.hasOwnProperty.call(seen, cat)) {
        seen[cat] = true;
        steps.push({
          title: pb.title !== undefined ? pb.title : cat,
          kind: "billing-issue",
          call: (pb.call || []).slice(),
          say: actionFill(pb.say || "", f, caseObj),
          handle: (pb.handle || []).slice()
        });
      }
    }
    protections = protections || [];
    for (var j = 0; j < protections.length; j++) {
      var p = protections[j];
      var pkey = (typeof p === "string") ? p : (p && p.key);
      var pg = programs[pkey];
      if (pg) {
        steps.push({
          title: pg.title !== undefined ? pg.title : pkey,
          kind: "program",
          call: (pg.call || []).slice(),
          say: actionFill(pg.say || "", null, caseObj),
          handle: (pg.handle || []).slice()
        });
      }
    }
    return { steps: steps, resources: (data.resources || []).slice() };
  }

  /* ---------------------------------------------------------------------------
   * letters
   * ------------------------------------------------------------------------- */
  function letterHeader(provider, account, today, subject) {
    var reLine = "Re: " + subject + (account ? (" — account " + account) : "");
    return (today || "[Date]") + "\n\n" +
      "To: Billing Department, " + (provider || "[Hospital / Provider]") + "\n" +
      reLine + "\n\n" +
      "(Mail this to the billing address printed on your hospital statement.)\n\nTo whom it may concern,\n\n";
  }
  function letterSign(caseObj) {
    var out = "\n\nSincerely,\n" + (caseObj.patient_name || "[Your name]");
    if (caseObj.address) out += "\n" + caseObj.address;
    return out;
  }

  function itemizedBillRequest(caseObj, account, today) {
    var body = letterHeader(caseObj.provider, account, today, "Request for an itemized bill") +
      "Please send me a fully itemized statement for this account, listing every billing code " +
      "(CPT/HCPCS), description, quantity, date of service, and charge. I am reviewing my bill " +
      "carefully before making any payment and need the complete itemization to do so.\n\n" +
      "I understand I have the right to an itemized bill. Please provide it to me in writing." +
      letterSign(caseObj);
    return { key: "itemized-bill-request", title: "Request an itemized bill",
      to: caseObj.provider || "the hospital billing department", body: body };
  }

  function disputeLetter(caseObj, findings, account, today) {
    var rows = [];
    findings = findings || [];
    for (var i = 0; i < findings.length; i++) {
      var f = findings[i];
      var struct = ((f.details || {}).structured) || {};
      var code = struct.code || "";
      var desc = struct.description || ((f.summary || "").slice(0, 60));
      var amt = f.dollar_impact;
      var amtS = (typeof amt === "number" && amt) ? (" (about $" + fmtMoney(amt, 0) + ")") : "";
      var issue = (f.category || "").split("-").join(" ");
      var row = "  - " + code + " " + desc + " - " + issue + amtS;
      rows.push(rstrip(row));
    }
    var body = letterHeader(caseObj.provider, account, today, "Disputed charges") +
      "I have reviewed my itemized bill and am disputing the following charges, which appear to be " +
      "errors or overcharges:\n\n" +
      (rows.length ? rows.join("\n") : "  - (see the itemized bill I am reviewing)") +
      "\n\nPlease review and correct these charges and send me a corrected statement. I am not able " +
      "to pay disputed charges until they are resolved, and I ask that you pause any collection " +
      "activity while this is reviewed." +
      letterSign(caseObj);
    return { key: "dispute", title: "Dispute the charges",
      to: caseObj.provider || "the hospital billing department", body: body };
  }

  function financialAssistanceRequest(caseObj, account, today) {
    var income = (typeof caseObj.annual_income === "number")
      ? ("approximately $" + fmtMoney(caseObj.annual_income, 0)) : "limited";
    var body = letterHeader(caseObj.provider, account, today, "Financial assistance application request") +
      "I am requesting a copy of your financial assistance (charity care) policy and application " +
      "for this account. My household size is " + caseObj.household_size + " and my annual income is " + income + ".\n\n" +
      "Please pause any collection activity while my application is reviewed, and let me know what " +
      "income documentation you require. I understand nonprofit hospitals are required to offer " +
      "financial assistance, and I would like to apply." +
      letterSign(caseObj);
    return { key: "financial-assistance", title: "Apply for financial assistance",
      to: caseObj.provider || "the hospital financial assistance office", body: body };
  }

  function buildLetters(caseObj, findings, account, today) {
    account = account || "";
    today = today || "";
    var out = [itemizedBillRequest(caseObj, account, today)];
    if (findings && findings.length) {
      out.push(disputeLetter(caseObj, findings, account, today));
    }
    if (caseObj.provider_nonprofit !== false) {
      out.push(financialAssistanceRequest(caseObj, account, today));
    }
    return out;
  }

  function rstrip(s) { return s.replace(/\s+$/, ""); }

  /* ---------------------------------------------------------------------------
   * case
   * ------------------------------------------------------------------------- */
  function Insurance(opts) {
    opts = opts || {};
    return {
      kind: opts.kind !== undefined ? opts.kind : "none",
      plan_name: opts.plan_name !== undefined ? opts.plan_name : "",
      network_status: opts.network_status !== undefined ? opts.network_status : ""
    };
  }

  function coerceHouseholdSize(value, def) {
    if (def === undefined) def = 1;
    var n;
    try {
      var f = parseFloat(String(value).trim());
      if (isNaN(f)) return def;
      n = Math.trunc(f);
    } catch (e) {
      return def;
    }
    return n >= 1 ? n : def;
  }

  function Case(opts) {
    opts = opts || {};
    return {
      patient_name: opts.patient_name !== undefined ? opts.patient_name : "",
      address: opts.address !== undefined ? opts.address : "",
      county: opts.county !== undefined ? opts.county : "",
      state: opts.state !== undefined ? opts.state : "",
      household_size: opts.household_size !== undefined ? opts.household_size : 1,
      annual_income: opts.annual_income !== undefined ? opts.annual_income : null,
      provider: opts.provider !== undefined ? opts.provider : "",
      provider_nonprofit: opts.provider_nonprofit !== undefined ? opts.provider_nonprofit : null,
      uninsured: opts.uninsured !== undefined ? !!opts.uninsured : false,
      primary: opts.primary !== undefined ? opts.primary : Insurance(),
      supplemental: opts.supplemental !== undefined ? opts.supplemental : null
    };
  }

  /* ---------------------------------------------------------------------------
   * advocate
   * ------------------------------------------------------------------------- */
  function CompositeJudge(billJudge, eobJudge, caseObj) {
    return {
      assess: function (records) {
        return billJudge.assess(records).concat(eobJudge.assess(records, caseObj));
      }
    };
  }

  function medicalJudgeFor(caseObj, records) {
    var hasEob = records.some(function (r) { return structGet(r, "kind") === "eob-line"; });
    if (hasEob) return CompositeJudge(RuleBasedMedicalJudge, RuleBasedEobJudge, caseObj);
    return RuleBasedMedicalJudge;
  }

  function headline(caseObj, kept, elig, protections, total) {
    var parts = [];
    var n = kept.length;
    if (kept.length && total > 0) {
      parts.push("We found " + n + " thing" + (n !== 1 ? "s" : "") + " worth about $" + fmtMoney(total, 0) + " to question on this bill.");
    } else if (kept.length) {
      parts.push("We flagged " + n + " thing" + (n !== 1 ? "s" : "") + " to act on with this bill.");
    } else {
      parts.push("We didn't find an obvious billing error — like a duplicate charge, a math mistake, or an insurance mismatch — in the lines provided.");
      parts.push("That does NOT mean the price is fair: even an error-free bill can be badly overpriced. Ask for a fully itemized bill, ask the billing office for the cash or financial-assistance price, and use the steps below to question and lower it.");
    }
    if (elig.likely_free_care) {
      parts.push("Based on your income, you very likely qualify for FREE or heavily reduced care — " +
        "this alone could erase the bill.");
    } else if (elig.likely_discounted_care) {
      parts.push("You likely qualify for a sliding-scale discount on the balance.");
    }
    if (protections.length) {
      parts.push(protections.length + " legal protection" + (protections.length !== 1 ? "s" : "") + " apply to " +
        "your situation — use them.");
    }
    parts.push("None of this requires a lawyer or any money. Here's exactly what to do.");
    return parts.join(" ");
  }

  // Recovery / cash-back layer — "money you could get back". bill_savings == total_flagged ==
  // sum of kept findings' dollar_impact; avenues are the qualitative recovery paths (honest "could").
  function computeRecovery(caseObj, totalFlagged, elig) {
    var avenues = [];
    if (totalFlagged > 0) {
      avenues.push("Disputing the flagged billing errors could remove about $" + fmtMoney(totalFlagged, 0) + " from this bill.");
    }
    if (elig.likely_free_care) {
      avenues.push("Charity care (financial assistance) could erase the entire remaining bill — " +
        "nonprofit hospitals are required by law to offer it.");
    } else if (elig.likely_discounted_care) {
      avenues.push("A sliding-scale charity-care discount could cut the remaining balance.");
    }
    if (elig.likely_medicaid) {
      avenues.push("Medicaid could pay this bill — and it can even cover bills from up to 3 months " +
        "before you applied (retroactive coverage).");
    } else if (elig.medicaid_basis === "coverage-gap") {
      avenues.push("Your state did not expand Medicaid, so income alone may not qualify you — but apply " +
        "anyway (pregnancy, disability, or caring for a child can qualify you), and you likely " +
        "qualify for nearly-free Marketplace coverage just over the poverty line.");
    }
    avenues.push("If you itemize, out-of-pocket medical costs above 7.5% of your income may be tax-" +
      "deductible (IRS Topic No. 502) — free tax help can tell you if that beats the standard " +
      "deduction.");
    avenues.push("Free tax preparation (VITA, irs.gov/vita) can make sure you claim refundable credits " +
      "you're owed, like the Earned Income Tax Credit — sometimes a few thousand dollars back.");
    if (caseObj.uninsured) {
      avenues.push("Going forward, subsidized Marketplace coverage may cost you almost nothing " +
        "(healthcare.gov, 1-800-318-2596) — protecting you from the next bill.");
    }
    return { bill_savings: totalFlagged, avenues: avenues };
  }

  function buildReport(caseObj, records, gate, judge) {
    var result = pipelineRun("medical", records, judge || medicalJudgeFor(caseObj, records), gate || new DecideGate());
    var total = 0;
    for (var i = 0; i < result.kept.length; i++) total += (result.kept[i].dollar_impact || 0.0);
    total = pyRound(total, 2);
    var elig = eligibilityScreen(caseObj);
    var protections = applicableProtections(caseObj);
    var recovery = computeRecovery(caseObj, total, elig);
    return {
      kept: result.kept,
      dropped: result.dropped.length,
      total_flagged: total,
      eligibility: elig,
      protections: protections,
      headline: headline(caseObj, result.kept, elig, protections, total),
      recovery: recovery
    };
  }

  /* ---------------------------------------------------------------------------
   * server-equivalent helpers: _record_details + _finding (so action_plan/letters
   * see the same finding dicts the production app passes them)
   * ------------------------------------------------------------------------- */
  function recordDetails(rec) {
    if (!rec) return null;
    var structured = {};
    if (rec.structured) {
      for (var k in rec.structured) {
        if (Object.prototype.hasOwnProperty.call(rec.structured, k) && k !== "kind") {
          structured[k] = rec.structured[k];
        }
      }
    }
    return {
      source: rec.source,
      record_id: rec.record_id,
      url: rec.url !== undefined ? rec.url : null,
      raw_text: rec.raw_text,
      occurred_on: rec.occurred_on || null,
      structured: structured
    };
  }

  function findingDict(f, record) {
    return {
      category: f.category,
      summary: f.summary,
      severity: SEV_NAME[f.severity],
      confidence: pyRound(f.confidence, 2),
      action: f.recommended_action,
      contacts: "", // contacts_for is medical-specific; not part of parity surface
      evidence: f.evidence,
      dollar_impact: f.dollar_impact,
      deadline: f.deadline || null,
      record_id: f.record_id,
      dedupe_key: f.dedupe_key || (f.category + ":" + f.record_id),
      details: record ? recordDetails(record) : null
    };
  }

  /* ---------------------------------------------------------------------------
   * Top-level convenience: advise() — mirrors server._advise (offline / lookup OFF)
   * ------------------------------------------------------------------------- */
  function advise(opts) {
    opts = opts || {};
    var caseObj = opts.case || Case();
    var bill = opts.bill || {};
    var records = ingestBillData(bill);
    if (opts.eob) {
      records = records.concat(ingestEobData(opts.eob));
    }
    var gate = opts.gate || new DecideGate(new DecideConfig({
      min_confidence: 0.5, min_dollar_impact: 10, min_severity: 1, max_alerts: 30
    }));
    var rep = buildReport(caseObj, records, gate);
    var byId = {};
    for (var i = 0; i < records.length; i++) byId[records[i].record_id] = records[i];
    var findings = rep.kept.map(function (f) { return findingDict(f, byId[f.record_id]); });
    var plan = buildActionPlan(findings, rep.protections, caseObj);
    var today = opts.today || "";
    var letters = buildLetters(caseObj, findings, opts.account || "", today);
    return {
      headline: rep.headline,
      total_flagged: rep.total_flagged,
      county: caseObj.county,
      state: caseObj.state,
      findings: findings,
      eligibility: {
        fpl_percent: rep.eligibility.fpl_percent,
        free: rep.eligibility.likely_free_care,
        discount: rep.eligibility.likely_discounted_care,
        medicaid: rep.eligibility.likely_medicaid,
        region: rep.eligibility.region,
        medicaid_basis: rep.eligibility.medicaid_basis,
        notes: rep.eligibility.notes
      },
      recovery: rep.recovery
        ? { bill_savings: rep.recovery.bill_savings, avenues: rep.recovery.avenues }
        : null,
      protections: rep.protections.map(function (p) { return p.key; }),
      steps: plan.steps,
      resources: plan.resources,
      letters: letters,
      _rep: rep
    };
  }

  function auditBillText(text) { return parseBillText(text); }
  function auditEobText(text) { return parseEobText(text); }
  function auditBillData(bill, gate) {
    var records = ingestBillData(bill);
    var g = gate || new DecideGate(new DecideConfig({
      min_confidence: 0.5, min_dollar_impact: 10, min_severity: 1, max_alerts: 30
    }));
    var res = pipelineRun("medical", records, RuleBasedMedicalJudge, g);
    var byId = {};
    for (var i = 0; i < records.length; i++) byId[records[i].record_id] = records[i];
    return {
      kept: res.kept.map(function (f) { return findingDict(f, byId[f.record_id]); }),
      dropped: res.dropped.length
    };
  }

  /* ---------------------------------------------------------------------------
   * Embedded medical_actions.json (verbatim object copy)
   * ------------------------------------------------------------------------- */
  var MEDICAL_ACTIONS_JSON = {
    "version": "2026-06-02",
    "source": "https://raw.githubusercontent.com/korb1nlummis-maker/FreeMedAssist/main/data/medical_actions.json",
    "disclaimer": "General consumer guidance, not legal advice. Phone numbers verified 2026-06-02; verify before relying on them. Improve this file via a pull request and every install can pull the update.",
    "resources": [
      {"key": "no-surprises", "name": "CMS No Surprises Help Desk", "phone": "1-800-985-3059", "for": "surprise, out-of-network, or emergency balance bills", "free": true},
      {"key": "medicare", "name": "Medicare", "phone": "1-800-633-4227", "for": "Medicare billing problems and the Medicare Summary Notice (1-800-MEDICARE)", "free": true},
      {"key": "paf", "name": "Patient Advocate Foundation (free case managers)", "phone": "1-800-532-5274", "for": "insurance denials and large medical debt with a serious diagnosis", "free": true},
      {"key": "dollar-for", "name": "Dollar For", "phone": "", "url": "https://dollarfor.org", "for": "free help applying for hospital charity care (501(r))", "free": true},
      {"key": "unitedway-211", "name": "United Way 211", "phone": "211", "for": "local help with bills, food, utilities, and benefits navigation", "free": true},
      {"key": "state-medicaid", "name": "Your state Medicaid office", "phone": "1-800-318-2596", "for": "apply for Medicaid, including retroactive coverage of past bills - find your state office at medicaid.gov, or call to be routed", "free": true},
      {"key": "state-doi", "name": "Your state Department of Insurance", "phone": "", "for": "file a complaint about a private insurer - find your state insurance department in the NAIC directory at content.naic.org/state-insurance-departments", "free": true},
      {"key": "irs-vita", "name": "IRS VITA — free tax preparation", "phone": "1-800-906-9887", "url": "https://irs.gov/vita", "for": "free tax help to claim refundable credits (like the EITC) and check if medical costs are deductible", "free": true},
      {"key": "healthcare-gov", "name": "HealthCare.gov (ACA Marketplace)", "phone": "1-800-318-2596", "url": "https://healthcare.gov", "for": "heavily subsidized health coverage going forward if you are uninsured (many pay $0–$10/month)", "free": true}
    ],
    "playbooks": {
      "summary-bill-not-itemized": {
        "title": "You only got a summary bill — get the itemized one",
        "call": ["Hospital billing department (number on your statement)"],
        "say": "I received a summary bill with charges grouped into categories. Please send me a FULLY ITEMIZED bill for account #[ACCOUNT] — every code, drug, supply, and its price — before I pay. I'm reviewing it for errors.",
        "handle": ["Overcharges, duplicates, and services you never got hide in category totals.", "You have the right to an itemized bill — don't pay off a summary.", "Once you have it, run it through here to check each line."]
      },
      "above-medicare-benchmark": {
        "title": "A charge far above the Medicare rate",
        "call": ["Hospital billing department (number on your statement)", "If billing won't help: ask for a financial counselor or patient advocate"],
        "say": "Hi, I'm reviewing my itemized bill, account #[ACCOUNT]. The line [CODE] — [DESCRIPTION] — was billed at $[AMOUNT], which is about [N] times the Medicare-allowed amount in my area. Please tell me the cash/self-pay price, reprice this line, and send me your financial-assistance application.",
        "handle": ["Get everything in writing and note the name, date, and a reference number.", "Do NOT agree to a payment plan until the bill is corrected and you've applied for financial assistance.", "If refused, ask for a supervisor or patient advocate, then escalate to your state insurance department or a free advocate (below)."]
      },
      "duplicate-charge": {
        "title": "The same item billed more than once",
        "call": ["Hospital billing department (number on your statement)"],
        "say": "On account #[ACCOUNT], the line [CODE] — [DESCRIPTION] appears to be billed more than once for the same date. Please remove the duplicate and send a corrected itemized statement.",
        "handle": ["Point to the exact duplicate lines.", "Request a corrected itemized bill in writing before paying anything."]
      },
      "code-description-mismatch": {
        "title": "A billing code that may not match the service",
        "call": ["Hospital billing department", "Your insurer's member services (if insured)"],
        "say": "On account #[ACCOUNT], line [CODE] is described as '[DESCRIPTION]', but that code officially means something different. Please confirm the code is correct for the service I actually received, and correct it if not.",
        "handle": ["A wrong code can raise the price or wrongly deny insurance.", "Ask them to verify against your medical record, in writing."]
      },
      "line-math-error": {
        "title": "Quantity times price doesn't equal the line total",
        "call": ["Hospital billing department"],
        "say": "On account #[ACCOUNT], line [CODE] — [DESCRIPTION]: the quantity times the unit price doesn't equal the total billed. Please correct the arithmetic and send a corrected statement.",
        "handle": ["Show the math.", "Request a corrected bill before paying."]
      },
      "bill-total-mismatch": {
        "title": "The total doesn't match the itemized lines",
        "call": ["Hospital billing department"],
        "say": "On account #[ACCOUNT], the stated total doesn't match the sum of the itemized lines. Please send a fully itemized statement and a corrected total.",
        "handle": ["Always work from a fully itemized bill, never a summary.", "Don't pay a total you can't reconcile."]
      },
      "quantity-anomaly": {
        "title": "An implausibly high quantity (often a keying error)",
        "call": ["Hospital billing department"],
        "say": "On account #[ACCOUNT], line [CODE] — [DESCRIPTION] shows a quantity that looks far too high for one visit. Please confirm the units actually provided and correct it.",
        "handle": ["A misplaced quantity can multiply a charge enormously.", "Ask for the medical record backing the quantity."]
      },
      "unbundling": {
        "title": "Parts billed separately when a package code was also billed",
        "call": ["Hospital billing department"],
        "say": "On account #[ACCOUNT], the line [DESCRIPTION] looks like it's already included in a group of tests that was also billed together. Please confirm I'm not being charged separately for something already included, and remove it if so.",
        "handle": ["Ask whether this line is already part of a group of tests billed together.", "Request the correction in writing."]
      },
      "price-vs-reference": {
        "title": "Price well above a typical reference",
        "call": ["Hospital billing department"],
        "say": "On account #[ACCOUNT], line [CODE] — [DESCRIPTION] is priced well above typical. Please share the cash/self-pay price and reprice it, and send your financial-assistance application.",
        "handle": ["Ask for the cash price and the financial-assistance policy.", "Don't pay until corrected."]
      },
      "balance-billing-possible": {
        "title": "The bill charges more than your insurance says you owe",
        "call": ["Hospital billing department (number on your statement)", "Your insurer's member services (number on your card)"],
        "say": "On account #[ACCOUNT], line [CODE] — [DESCRIPTION] — was billed at $[AMOUNT], but my insurance EOB says I owe much less for it. I've given you my insurance. Please rebill me the insurance-adjusted amount from my EOB, not the full charge.",
        "handle": ["Have your EOB in hand and read them the 'patient responsibility' amount for that line.", "Don't pay the full charge if your insurer already processed it.", "Get the corrected balance in writing before paying."]
      },
      "network-status-mismatch": {
        "title": "Billed out-of-network when you were in-network (surprise bill)",
        "call": ["CMS No Surprises Help Desk: 1-800-985-3059", "Your insurer's member services"],
        "say": "I was treated at an in-network facility, but my EOB processed line [CODE] — [DESCRIPTION] as out-of-network. Under the No Surprises Act I should owe only my in-network share. Please reprocess this and correct the balance bill.",
        "handle": ["You usually owe only your in-network cost share for surprise out-of-network care.", "Ask the insurer to reprocess it in-network; file a federal complaint if it isn't fixed."]
      },
      "eob-line-missing": {
        "title": "A charge your insurance never saw",
        "call": ["Hospital billing department", "Your insurer's member services"],
        "say": "On account #[ACCOUNT], line [CODE] — [DESCRIPTION] is on my bill but has no matching line on my insurance EOB. Please confirm this claim was submitted to my insurance, and bill my insurer before billing me.",
        "handle": ["A service the insurer never saw may be billed to you in error.", "Ask the provider to (re)submit the claim to your insurance first."]
      },
      "copay-mismatch": {
        "title": "The bill amount doesn't match your EOB",
        "call": ["Hospital billing department"],
        "say": "On account #[ACCOUNT], line [CODE] — [DESCRIPTION] is billed for more than the patient-responsibility amount on my insurance EOB. Please correct it to match my EOB.",
        "handle": ["Read them the patient-responsibility amount from your EOB for that line.", "Ask for a corrected statement."]
      },
      "coordination-failure": {
        "title": "Make sure your second insurance was billed",
        "call": ["Hospital billing department", "Your secondary/supplemental insurer"],
        "say": "I have a secondary/supplemental plan. Please bill my primary plan and then my secondary plan before billing me — I should only owe what's left after both have paid.",
        "handle": ["Confirm BOTH insurers processed the claim before paying anything.", "Your secondary should cover much of the leftover balance."]
      }
    },
    "programs": {
      "medicare-assignment": {
        "title": "A Medicare charge above the approved amount",
        "call": ["Hospital billing department", "1-800-MEDICARE (1-800-633-4227)"],
        "say": "I have Medicare. This charge is more than the Medicare-approved amount for a provider who accepts assignment. Please correct it — I owe only my deductible and coinsurance.",
        "handle": ["Compare the bill to your Medicare Summary Notice (MSN).", "If it isn't fixed, report it to 1-800-MEDICARE."]
      },
      "medicaid-no-balance-billing": {
        "title": "Being balance-billed even though you have Medicaid",
        "call": ["Hospital billing department", "Your state Medicaid office (find it at medicaid.gov)"],
        "say": "I have Medicaid and you accepted it for this care, so I can't be balance-billed beyond allowed copays. Please remove this charge.",
        "handle": ["Providers who accept Medicaid generally cannot bill you the balance for covered care.", "Report improper billing to your state Medicaid office."]
      },
      "insurer-appeal-rights": {
        "title": "Appeal a denied or underpaid insurance claim",
        "call": ["Your insurer's member services (number on your card)"],
        "say": "I'm filing an internal appeal of this claim decision, and I want an independent external review if it's upheld. Please send the appeal forms and the deadline.",
        "handle": ["Appeal in writing before the deadline on your denial letter (often 180 days).", "Keep copies; get the decision in writing."]
      },
      "coordination-of-benefits": {
        "title": "Make sure your secondary/supplemental plan was billed first",
        "call": ["Hospital billing department", "Your secondary/supplemental insurer"],
        "say": "Please bill my primary plan and then my secondary/supplemental plan before billing me directly.",
        "handle": ["Confirm BOTH insurers' EOBs before paying anything.", "You should only owe what's left after both plans pay."]
      },
      "charity-care-501r": {
        "title": "Apply for charity care (financial assistance)",
        "call": ["Hospital billing / financial-assistance office (ask for the 'Financial Assistance Policy' / FAP)", "Dollar For — free help applying: dollarfor.org"],
        "say": "I'd like to apply for your financial-assistance policy. Please pause collections on account #[ACCOUNT] while my application is reviewed, and send me the application and the income documents you need.",
        "handle": ["Nonprofit hospitals are legally required to have this and can't charge you more than insured patients.", "Apply even after the bill arrives; ask them to hold collections during review.", "Keep copies of everything you submit."]
      },
      "good-faith-estimate": {
        "title": "Dispute a bill that's far over your Good Faith Estimate (uninsured)",
        "call": ["CMS No Surprises Help Desk: 1-800-985-3059"],
        "say": "I'm uninsured/self-pay. My final bill is at least $400 over the Good Faith Estimate I was given. I want to start the Patient-Provider Dispute Resolution process.",
        "handle": ["Find your written estimate and compare it to the final bill.", "You generally have 120 days from the bill to dispute."]
      },
      "no-surprises-act": {
        "title": "Surprise / out-of-network balance bill (you have insurance)",
        "call": ["CMS No Surprises Help Desk: 1-800-985-3059", "Your insurer's member services"],
        "say": "This was emergency care (or an out-of-network provider at an in-network facility). Under the No Surprises Act I should owe only my in-network cost share. Please correct the balance bill.",
        "handle": ["You only owe your normal in-network share — not the balance.", "File a federal complaint if it isn't fixed."]
      },
      "medicaid-retroactive": {
        "title": "Apply for Medicaid (it can pay past bills)",
        "call": ["Your state Medicaid office (find it at medicaid.gov)", "United Way 211 for application help"],
        "say": "I'd like to apply for Medicaid and ask about retroactive coverage for medical bills from the last few months.",
        "handle": ["Medicaid can cover bills up to 3 months before you applied.", "Tell the hospital an application is pending and ask them to hold collections."]
      },
      "itemized-bill": {
        "title": "Request a fully itemized bill",
        "call": ["Hospital billing department"],
        "say": "Please send me a fully itemized bill for account #[ACCOUNT] with every code, description, quantity, and charge. I'm reviewing it before paying.",
        "handle": ["Errors hide in summary bills.", "You have the right to itemization — don't pay until you have it."]
      },
      "debt-validation-fdcpa": {
        "title": "Make a collector validate the debt",
        "call": ["The collection agency (in writing is best)"],
        "say": "I dispute this debt and request written validation under the Fair Debt Collection Practices Act. Do not contact me further until you provide it.",
        "handle": ["Send within 30 days of first contact; keep a copy.", "They must stop collecting until they validate.", "Never pay a medical debt in collections before validating and checking it for errors."]
      },
      "medical-debt-credit": {
        "title": "Protect your credit from medical debt",
        "call": ["Your collector (to dispute)", "The credit bureaus if it's wrongly reported"],
        "say": "Medical collections under $500 and any paid medical debt should not appear on my credit report, and there's a 12-month grace period. Please remove it.",
        "handle": ["Don't be pressured by credit threats.", "Dispute wrongly-reported medical debt with the bureau."]
      },
      "medical-expense-deduction": {
        "title": "Check whether your medical costs are tax-deductible",
        "call": ["IRS VITA — free tax preparation: 1-800-906-9887 (irs.gov/vita)"],
        "say": "I had large out-of-pocket medical costs this year. Can you check whether I should itemize and deduct the part of my medical expenses above 7.5% of my income, or whether the standard deduction is better for me?",
        "handle": ["If you itemize and your out-of-pocket medical costs were more than 7.5% of your income, you can deduct the part above 7.5%.", "Most lower-income filers take the standard deduction instead — free tax help (VITA) can tell you which is better.", "Source: IRS Topic No. 502 / Publication 502."]
      },
      "aca-marketplace-subsidy": {
        "title": "Get heavily subsidized coverage going forward (if uninsured)",
        "call": ["HealthCare.gov: 1-800-318-2596 (healthcare.gov)"],
        "say": "I'm uninsured and want to check what Marketplace health coverage I qualify for, including premium subsidies based on my income.",
        "handle": ["Many low-income people pay $0–$10/month for Marketplace coverage with subsidies.", "This protects you from the next bill — apply at healthcare.gov or by phone."]
      },
      "free-tax-help-eitc": {
        "title": "Get free tax help to claim money you're owed (like the EITC)",
        "call": ["IRS VITA — free tax preparation: 1-800-906-9887 (irs.gov/vita)"],
        "say": "I'd like free help preparing my taxes and making sure I claim every refundable credit I'm owed, including the Earned Income Tax Credit (EITC).",
        "handle": ["VITA tax help is free and can make sure you claim refundable credits like the EITC — often a few thousand dollars back.", "Bring your ID, Social Security cards, and income documents.", "More: irs.gov/vita and irs.gov/eitc."]
      }
    }
  };

  /* ---------------------------------------------------------------------------
   * Export
   * ------------------------------------------------------------------------- */
  root.FreeMedAssistEngine = {
    // parsing
    parseBillText: parseBillText,
    parseEobText: parseEobText,
    auditBillText: auditBillText,
    auditEobText: auditEobText,
    // ingest
    ingestBillData: ingestBillData,
    ingestEobData: ingestEobData,
    // judges / gate
    RuleBasedMedicalJudge: RuleBasedMedicalJudge,
    RuleBasedEobJudge: RuleBasedEobJudge,
    DecideGate: DecideGate,
    DecideConfig: DecideConfig,
    // eligibility / rights
    eligibilityScreen: eligibilityScreen,
    fplPercent: fplPercent,
    federalPovertyLevel: federalPovertyLevel,
    fplRegion: fplRegion,
    isExpansionState: isExpansionState,
    applicableProtections: applicableProtections,
    PROTECTIONS: PROTECTIONS,
    // plan / letters
    buildActionPlan: buildActionPlan,
    buildLetters: buildLetters,
    MEDICAL_ACTIONS: MEDICAL_ACTIONS_JSON,
    // case
    Case: Case,
    Insurance: Insurance,
    coerceHouseholdSize: coerceHouseholdSize,
    // orchestration
    buildReport: buildReport,
    computeRecovery: computeRecovery,
    advise: advise,
    auditBillData: auditBillData,
    findingDict: findingDict,
    recordDetails: recordDetails,
    // helpers (exposed for tests)
    toFloatOrNone: toFloatOrNone,
    pyRound: pyRound,
    fmtMoney: fmtMoney,
    Severity: Severity,
    SEV_NAME: SEV_NAME
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
