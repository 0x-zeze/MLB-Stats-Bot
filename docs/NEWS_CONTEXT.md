# External News Context

Bot supports optional, display-only external news context for pregame MLB analysis.

## Sources

Configure only public RSS/Atom feeds permitted by source Terms/API policy. Supported source labels are configurable. Verified feeds currently include `mlbtr` (MLB Trade Rumors), `cbssports` (CBS Sports MLB), and `baseballamerica` (Baseball America). Feed host must match explicit `allowedHosts`. JSON endpoints are not supported yet.

Bot does not scrape full article pages. It stores/displays bounded title, short summary, source, publication time, and URL attribution.

## Configuration

```text
NEWS_ENABLED=false
NEWS_FEEDS_JSON=[]
NEWS_REQUEST_TIMEOUT_MS=8000
NEWS_CACHE_TTL_MINUTES=15
NEWS_STALE_IF_ERROR_HOURS=12
NEWS_MAX_RESPONSE_BYTES=1000000
NEWS_MAX_ITEMS_PER_FEED=25
NEWS_MAX_ARTICLES_PER_GAME=5
NEWS_MAX_TITLE_CHARS=240
NEWS_MAX_SUMMARY_CHARS=600
NEWS_MAX_AGE_HOURS=48
NEWS_INCLUDE_PICKS=false
NEWS_INCLUDE_ALERTS=false
```

`NEWS_FEEDS_JSON` example:

```json
[{"source":"mlb","name":"MLB","url":"https://permitted.example/feed.xml","allowedHosts":["example"]}]
```

Feature disabled by default. Invalid feed config returns no feeds. Feed failure never blocks model prediction.

## Risk veto (keyword flags)

When `NEWS_RISK_VETO=true` (default), matched articles may force **VALUE → NO BET** only:

| Flag | Severity | Example keywords |
|---|---|---|
| `sp_scratch` | critical | scratched, will not start, late scratch |
| `opener_bulk` | high | opener, bulk pitcher, bullpen game |
| `injury_il` | high | placed on IL, season-ending, out indefinitely |
| `day_to_day` | medium | day-to-day, game-time decision (only if lineup not confirmed) |
| `lineup_uncertain` | medium | projected/expected lineup (only if lineup not confirmed) |
| `postponed` | critical | postponed, rainout, suspended |

Rules:

- News **never** changes model probability, edge math, Kelly stake, or calibration.
- Veto only adds reasons and sets `betDecision.status = NO BET` after market grading.
- Medium flags are ignored once both lineups are fully confirmed (9/9).
- No X/Twitter scraping. RSS/Atom only.

## Data and safety

- News is Tier 3 context. Probability impact is always `none`. Optional veto only changes bet **status** to NO BET (wait/skip), not the model numbers.
- Article fields are untrusted data, never instructions to analyst LLM.
- Feed `publishedAt` is observation evidence, not proof of system availability. Without explicit `availableAt`, provenance is `historical_unverified` and not promotion-safe.
- Articles after prediction cutoff are excluded. Post-first-pitch content cannot enter pregame decision snapshots.
- First news feature snapshot is write-once. Later refreshes may update display context but cannot mutate immutable prediction snapshot hash/as-of/core inputs.
- Fresh cache is used before network. Expired cache is used as `stale` on transient errors within stale-if-error window. No cache plus failure is `unavailable`.
- XML responses/items/fields are bounded. Markup is stripped. Full article body is not fetched.
- Content type `analysis`/`opinion` is accepted only from feed metadata/source configuration; bot never invents expert attribution.

## Verified feed checks (2026-07-30)

| Source | URL | Result |
|---|---|---|
| MLB Trade Rumors | `https://www.mlbtraderumors.com/feed` | HTTP 200; RSS; 15 items observed |
| CBS Sports MLB | `https://www.cbssports.com/rss/headlines/mlb/` | HTTP 200; RSS; 36 items observed |
| Baseball America | `https://www.baseballamerica.com/feed/` | HTTP 200; RSS; 30 items observed |
| MLB candidate | `https://www.mlb.com/feeds/news/rss.xml` | HTTP 403 from server; disabled |
| ESPN candidate | `https://www.espn.com/espn/rss/mlb/news` | HTTP 403 from server; disabled |
| FanGraphs candidate | `https://www.fangraphs.com/feed` | HTML 404 page; disabled |

HTTP 200 proves feed retrieval from current server, not permission to republish article content. Keep source Terms and attribution review active.

## Output

`/news` uses supplied articles and deterministic fallback when analyst LLM is unavailable. Output includes source and publication timestamp. `/picks` and full alerts include external headlines only when explicitly enabled.
