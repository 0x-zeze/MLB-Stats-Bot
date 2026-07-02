# Analisa Picks — Moneyline Weekly Edge

Dataset: **993 outcome aktif** dari `data/evolution/prediction_outcomes.csv`, dipisah per market.

> Fokus utama: moneyline-only. YRFI dipisah karena historis advisory/negatif, jadi tidak boleh menutupi edge moneyline.

> Catatan tracking: semua moneyline prediksi yang tersimpan sebelum game bisa diaudit. `VALUE` tetap ledger bet; `LEAN/NO BET` tetap berguna sebagai audit/shadow sample dan tidak dihitung sebagai staked ROI.

## Ringkasan Aktif (Moneyline + YRFI)

| Metrik | Nilai |
|---|---:|
| Sample (decided) | 993 / 993 |
| Win rate | 53.9% |
| ROI (per unit) | 4.0% |
| Brier model | 0.2515 |
| Brier baseline (flat 50%) | 0.25 |
| Lift Brier (baseline − model) | -0.0015 |
| Log-loss | 0.6966 |

## Per Market

### MONEYLINE

| Metrik | Nilai |
|---|---|
| Sample (decided) | 801 / 801 |
| Win rate | 55.2% |
| ROI | 5.7% |
| Brier model | 0.2486 |
| Brier baseline | 0.25 |
| Lift Brier | 0.0014 |
| Log-loss | 0.6906 |
| CLV sample | 223 |
| Avg CLV | -0.3594 |

Arah miscalibration: **1 bucket overconfident, 0 underconfident, 4 terkalibrasi.**

| Bucket | n | Prob prediksi | Win rate observasi | Error | Verdict |
|---|---:|---:|---:|---:|---|
| 50-55 | 233 | 52.5% | 56.7% | +4.2 | calibrated |
| 55-60 | 359 | 56.4% | 52.1% | -4.6 | calibrated |
| 60-65 | 96 | 61.0% | 59.4% | -0.2 | calibrated |
| 65-70 | 51 | 66.6% | 51.0% | -16.3 | overconfident |
| 70+ | 62 | 70.0% | 64.5% | -5.4 | calibrated |

### YRFI

| Metrik | Nilai |
|---|---|
| Sample (decided) | 192 / 192 |
| Win rate | 48.4% |
| ROI | -3.1% |
| Brier model | 0.2635 |
| Brier baseline | 0.25 |
| Lift Brier | -0.0135 |
| Log-loss | 0.7216 |
| CLV sample | 0 |
| Avg CLV | n/a |

Arah miscalibration: **3 bucket overconfident, 0 underconfident, 2 terkalibrasi.**

| Bucket | n | Prob prediksi | Win rate observasi | Error | Verdict |
|---|---:|---:|---:|---:|---|
| 50-55 | 70 | 51.7% | 47.1% | -4.3 | calibrated |
| 55-60 | 68 | 56.8% | 51.5% | -5.1 | calibrated |
| 60-65 | 29 | 61.6% | 48.3% | -13.7 | overconfident |
| 65-70 | 19 | 66.4% | 47.4% | -19.8 | overconfident |
| 70+ | 6 | 71.3% | 33.3% | -38.7 | overconfident |

## Moneyline Weekly Cohorts

Target 70% di sini = **win rate dari total moneyline picks dalam satu minggu**, bukan probabilitas tiap tim harus 70%. Weekly cohort membantu lihat apakah volume cukup untuk diaudit.

Minimum sample sehat per minggu: **20 moneyline decided picks**.

| Week | Decided | W-L | WR | ROI | Brier | CLV | Target 70% | Sample |
|---|---:|---:|---:|---:|---:|---:|---|---|
| 2026-04-27→2026-05-03 | 63 | 34-29 | 54.0% | 7.9% | 0.2485 | n/a | butuh 11W lagi | OK |
| 2026-05-04→2026-05-10 | 94 | 49-45 | 52.1% | 4.3% | 0.2504 | n/a | butuh 17W lagi | OK |
| 2026-05-11→2026-05-17 | 62 | 33-29 | 53.2% | 6.5% | 0.2593 | n/a | butuh 11W lagi | OK |
| 2026-05-18→2026-05-24 | 94 | 50-44 | 53.2% | 6.4% | 0.2485 | n/a | butuh 16W lagi | OK |
| 2026-05-25→2026-05-31 | 94 | 62-32 | 66.0% | 31.9% | 0.2337 | n/a | butuh 4W lagi | OK |
| 2026-06-01→2026-06-07 | 92 | 46-46 | 50.0% | -12.1% | 0.2618 | n/a | butuh 19W lagi | OK |
| 2026-06-08→2026-06-14 | 89 | 49-40 | 55.1% | 7.1% | 0.2432 | -0.4985 | butuh 14W lagi | OK |
| 2026-06-15→2026-06-21 | 89 | 52-37 | 58.4% | 5.8% | 0.2466 | -0.2659 | butuh 11W lagi | OK |
| 2026-06-22→2026-06-28 | 96 | 51-45 | 53.1% | -4.1% | 0.2531 | -0.2385 | butuh 17W lagi | OK |
| 2026-06-29→2026-07-05 | 28 | 16-12 | 57.1% | -0.3% | 0.2346 | -0.9384 | butuh 4W lagi | OK |

Qualified weeks: **10**, weeks ≥70%: **0**. Kalau jumlah hit-week rendah, jangan naikkan threshold probabilitas; cari segment/filter yang menaikkan weekly W-L tanpa mematikan volume audit.

## Moneyline Segmen Terkuat

| Segmen | Sample | W-L | Win rate | Loss rate | Avg Brier | Avg CLV |
|---|---:|---:|---:|---:|---:|---:|
| probability:70+ | 62 | 40-22 | 64.5% | 35.5% | 0.2319 | n/a |
| probability:60-65 | 96 | 57-39 | 59.4% | 40.6% | 0.2402 | -0.5743 |
| clv:positive | 97 | 57-40 | 58.8% | 41.2% | 0.2432 | 1.4359 |
| confidence:low | 475 | 271-204 | 57.1% | 42.9% | 0.2453 | -0.3594 |
| edge:moderate 2-5 | 154 | 88-66 | 57.1% | 42.9% | 0.2442 | -0.5742 |
| probability:50-55 | 233 | 132-101 | 56.7% | 43.3% | 0.2453 | -0.267 |
| market:moneyline | 801 | 442-359 | 55.2% | 44.8% | 0.2513 | -0.3594 |
| decision:bet_or_lean | 801 | 442-359 | 55.2% | 44.8% | 0.2513 | -0.3594 |

## Moneyline Segmen Terlemah

| Segmen | Sample | W-L | Win rate | Loss rate | Avg Brier | Avg CLV |
|---|---:|---:|---:|---:|---:|---:|
| probability:65-70 | 51 | 26-25 | 51.0% | 49.0% | 0.2738 | n/a |
| probability:55-60 | 359 | 187-172 | 52.1% | 47.9% | 0.2583 | -0.3905 |
| clv:negative | 113 | 59-54 | 52.2% | 47.8% | 0.2526 | -1.9418 |
| confidence:model | 326 | 171-155 | 52.5% | 47.5% | 0.26 | n/a |
| edge:weak <2 | 151 | 81-70 | 53.6% | 46.4% | 0.2481 | -0.356 |
| edge:strong 5+ | 496 | 273-223 | 55.0% | 45.0% | 0.2544 | -0.2358 |
| market:moneyline | 801 | 442-359 | 55.2% | 44.8% | 0.2513 | -0.3594 |
| decision:bet_or_lean | 801 | 442-359 | 55.2% | 44.8% | 0.2513 | -0.3594 |

## CLV

- Sample dengan CLV: **223** (status: tracking)
- Rata-rata CLV: -0.3594
- Positif/negatif/flat: 97/113/13
- Positive CLV means the market moved toward the agent's side after the pick.
- Sampel cukup (223) untuk mulai membaca arah edge pasar. Rata-rata CLV negatif (-0.3594) = harga rata-rata lebih buruk dari closing.

## Rekomendasi Praktis

- **Moneyline headline**: baca terpisah dari YRFI. Saat ini 442-359 (55.2%) dari 801 decided picks.
- **Weekly target 70%**: 10 qualified week masih di bawah target. Gunakan weekly table untuk audit penyebab, bukan menaikkan floor probabilitas secara buta.
- **Kalibrasi**: bucket probability:65-70 overconfident (51.0% actual vs 66.6% pred). Cap confidence/value untuk bucket ini sampai sample baru membaik.
- **YRFI tetap terpisah**: 93-99 (48.4%). Jangan campur ke headline moneyline.
