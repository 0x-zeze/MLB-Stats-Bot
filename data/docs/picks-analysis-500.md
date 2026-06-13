# Analisa Picks — Peningkatan Edge Prediksi

Dataset: **1024 outcome tergradasi** dari `data/evolution/prediction_outcomes.csv` (seluruh riwayat, di-breakdown per market).

> Catatan: user menyebut "500 picks"; jumlah riil dataset lebih besar. Analisa memakai SEMUA baris agar sinyal kalibrasi sekuat mungkin.

## Ringkasan Keseluruhan

| Metrik | Nilai |
|---|---|
| Sample (decided) | 1018 / 1024 |
| Win rate | 53.7% |
| ROI (per unit) | 6.2% |
| Brier model | 0.2529 |
| Brier baseline (flat 50%) | 0.25 |
| **Lift Brier (baseline − model)** | **-0.0029** |
| Log-loss | 0.6999 |

Lift Brier positif = model lebih baik dari tebak koin; negatif = model lebih buruk dari sekadar 50%.

## Per Market

### MONEYLINE

| Metrik | Nilai |
|---|---|
| Sample (decided) | 559 / 559 |
| Win rate | 55.5% |
| ROI | 8.6% |
| Brier model | 0.2484 |
| Brier baseline | 0.25 |
| Lift Brier | 0.0016 |
| Log-loss | 0.6903 |

Arah miscalibration: **1 bucket overconfident, 0 underconfident, 4 terkalibrasi.**

| Bucket | n | Prob prediksi | Win rate observasi | Error | Verdict |
|---|---|---|---|---|---|
| 50-55 | 138 | 52.5% | 56.5% | +4.2 | calibrated |
| 55-60 | 233 | 55.6% | 53.2% | -2.2 | calibrated |
| 60-65 | 75 | 61.1% | 56.0% | -4.3 | calibrated |
| 65-70 | 51 | 66.6% | 51.0% | -16.3 | overconfident |
| 70+ | 62 | 70.0% | 64.5% | -5.4 | calibrated |

### TOTALS

| Metrik | Nilai |
|---|---|
| Sample (decided) | 267 / 273 |
| Win rate | 53.9% |
| ROI | 7.9% |
| Brier model | 0.2546 |
| Brier baseline | 0.25 |
| Lift Brier | -0.0046 |
| Log-loss | 0.7044 |

Arah miscalibration: **2 bucket overconfident, 0 underconfident, 3 terkalibrasi.**

| Bucket | n | Prob prediksi | Win rate observasi | Error | Verdict |
|---|---|---|---|---|---|
| 50-55 | 58 | 52.7% | 46.6% | -5.3 | calibrated |
| 55-60 | 79 | 57.9% | 54.4% | -4.2 | calibrated |
| 60-65 | 64 | 62.3% | 57.8% | -4.9 | calibrated |
| 65-70 | 35 | 67.2% | 57.1% | -10.8 | overconfident |
| 70+ | 31 | 76.8% | 54.8% | -21.7 | overconfident |

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

Arah miscalibration: **3 bucket overconfident, 0 underconfident, 2 terkalibrasi.**

| Bucket | n | Prob prediksi | Win rate observasi | Error | Verdict |
|---|---|---|---|---|---|
| 50-55 | 70 | 51.7% | 47.1% | -4.3 | calibrated |
| 55-60 | 68 | 56.8% | 51.5% | -5.1 | calibrated |
| 60-65 | 29 | 61.6% | 48.3% | -13.7 | overconfident |
| 65-70 | 19 | 66.4% | 47.4% | -19.8 | overconfident |
| 70+ | 6 | 71.3% | 33.3% | -38.7 | overconfident |

## Segmen Terlemah (loss rate tertinggi)

| Segmen | Sample | Win rate | Loss rate | Avg Brier |
|---|---|---|---|---|
| calibration:overconfidence | 128 | 0.0% | 100.0% | 0.3978 |
| clv:flat | 17 | 37.5% | 62.5% | 0.2736 |
| market:yrfi | 192 | 48.4% | 51.6% | 0.2635 |
| data_quality:low | 192 | 48.4% | 51.6% | 0.2635 |
| confidence:medium | 221 | 51.6% | 48.4% | 0.2605 |
| side:under | 99 | 51.6% | 48.4% | 0.2656 |
| edge:weak <2 | 549 | 51.9% | 48.1% | 0.2567 |
| probability:50-55 | 267 | 51.9% | 48.1% | 0.2493 |

## CLV (Closing Line Value)

- Sample dengan CLV: **44** (status: tracking)
- Rata-rata CLV: -0.1925
- Positif/negatif/flat: 12/15/17
- Positive CLV means the market moved toward the agent's side after the pick.

## Temuan & Rekomendasi

- **moneyline**: overconfidence dominan (1 vs 0 bucket). Pertahankan/perketat dampening.
- **totals**: lift Brier -0.0046 ≤ 0 — model TIDAK mengalahkan tebak-50%. Kalibrasi/threshold market ini perlu perbaikan paling mendesak.
- **totals**: overconfidence dominan (2 vs 0 bucket). Pertahankan/perketat dampening.
- **yrfi**: lift Brier -0.0135 ≤ 0 — model TIDAK mengalahkan tebak-50%. Kalibrasi/threshold market ini perlu perbaikan paling mendesak.
- **yrfi**: overconfidence dominan (3 vs 0 bucket). Pertahankan/perketat dampening.
- **CLV**: hanya 44 sampel — terlalu tipis untuk menilai edge pasar. Pastikan opening + closing odds tersimpan untuk setiap pick.
