# Model Governance

**Status:** proposal-only evolution sandbox (no direct production mutation)

The evolution engine must not directly modify production behavior. It may only
create **immutable proposals**. Production reads only explicitly promoted,
versioned artifacts.

## 1. Candidate proposal schema

```json
{
  "candidate_id": "candidate-YYYYMMDD-001",
  "created_at": "",
  "base_model_version": "",
  "base_feature_version": "",
  "base_calibration_version": "",
  "proposed_changes": {},
  "training_period": {},
  "validation_period": {},
  "sample_size": 0,
  "evaluation_results": {},
  "status": "proposal"
}
```

## 2. Allowed statuses

```text
proposal -> evaluating -> approved -> promoted
                     \-> rejected
promoted -> rolled_back
```

## 3. Promotion gates

A candidate may be promoted only after **all** of:

1. leakage validation (temporal provenance complete);
2. chronological (walk-forward) evaluation;
3. minimum sample-size gate;
4. comparison against the current champion on the same period;
5. calibration checks;
6. segment checks (monthly, favorite/underdog, odds bands, quality tiers);
7. regression tests;
8. explicit approval;
9. immutable version creation.

## 4. What evolution must never auto-change

Recent short-term ROI must never automatically change:

- feature weights;
- confidence thresholds;
- calibration artifacts;
- bet eligibility;
- stake limits.

## 5. Current enforcement

- `maybeQueueCalibrationRetrain` writes a **proposal/outbox** entry only — it
  does not promote.
- Runtime evolution controls (`loadEvolutionControls`) read approved/active
  weights; guardrails with `released`/`removed` status are skipped.
- Calibration auto-promotion is disabled; promotion is explicit and versioned.

## 6. Rollback

Every promotion creates an immutable version. Rollback = re-pointing the active
version to a prior promoted artifact. Promotion history is stored so any
production change can be reverted to a known-good version.

## 7. Population gate for promotion

Only `production_replay` (or better) evaluation data may promote a model.
`unaudited`, `partial`, and `sample_only` data are never promotion-eligible.

## 8. Related

- `docs/CALIBRATION_GOVERNANCE.md`
- `docs/EVALUATION_METHOD.md`
- `docs/REMAINING_RISKS.md`
