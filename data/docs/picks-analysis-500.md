# Analisa Picks — Peningkatan Edge Prediksi

Dataset: **1072 outcome tergradasi** dari `data/evolution/prediction_outcomes.csv` (seluruh riwayat, di-breakdown per market).

> Catatan: user menyebut "500 picks"; jumlah riil dataset lebih besar. Analisa memakai SEMUA baris agar sinyal kalibrasi sekuat mungkin.

## Ringkasan Keseluruhan

| Metrik | Nilai |
|---|---|
| Sample (decided) | 1066 / 1072 |
| Win rate | 53.8% |
| ROI (per unit) | 6.2% |
| Brier model | 0.2528 |
| Brier baseline (flat 50%) | 0.25 |
| **Lift Brier (baseline − model)** | **-0.0028** |
| Log-loss | 0.6995 |

Lift Brier positif = model lebih baik dari tebak koin; negatif = model lebih buruk dari sekadar 50%.

## Per Market

### MONEYLINE

| Metrik | Nilai |
|---|---|
| Sample (decided) | 588 / 588 |
| Win rate | 54.9% |
| ROI | 7.5% |
| Brier model | 0.2489 |
| Brier baseline | 0.25 |
| Lift Brier | 0.0011 |
| Log-loss | 0.6912 |

Arah miscalibration: **1 bucket overconfident, 0 underconfident, 4 terkalibrasi.**

| Bucket | n | Prob prediksi | Win rate observasi | Error | Verdict |
|---|---|---|---|---|---|
| 50-55 | 160 | 52.4% | 55.6% | +3.3 | calibrated |
| 55-60 | 236 | 55.6% | 52.5% | -3.1 | calibrated |
| 60-65 | 79 | 61.1% | 55.7% | -4.7 | calibrated |
| 65-70 | 51 | 66.6% | 51.0% | -16.3 | overconfident |
| 70+ | 62 | 70.0% | 64.5% | -5.4 | calibrated |

### TOTALS

| Metrik | Nilai |
|---|---|
| Sample (decided) | 286 / 292 |
| Win rate | 54.9% |
| ROI | 9.8% |
| Brier model | 0.2535 |
| Brier baseline | 0.25 |
| Lift Brier | -0.0035 |
| Log-loss | 0.7019 |

Arah miscalibration: **2 bucket overconfident, 0 underconfident, 3 terkalibrasi.**

| Bucket | n | Prob prediksi | Win rate observasi | Error | Verdict |
|---|---|---|---|---|---|
| 50-55 | 60 | 52.7% | 48.3% | -3.2 | calibrated |
| 55-60 | 86 | 57.9% | 55.8% | -2.5 | calibrated |
| 60-65 | 68 | 62.4% | 58.8% | -3.8 | calibrated |
| 65-70 | 38 | 67.1% | 55.3% | -12.8 | overconfident |
| 70+ | 34 | 77.0% | 55.9% | -20.7 | overconfident |

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
| clv:flat | 18 | 35.3% | 64.7% | 0.2753 |
| market:yrfi | 192 | 48.4% | 51.6% | 0.2635 |
| data_quality:low | 192 | 48.4% | 51.6% | 0.2635 |
| probability:65-70 | 109 | 51.9% | 48.1% | 0.2717 |
| probability:50-55 | 291 | 52.1% | 47.9% | 0.2489 |
| confidence:medium | 228 | 52.2% | 47.8% | 0.2595 |
| edge:weak <2 | 573 | 52.4% | 47.6% | 0.256 |
| side:under | 107 | 52.4% | 47.6% | 0.2631 |

## CLV (Closing Line Value)

- Sample dengan CLV: **46** (status: tracking)
- Rata-rata CLV: -0.2059
- Positif/negatif/flat: 12/16/18
- Positive CLV means the market moved toward the agent's side after the pick.
- Sampel masih tipis (46 < 50) — terlalu sedikit untuk menyimpulkan edge pasar; varians per-bet besar. Biarkan menumpuk dulu. Rata-rata CLV negatif (-0.2059) = harga rata-rata sedikit lebih buruk dari closing — pantau, jangan disimpulkan sampai sampel tebal.

| Market | Sample CLV | Rata-rata | +/−/flat |
|---|---|---|---|
| moneyline | 20 | -0.4985 | 7/11/2 |
| totals | 26 | 0.0192 | 5/5/16 |

## Temuan & Rekomendasi

- **moneyline**: overconfidence dominan (1 vs 0 bucket). Pertahankan/perketat dampening.
- **totals**: lift Brier -0.0035 ≤ 0 — model TIDAK mengalahkan tebak-50%. Kalibrasi/threshold market ini perlu perbaikan paling mendesak.
- **totals**: overconfidence dominan (2 vs 0 bucket). Pertahankan/perketat dampening.
- **yrfi**: lift Brier -0.0135 ≤ 0 — model TIDAK mengalahkan tebak-50%. Kalibrasi/threshold market ini perlu perbaikan paling mendesak.
- **yrfi**: overconfidence dominan (3 vs 0 bucket). Pertahankan/perketat dampening.
- **CLV**: hanya 46 sampel — terlalu tipis untuk menilai edge pasar. Pastikan opening + closing odds tersimpan untuk setiap pick.
