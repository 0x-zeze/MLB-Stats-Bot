# Migration note: yrfi_results (archive-only)

**Date:** 2026-08-04  
**Change:** YRFI/NRFI (first-inning-run) market removed from the bot.

## What changed
- Application code no longer writes to or reads from `yrfi_results`.
- `writeYrfiOutcome` was deleted from `src/storage.js`.
- First-inning prediction, calibration, Telegram display, and grading paths removed.

## Why
Historical analysis found no per-game edge (near-zero correlation with outcomes;
overconfidence in high probability bins). The market was already advisory-only
(`YRFI_ACTIVE` off by default).

## What NOT to do
- Do **not** `DROP TABLE yrfi_results` on production databases.
- Historical rows remain for audit / research.

## Schema
`CREATE TABLE IF NOT EXISTS yrfi_results` may still run on startup so existing
DBs keep the table structure. New installs may create an empty table; that is
harmless.
