-- Immutable prediction runs, decisions, market observations, outcomes, settlements,
-- reconciliation quarantine, and outbox. Legacy picks/bet_ledger remain for compatibility.

CREATE TABLE IF NOT EXISTS prediction_runs (
  run_id TEXT PRIMARY KEY,
  game_pk TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT 'moneyline',
  date_ymd TEXT,
  prediction_timestamp_utc TEXT,
  as_of_utc TEXT,
  first_pitch_utc TEXT,
  model_version TEXT,
  feature_version TEXT,
  calibration_version TEXT,
  bet_policy_version TEXT,
  snapshot_hash TEXT,
  payload TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prediction_runs_game ON prediction_runs(game_pk);
CREATE INDEX IF NOT EXISTS idx_prediction_runs_date ON prediction_runs(date_ymd);

CREATE TABLE IF NOT EXISTS market_observations (
  observation_id TEXT PRIMARY KEY,
  game_pk TEXT NOT NULL,
  market TEXT NOT NULL,
  side TEXT,
  bookmaker TEXT,
  odds REAL,
  line REAL,
  implied_prob REAL,
  observed_at_utc TEXT,
  fetched_at_utc TEXT,
  source TEXT,
  is_closing INTEGER NOT NULL DEFAULT 0,
  payload TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_market_obs_game ON market_observations(game_pk, market);

CREATE TABLE IF NOT EXISTS prediction_decisions (
  decision_id TEXT PRIMARY KEY,
  run_id TEXT,
  game_pk TEXT NOT NULL,
  date_ymd TEXT,
  market TEXT NOT NULL DEFAULT 'moneyline',
  model_pick_team_id TEXT,
  model_pick_team_name TEXT,
  model_home_prob REAL,
  model_away_prob REAL,
  pure_model_home_prob REAL,
  pure_model_away_prob REAL,
  calibrated_home_prob REAL,
  calibrated_away_prob REAL,
  display_pick_team_id TEXT,
  display_pick_source TEXT,
  value_bet_team_id TEXT,
  value_bet_team_name TEXT,
  value_side TEXT,
  value_model_prob REAL,
  market_fair_prob REAL,
  edge REAL,
  odds REAL,
  bookmaker TEXT,
  quote_id TEXT,
  status TEXT,
  reason_codes TEXT,
  units_staked REAL,
  kelly_stake_percent REAL,
  decision_hash TEXT,
  payload TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(game_pk, market)
);

CREATE INDEX IF NOT EXISTS idx_prediction_decisions_game ON prediction_decisions(game_pk);
CREATE INDEX IF NOT EXISTS idx_prediction_decisions_status ON prediction_decisions(status);

CREATE TABLE IF NOT EXISTS game_outcomes (
  game_pk TEXT PRIMARY KEY,
  date_ymd TEXT,
  home_team_id TEXT,
  away_team_id TEXT,
  home_score INTEGER,
  away_score INTEGER,
  winner_team_id TEXT,
  loser_team_id TEXT,
  first_inning_any_run INTEGER,
  payload TEXT,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settlements (
  settlement_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL,
  game_pk TEXT NOT NULL,
  market TEXT NOT NULL,
  selected_team_id TEXT,
  selected_side TEXT,
  result TEXT NOT NULL,
  units_staked REAL,
  units_pl REAL,
  odds REAL,
  clv REAL,
  closing_odds REAL,
  settled_at TEXT NOT NULL,
  UNIQUE(decision_id),
  UNIQUE(game_pk, market)
);

CREATE INDEX IF NOT EXISTS idx_settlements_game ON settlements(game_pk);

CREATE TABLE IF NOT EXISTS reconciliation_issues (
  issue_id TEXT PRIMARY KEY,
  game_pk TEXT,
  decision_id TEXT,
  issue_type TEXT NOT NULL,
  severity TEXT,
  detail TEXT,
  payload TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_recon_open ON reconciliation_issues(issue_type, resolved_at);

CREATE TABLE IF NOT EXISTS outbox (
  outbox_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_id TEXT,
  payload TEXT,
  created_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  processed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(processed_at, available_at);
