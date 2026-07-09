# PROGRESS — Deterministic rule support (moneyline engine + evolution manual candidates)

**Status:** WIP. STEP 1.0–1.2 done (JS live engine refactored + green). STEP 1.3 in progress.
STEP 1.4 / 1.5 / STEP 2 pending. This file is a handoff so work can resume cold.

Approved plan: `/root/.claude/plans/i-want-to-add-velvety-taco.md`.
Branch: `main` (WIP committed here per request).

---

## 0. One thing the plan got wrong (correction)

`src/market_comparison.py` has **NO** NO_BET/LEAN/BET thresholds. It is pure math:
`compare_moneyline_market()` just calls `calculate_edge(...)` and returns
`{home_edge, away_edge, pick_edge}`. **Do NOT refactor market_comparison.py** — there is
nothing to extract. All Python thresholds live in `quality_control.py` only. `odds.py` is
likewise pure math (implied prob / edge). This narrows STEP 1.4/1.5 to quality_control.py.

Also confirmed: **live moneyline decisions are JavaScript** (`src/index.js:321` →
`applyMoneylineValueMarket` in `src/mlb.js` → `valueSafetyReasons`). `quality_control.py`
is offline-only (dashboard `source="sample"` + python backtest). So the JS refactor
(STEP 1.2, DONE) is the one that touches production; the Python side is parity-only.

---

## 1. Evolution data schemas (verified against files on disk 2026-07-09)

### 1a. `data/evolution/rule_candidates.jsonl` (JSON Lines, 1534 lines)

Two variants coexist. The **auto-generator** (`rule_candidate_generator.py:63-75`) is the
canonical schema STEP 2 must emit. There is an older "gradient/prompt" variant too
(keys `target`, `update`, `source_gradients`) — ignore it; emit the generator's shape.

**Generator "with market" schema (what STEP 2 writes), from `rule_candidate_generator.py:63`:**
```json
{
  "candidate_id": "cand-<sha1(key)[:10]>",
  "market": "moneyline",
  "type": "no_bet_rule",
  "rule": "<free text of the proposed rule>",
  "reason": "Repeated pattern appeared N times.",
  "source_lessons": ["lesson-...", "..."],
  "source_losses": ["loss-...", "..."],
  "required_backtest": true,
  "backtest_status": "pending",
  "status": "pending",
  "production_update_allowed": false
}
```
`created_at` is stamped by `memory_store.append_jsonl("rule_candidates", cand)` — do NOT
set it yourself. `type` is validated against:
`no_bet_rule | confidence_cap | threshold_update | prompt_update | tool_order_update | symbolic_update`
(`prompt_update`/`symbolic_update`/`tool_order_update` come from `_candidate_type()`;
`threshold_update` is in the plan's accepted arg set).

**Real on-disk sample (a rule-variant candidate, trimmed):**
```json
{
  "candidate_id": "cand-232ef612e7", "type": "symbolic_update",
  "rule": "Make the explanation explicitly state whether the lean is model-driven, ...",
  "reason": "Repeated pattern appeared 40 times.",
  "source_lessons": ["lesson-bfb37488ab", "..."], "source_losses": [],
  "required_backtest": true, "backtest_status": "completed",
  "status": "pending", "promotion_status": "rejected",
  "production_update_allowed": false,
  "created_at": "2026-05-05T05:31:49.381065+00:00"
}
```
For STEP 2 add **`"source": "manual"`** (generator never sets `source`, so this is a clean
discriminator for audits) and prefix the id `manual-...` to avoid sha1 collision with autos.

### 1b. `data/evolution/approved_rules.json` (dict, 230 approved entries)

Top-level dict, NOT a list:
```json
{
  "active_controls": [ ... 6 items ... ],
  "active_rule_version": "rules-v1.230",
  "approved": [ ... 230 items ... ],
  "rollback_supported": true
}
```
Each `approved[i]` (written by `promotion_gate._store_decision`, gate.py:57-64) is:
```json
{ "candidate": { ...full candidate... }, "decision": { ...gate result... },
  "date": "<utc_now()>", "rollback_supported": true }
```
Older/audit entries carry a richer `candidate` (with `evidence`, `parameters`, `rule`,
`promotion_status: "approved_conservative_guardrail"`) — that's the audit-guardrail path,
not the normal gate. **Never write this file directly** — only `run_promotion_gate` does.

### 1c. `data/evolution/rejected_rules.json` (dict, key `rejected`)

```json
{ "rejected": [ { "candidate": {...}, "decision": {...}, "date": "...",
                  "rollback_supported": true }, ... ] }
```
Same envelope as approved. Written by the same `_store_decision` with `file_key="rejected_rules"`.

### 1d. Promotion gate + defer (why manual candidates can't bypass)

- `evolution_engine.backtest_candidates()` (`evolution_engine.py:707-750`): for each pending
  candidate, split `prediction_outcomes` by `created_at` into before/after for the
  candidate's market. **If `len(before) < 20 or len(after) < 20` → `backtest_status =
  "insufficient_data"`, `promotion_status = "deferred"`** (line 740-742). A candidate created
  "now" has ~0 after-rows → always defers. This IS the no-bypass guarantee — nothing to add.
- If enough data: `run_promotion_gate(cand, before, after, min_sample_size=20)` decides.
- `promotion_gate._unsafe_change()` (gate.py:32-40) hard-rejects text containing
  `remove/disable/bypass/ignore no bet`, or `increase high confidence` w/o `calibration`,
  or `removes_safety_rule: true`. STEP 2 CLI may pre-warn on these but the gate enforces regardless.

---

## 2. Hardcoded thresholds — exact locations & logic

### 2a. `src/quality_control.py` (the ONLY Python file with thresholds)

Constants:
- `_CONFIDENCE_LEVELS = ("Low", "Medium", "High")` — line 28
- `_DEFAULT_MONEYLINE_EDGE_THRESHOLD = 0.04` — line 29
- `_moneyline_edge_threshold()` — lines 32-41: reads `data_path("dashboard_settings.json")`
  key `minimum_moneyline_edge`, else 0.04. **Keep this helper; the dashboard-settings patch
  test (`test_moneyline_edge_threshold_reads_dashboard_settings`) depends on
  `patch("src.quality_control.data_path", ...)`.**
- `_format_edge_threshold(v)` — lines 44-45: `f"{v*100:.0f}%"` (so 0.04 → "4%", 0.05 → "5%").
- `_cap_confidence` / `_downgrade` / `_normalize_confidence` — lines 361-374.

`apply_confidence_downgrade(prediction, quality_report)` — lines **377-497**. The
**middle block (394-466)** is the delegation target for `evaluate_moneyline`; everything
else (signature, deepcopy, decision-label 468-477, `output.update` 482-496) stays. The
checks in source order (this order IS the reason/adjustment order — must be preserved):

| Lines | Kind | Fires when | Emits |
|------|------|-----------|-------|
| 394-396 | NO_BET | `quality_report["probable_pitchers"] == MISSING` | reason `"probable pitcher missing"` |
| 398-400 | note | `"opener_situation" in no_bet_considerations` | adj `"opener situation: SP role unclear"` |
| 402-404 | NO_BET | `edge_value is None` | reason `"model edge unavailable"` |
| 405-407 | NO_BET | `market_type=="yrfi" and abs(edge)<0.06` | reason `"YRFI model edge below 6%"` |
| 408-410 | NO_BET | `market_type!="yrfi" and abs(edge)<threshold` | reason `f"model edge below {_format_edge_threshold(t)}"` |
| 414-417 | NO_BET | `score < 60` | reason `"data quality score below 60"` |
| 419-432 | DOWNGRADE | sharp_adj `downgrade_two`/`downgrade_one` | adj x2 / x1 |
| 434-436 | DOWNGRADE | `odds == STALE` | adj `"odds stale: confidence downgraded"` |
| 438-440 | DOWNGRADE | `weather==STALE and weather_outdoor` | adj `"outdoor weather stale: ..."` |
| 442-446 | CAP→Medium | `lineup in {PROJECTED, MISSING}` | adj `"lineup not confirmed: ... Medium"` |
| 448-452 | CAP→Medium | `probable_pitchers == PROJECTED` | adj `"probable pitcher projected: ... Medium"` |
| 454-458 | CAP→Low | `60 <= score < 75` | adj `"data quality 60-74: ... Low"` |
| 459-463 | CAP→Medium | `75 <= score < 85` | adj `"data quality 75-84: ... Medium"` |
| 464-466 | CAP→Medium | `score>=85 and conf=="High" and not calibration_supports_high` | adj `"calibration does not support High: ... Medium"` |

Decision label (468-477, **stays in host, do NOT move into engine**):
`no_bet → "NO BET"`; `elif confidence=="High" and edge is not None and abs(edge)>=0.04 → "BET"`;
`else → "LEAN"`. Note the **literal 0.04** here is separate from the configurable edge
threshold — it's the BET-grade floor; leave it in quality_control.py.

The score-band caps (454-463) collapse into ONE py handler `scoreBandCap` with
`params.bands` = the `[{lo,hi,cap,msg}, ...]` elif chain (already modeled that way in the JSON).

### 2b. `src/mlb.js` (JS live engine) — already refactored, see §3

Constants still in `mlb.js` (unchanged, read by handlers via ctx):
- `DEFAULT_/STRONG_MONEYLINE_VALUE_EDGE_THRESHOLD = 4.0` (:20-21)
- `MIN_VALUE_PROBABILITY = 52.0` (:30)
- `MIN_TEAM_QUALITY_PCT = 0.520` (:34)
- `MAX_AWAY_UNDERDOG_ODDS = 115` (:38)

---

## 3. Implemented vs pending

### DONE (green)
- **`data/rules/moneyline_rules.json`** (328 lines) — single source of truth. 27 rules:
  15 `engines:["js"]` (orders 20-160), 12 `engines:["py"]` (orders 10-90). Each rule:
  `{id, engines, tier, order, action(NO_BET|CAP|ADJUST), handler, params, message, notes}`.
  Top-level `version:"moneyline-rules-v1"`, `_doc` (order-not-tier invariant), `config_refs`.
- **`src/rule_engine.js`** (228 lines) — JS evaluator. `loadMoneylineRules()`,
  `_resetRulesCache()`, `JS_HANDLERS` (15 fns), `evaluateMoneyline(ctx)`. Sorts by
  **`order` only** (NOT tier — tier-sort would reorder reason strings and break byte-identity).
  Path via `process.env.MLB_RULES_FILE || new URL('../data/rules/moneyline_rules.json', ...)`.
- **`src/mlb.js`** — `import { evaluateMoneyline }` at :14; `valueSafetyReasons` body replaced
  by a thin adapter that builds `ctx` and delegates. `applyMoneylineValueMarket` UNCHANGED.
- **`package.json`** — added `&& node --check src/rule_engine.js` to `check`.
- **`tests/test_rule_schema.js`** (63 lines, 6 tests) — pinned version, typed fields, unique
  ids, unique (engine,order), JS handler↔rule bijection. PASS.
- **`tests/fixtures/moneyline_corpus.js`** (203 lines, 20 cases incl. boundaries).
- **`tests/fixtures/moneyline_goldens.json`** — 20 goldens captured from PRE-refactor code.
- **`tests/test_rule_engine_parity.js`** (55 lines) — runs corpus under isolated empty
  `MLB_EVOLUTION_DATA_DIR`, deepEquals `{status,reason,reasons}` vs goldens. PASS.
- JS suite result: **17/17 my tests green.** (23 unrelated failures are pre-existing
  better-sqlite3 ABI mismatch — see §4.)

### PENDING
- **STEP 1.3** (in progress): `src/rule_engine.py` (`lru_cache` loader + `evaluate_moneyline`
  + `PY_HANDLERS`) and `tests/test_rule_schema.py`. NOT wired into quality_control.py.
- **STEP 1.4**: capture Py goldens from OLD `apply_confidence_downgrade` (verify green vs OLD
  first), add `tests/test_rule_engine_parity.py`, THEN refactor middle block 394-466 to
  delegate to `evaluate_moneyline`. Run pytest.
- **STEP 1.5**: full gate (`npm test`), README invariant + confirm `_doc` sync contract.
- **STEP 2**: `src/evolution/add_manual_candidate.py` CLI (append `source:"manual"` candidate
  via `memory_store.append_jsonl`) + `tests/test_add_manual_candidate.py` (assert schema,
  `source=="manual"`, flows through gate as deferred, no bypass).

---

## 4. Decisions & gotchas

- **Sort by `order`, never `tier`.** `tier` (1/2/3, README input-signal taxonomy) is
  descriptive metadata only. Reason strings embed computed numbers and existing tests assert
  on `reasons[0]`/substrings — tier-sort would reorder and break byte-identity. Documented in
  the JSON `_doc`.
- **Byte-identical refactor contract.** Golden-verify BEFORE refactor: capture goldens from
  OLD code, prove goldens pass against OLD, then refactor and prove identical. (Did this for
  JS; must repeat for Py.)
- **Handlers own formatting**, JSON owns thresholds/messages/order/scope/tier. JS uses
  `.toFixed`, Py uses `:.0f` — different, so number formatting can't live in shared JSON;
  string-building handlers (stale-odds, sharp) return an `override` instead of tokens.
- **4 JS handlers are edge-gated.** thin_matchup/few_factors/lineup_incomplete/no_probable_pitcher
  only fire when `option.edge < 4.0`, so corpus uses single-sided markets (home odds only,
  no de-vig) with a small sub-4% edge to exercise them; they co-fire with edge_floor (true
  current behavior).
- **Pre-existing sqlite ABI failure (NOT mine).** 4 test files instantiate Storage/
  better-sqlite3 and fail `ERR_DLOPEN_FAILED`: test_bet_ledger.js, test_feature_snapshots.js,
  test_platoon_capture.js, test_storage_matchup_memory.js. Cause: shell Node v22 (ABI 127) vs
  bot's Node v24 (ABI 137) — memory `runtime-node-version-screen-vs-shell`. Proven not mine:
  none reference rule_engine/valueSafety; stashing my edits leaves them failing identically.
  Run my JS tests explicitly: `node --test tests/test_rule_schema.js tests/test_rule_engine_parity.js`.
- **market_comparison.py / odds.py untouched** — no thresholds there (see §0).
- **The BET-grade `>= 0.04` at quality_control.py:472** is a separate literal from the
  configurable edge threshold; keep it in the host decision-label block, not in a rule.

---

## 5. Exact next action on resume

**STEP 1.3 — write the Python evaluator + schema test (NOT wired yet):**

1. Create `src/rule_engine.py` mirroring `src/rule_engine.js`:
   - `@functools.lru_cache(maxsize=1)` `_load_rules()` reading `data_path("rules/moneyline_rules.json")`.
   - `evaluate_moneyline(ctx)`: filter to `"py" in rule["engines"]`, sort by `rule["order"]`
     (NOT tier), thread a running `confidence` so CAP/ADJUST compound in source order; return
     `{no_bet, reasons, adjustments, confidence}`.
   - `PY_HANDLERS` registry with the 12 py handlers (see JSON): probablePitcherMissing(10),
     openerConsideration(15), edgeUnavailable(20), yrfiEdgeFloor(21), edgeFloor(22),
     dataQualityFloor(30), sharpDowngrade(40), oddsStaleDowngrade(50), weatherStaleDowngrade(60),
     lineupCap(70), pitcherProjectedCap(80), scoreBandCap(90 w/ params.bands).
   - Edge threshold is passed IN via ctx (from `_moneyline_edge_threshold()`), NOT cached in
     rule_engine, so the dashboard_settings patch test keeps working.
2. Create `tests/test_rule_schema.py` mirroring `test_rule_schema.js`: pinned version, typed
   fields, unique ids, unique (engine,order), **py rule ids ↔ PY_HANDLERS keys bijection**.
3. Run + show: `node scripts/run_python.js -m pytest tests/test_rule_schema.py`
   and `node --test tests/test_rule_schema.js tests/test_rule_engine_parity.js`.
4. Then STEP 1.4: capture Py goldens from OLD `apply_confidence_downgrade` (assert green vs
   OLD), add `tests/test_rule_engine_parity.py`, refactor middle block 394-466 to delegate,
   re-run pytest. Keep `tests/test_quality_control.py` green untouched.

**Verification cadence (per standing constraint, run after every change, show results):**
```
npm run check
node --test tests/*.js                 # my parity/schema green; sqlite ABI failures are pre-existing
node scripts/run_python.js -m pytest
```
Respond in Indonesian. No live BET/LEAN/NO_BET output may change unless a rule is promoted
through the gate.
