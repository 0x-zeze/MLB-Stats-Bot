---
type: regression
date: 2026-06-15
emitted_by: mlb-regression-flagger
mode: top-movers-mlb
data_source: Baseball Savant expected_statistics + statcast CSV (live pull 2026-06-15)
note_on_secondary: >
  BABIP/HR-FB/LOB% dari FanGraphs tidak ditarik (web fetch gagal). Sebagai gantinya
  dipakai cross-check kontak dari Savant (Barrel%, Hard-Hit% utk hitter; Barrel%-allowed
  utk pitcher), yang per guardrail #5 lebih robust dari BABIP saja. Metrik PRIMER
  (xwOBA/xERA) terverifikasi dari Savant, jadi confidence tidak diturunkan ke 0.3.
source_urls:
  - https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=2026&min=q&csv=true
  - https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=2026&min=q&csv=true
  - https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=2026&min=q&csv=true
  - https://baseballsavant.mlb.com/leaderboard/statcast?type=pitcher&year=2026&min=q&csv=true
players:
  - name: Will Smith
    role: hitter
    pa: 201
    woba: 0.323
    xwoba: 0.386
    barrel_pct: 13.4
    hardhit_pct: 39.4
    regression_index: 32
    direction: BUY
    confidence: 0.80
  - name: Lawrence Butler
    role: hitter
    pa: 187
    woba: 0.244
    xwoba: 0.306
    barrel_pct: 5.9
    hardhit_pct: 45.3
    regression_index: 31
    direction: BUY
    confidence: 0.78
  - name: Austin Wells
    role: hitter
    pa: 169
    woba: 0.247
    xwoba: 0.301
    barrel_pct: 6.9
    hardhit_pct: 44.6
    regression_index: 27
    direction: BUY
    confidence: 0.76
  - name: Mookie Betts
    role: hitter
    pa: 157
    woba: 0.272
    xwoba: 0.325
    barrel_pct: 8.1
    hardhit_pct: 37.1
    regression_index: 26
    direction: BUY
    confidence: 0.74
  - name: Victor Caratini
    role: hitter
    pa: 192
    woba: 0.279
    xwoba: 0.331
    barrel_pct: 6.2
    hardhit_pct: 39.5
    regression_index: 26
    direction: BUY
    confidence: 0.66
  - name: Luis Rengifo
    role: hitter
    pa: 205
    woba: 0.247
    xwoba: 0.296
    barrel_pct: 5.0
    hardhit_pct: 34.8
    regression_index: 24
    direction: BUY
    confidence: 0.64
  - name: Ernie Clement
    role: hitter
    pa: 283
    woba: 0.343
    xwoba: 0.274
    barrel_pct: 2.8
    hardhit_pct: 25.6
    regression_index: -34
    direction: SELL
    confidence: 0.82
  - name: Zack Gelof
    role: hitter
    pa: 195
    woba: 0.345
    xwoba: 0.288
    barrel_pct: 8.3
    hardhit_pct: 41.4
    regression_index: -28
    direction: SELL
    confidence: 0.62
  - name: Tristan Peters
    role: hitter
    pa: 194
    woba: 0.360
    xwoba: 0.305
    barrel_pct: 4.9
    hardhit_pct: 26.8
    regression_index: -27
    direction: SELL
    confidence: 0.74
  - name: Ceddanne Rafaela
    role: hitter
    pa: 254
    woba: 0.354
    xwoba: 0.301
    barrel_pct: 6.6
    hardhit_pct: 36.8
    regression_index: -26
    direction: SELL
    confidence: 0.68
  - name: Christian Yelich
    role: hitter
    pa: 173
    woba: 0.340
    xwoba: 0.292
    barrel_pct: 5.7
    hardhit_pct: 35.8
    regression_index: -24
    direction: SELL
    confidence: 0.68
  - name: Mickey Moniak
    role: hitter
    pa: 164
    woba: 0.400
    xwoba: 0.324
    barrel_pct: 13.5
    hardhit_pct: 41.4
    regression_index: -38
    direction: WATCHLIST
    confidence: 0.45
    note: "index SELL -38 TAPI Barrel% 13.5% elite = kontak berkualitas. Sinyal konflik (Pattern 5) -> watchlist, bukan SELL keras."
  - name: Andrew Painter
    role: pitcher
    tbf: 285
    era: 6.43
    xera: 4.85
    barrel_pct_allowed: 9.0
    regression_index: 79
    direction: BUY
    confidence: 0.72
  - name: Aaron Nola
    role: pitcher
    tbf: 309
    era: 5.86
    xera: 4.39
    barrel_pct_allowed: 9.3
    regression_index: 74
    direction: BUY
    confidence: 0.74
  - name: Trevor Rogers
    role: pitcher
    tbf: 266
    era: 6.15
    xera: 4.69
    barrel_pct_allowed: 7.5
    regression_index: 73
    direction: BUY
    confidence: 0.74
  - name: Tomoyuki Sugano
    role: pitcher
    tbf: 287
    era: 4.08
    xera: 7.55
    barrel_pct_allowed: 15.5
    regression_index: -100
    direction: SELL
    confidence: 0.82
  - name: Randy Vásquez
    role: pitcher
    tbf: 313
    era: 3.63
    xera: 6.21
    barrel_pct_allowed: 13.0
    regression_index: -100
    direction: SELL
    confidence: 0.78
  - name: Eduardo Rodriguez
    role: pitcher
    tbf: 336
    era: 2.54
    xera: 4.82
    barrel_pct_allowed: 8.2
    regression_index: -100
    direction: SELL
    confidence: 0.68
---

# Regression candidates — 2026-06-15 (Top Movers MLB)

Rumus: hitter `idx = clamp((xwOBA−wOBA)×500, ±100)`; pitcher `idx = clamp((ERA−xERA)×50, ±100)`. Positif = sial (BUY), negatif = mujur (SELL).

## Hitters

### BUY (sial — angka harusnya lebih baik)

| Player | PA | wOBA | xwOBA | Barrel% | HardHit% | Index | Action |
|--------|----|------|-------|---------|----------|-------|--------|
| Will Smith | 201 | .323 | .386 | 13.4 | 39.4 | **+32** | BUY agresif |
| Lawrence Butler | 187 | .244 | .306 | 5.9 | 45.3 | **+31** | BUY agresif |
| Austin Wells | 169 | .247 | .301 | 6.9 | 44.6 | +27 | BUY |
| Mookie Betts | 157 | .272 | .325 | 8.1 | 37.1 | +26 | BUY |
| Victor Caratini | 192 | .279 | .331 | 6.2 | 39.5 | +26 | BUY (kontak modest) |
| Luis Rengifo | 205 | .247 | .296 | 5.0 | 34.8 | +24 | BUY (kontak modest) |

### SELL (mujur — angka harusnya lebih buruk)

| Player | PA | wOBA | xwOBA | Barrel% | HardHit% | Index | Action |
|--------|----|------|-------|---------|----------|-------|--------|
| Ernie Clement | 283 | .343 | .274 | 2.8 | 25.6 | **-34** | SELL agresif |
| Zack Gelof | 195 | .345 | .288 | 8.3 | 41.4 | -28 | SELL (kontak agak kuat → hati2) |
| Tristan Peters | 194 | .360 | .305 | 4.9 | 26.8 | -27 | SELL |
| Ceddanne Rafaela | 254 | .354 | .301 | 6.6 | 36.8 | -26 | SELL |
| Christian Yelich | 173 | .340 | .292 | 5.7 | 35.8 | -24 | SELL |

### WATCHLIST (sinyal konflik)

| Player | PA | wOBA | xwOBA | Barrel% | Index | Catatan |
|--------|----|------|-------|---------|-------|---------|
| Mickey Moniak | 164 | .400 | .324 | 13.5 | -38 | Index teriak SELL, tapi Barrel% 13.5% elite. Kontak bagus → jangan SELL buta. |

## Pitchers (starter, TBF ≥ 250)

### BUY (sial — ERA harusnya lebih rendah)

| Player | TBF | ERA | xERA | Barrel%-allowed | Index | Action |
|--------|-----|-----|------|------------------|-------|--------|
| Andrew Painter | 285 | 6.43 | 4.85 | 9.0 | **+79** | BUY |
| Aaron Nola | 309 | 5.86 | 4.39 | 9.3 | **+74** | BUY |
| Trevor Rogers | 266 | 6.15 | 4.69 | 7.5 | **+73** | BUY |

### SELL (mujur — ERA harusnya lebih tinggi)

| Player | TBF | ERA | xERA | Barrel%-allowed | Index | Action |
|--------|-----|-----|------|------------------|-------|--------|
| Tomoyuki Sugano | 287 | 4.08 | 7.55 | 15.5 | **-100** | SELL agresif |
| Randy Vásquez | 313 | 3.63 | 6.21 | 13.0 | **-100** | SELL agresif |
| Eduardo Rodriguez | 336 | 2.54 | 4.82 | 8.2 | **-100** | SELL |

## Caveats
- Reliever sampel kecil (TBF 100-164) sengaja DIBUANG — semua mentok clamp ±100 dan noisy.
- BUY pitcher Painter/Nola/Rogers: index tinggi karena ERA jauh di atas xERA, TAPI xERA mereka tetap 4.4-4.9 (bukan ace). Artinya "lebih baik dari ERA sekarang", bukan "akan jadi elite".
- Moniak satu-satunya nama WATCHLIST: Barrel% elite bertabrakan dengan index SELL.
