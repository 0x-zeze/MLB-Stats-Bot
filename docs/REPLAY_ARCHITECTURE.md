# Replay Architecture

**Status:** active — real recompute replay for moneyline (2026-07-28)

Replay recomputes a prediction from a frozen historical snapshot using the exact
same deterministic pure core as production. It does **not** merely read back a
previously stored decision and compare it after serialization.

## 1. Canonical production core

`src/core/prediction_core.js` (`predictGameMoneylineCore`) is the single source
of moneyline probability math. It is pure:

- no HTTP, database, filesystem, clock (`Date.now()`/`new Date()`), or env access;
- no input mutation; no global mutable state;
- all externally-sourced inputs (evolution controls, calibration function, park
  factors, `now`) are injected.

The live wrapper `predictGame` (src/mlb.js) only injects those externals. Replay
injects the frozen equivalents. Identical inputs → identical output.

## 2. Replay flow

```text
load immutable prediction snapshot
  -> validate snapshot schema + hash integrity
  -> rebuild pure-core input from frozen coreInputs (Maps, park factors)
  -> reconstruct calibration function from the frozen calibrationArtifact
  -> run predictGameMoneylineCore
  -> compare recomputed raw/calibrated stages to stored values
  -> produce parity report
```

## 3. Snapshot contents (schema v1)

| Field | Purpose |
|-------|---------|
| `coreInputs` | Frozen raw features (plain JSON; Maps serialized to objects) |
| `calibrationArtifact` | Exact calibration map/mode/shrink used at decision time |
| `modelInputs` | Stored raw + calibrated probabilities + modelBreakdown |
| `decisionInputs` | Stored valuePick / betDecision |
| `versions` | model / feature / calibration / policy versions |
| `predictionTimestampUtc`, `asOfUtc`, `firstPitchUtc` | temporal binding |

`buildCoreInputsSnapshot` (in `prediction_core.js`) serializes the live input
bundle; `freezeCalibrationArtifact` (in `calibration.js`) freezes the artifact.

## 4. Replay modes

| Mode | Trigger | Promotion-eligible? |
|------|---------|---------------------|
| `recompute` | snapshot has `coreInputs.game` | yes, when parity holds |
| `projection` | legacy snapshot, decision fields only | **no** (labeled) |

## 5. Tolerances

```javascript
PROBABILITY_TOLERANCE = 1e-9   // full-precision raw stages
EDGE_TOLERANCE        = 1e-9   // raw / dampened edge
DISPLAY_ROUNDING_TOLERANCE = 0.1 + 1e-9  // display-rounded calibrated probs
```

Raw full-precision stages are the authoritative parity gate. Display-rounded
calibrated probabilities use the 0.1 rounding quantum so a rounding boundary
is not a false failure.

## 6. Verified fields

model pick, raw probability, dampened edge, calibrated probability, and (when
stored) value side / edge / status / stake.

## 7. Replay CLI

```bash
node scripts/replay_prediction.js --snapshot path/to/snapshot.json
node scripts/replay_prediction.js --snapshot path/to/snapshot.json --twice
```

Exit code `0` on parity, `2` on parity failure, `1` on usage error.

## 8. Replay report

snapshotHash, gamePk, original timestamp, versions, fields compared,
differences, parity status, mode, promotionEligible.

## 9. Mutation guarantees (tested)

- starter mutation → probability changes;
- lineup strength mutation → prediction changes;
- calibration artifact mutation → calibrated probability changes;
- irrelevant metadata mutation → prediction unchanged;
- exact snapshot replayed twice → identical output.

## 10. What replay must never do

- use current APIs / standings / weather / odds / model config;
- silently substitute the newest calibration artifact;
- treat a projection-only snapshot as promotion-eligible.

## 11. Related

- `docs/PREDICTION_ARCHITECTURE.md`
- `docs/DATA_PROVENANCE_SCHEMA.md`
- `docs/CALIBRATION_GOVERNANCE.md`
