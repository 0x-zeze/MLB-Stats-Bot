# Betting Ledger

## Current (compatibility) model

Primary tables still used by Telegram:

- `picks` — mutable per `game_pk` (UPSERT)
- `bet_ledger` — one row per `(game_pk, market)` for VALUE stakes

### VALUE recording (`recordBet`)

Records only when:

- `betDecision.status === 'VALUE'`
- no blocking reasons
- `valuePick.kellyStakePercent > 0`

Persists:

- side, team name, odds, fair/model prob, edge, stake
- **selected_team_id**, model_pick_team_id, bookmaker, quote_id, decision_hash, versions (when present)

### Settlement

- P/L uses **ledger side / selected_team_id**, never display `prediction.pick` alone.
- American odds: win = stake × profit multiple; loss = −stake; push = 0.
- Idempotent: only `status='open'` rows update; requires `changes === 1`.
- Mirrored into `settlements` when migration applied.

### Post-game order

Preferred path: `processPostGameOutcome`:

1. Outcome/memory (idempotent on gamePk in learning log)
2. Settle open VALUE bet
3. Mark `post_game_processed` only after settle path succeeds
4. Outbox event

Stranded open+processed rows are retried on later post-game runs.

### CLV

- Side = ledger/value side (not display pick).
- CLV ≈ closing_implied − opening_implied (percentage points).
- Close should be last pre-first-pitch quote (capture path separate).

## Authoritative target tables

| Table | Role |
|-------|------|
| `prediction_runs` | Immutable run identity + versions + snapshot hash |
| `prediction_decisions` | model pick vs value bet vs display |
| `market_observations` | append-only quotes |
| `game_outcomes` | final scores |
| `settlements` | idempotent financial result |
| `reconciliation_issues` | quarantine |
| `outbox` | post-commit proposals/side effects |

## ROI definition

```text
ROI = sum(units_pl) / sum(units_staked)
```

Missing stake data is not silently treated as perfect performance.

## Migration

```bash
node scripts/run_migrations.js --status
node scripts/run_migrations.js --apply
```

Storage constructor also applies migrations on open.
