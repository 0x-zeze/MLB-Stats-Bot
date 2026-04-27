# MLB Telegram Alert Agent

Bot Telegram sederhana untuk cek alert pre-game MLB: jadwal, probable pitcher, stats inti, persentase kemenangan, dan alasan singkat.

## Setup

1. Buat bot lewat Telegram `@BotFather`, lalu ambil token.
2. Isi minimal di `.env`:

```env
TELEGRAM_BOT_TOKEN=isi_token_botfather
TELEGRAM_CHAT_ID=isi_chat_id_opsional
TIMEZONE=Asia/Jakarta
```

Cara paling mudah dapat `TELEGRAM_CHAT_ID`: jalankan bot, kirim `/chatid` di Telegram.

## Jalan

```bash
npm start
```

Untuk test sekali tanpa polling:

```bash
npm run once
```

Jika `TELEGRAM_BOT_TOKEN` dan `TELEGRAM_CHAT_ID` diisi, mode `once` akan kirim alert ke Telegram. Kalau belum, output dicetak ke terminal.

## Command Telegram

- `/start` atau `/help` - lihat command.
- `/today` - alert game hari ini.
- `/deep` - alert hari ini dengan advanced stats.
- `/date 2026-04-27` - alert tanggal tertentu.
- `/game Yankees` - cari game tim tertentu hari ini.
- `/ask kenapa Yankees dipilih?` - tanya Analyst Agent.
- Pesan biasa tanpa slash juga dianggap pertanyaan ke Agent.
- `/agent` - lihat status Analyst Agent.
- `/skill` - lihat playbook analisa Agent.
- `/postgame 2026-04-27` - cek hasil final, bandingkan pick, lalu update memory.
- `/memory` - lihat akurasi dan learning terakhir.
- `/subscribe` - chat ini akan menerima auto-alert.
- `/unsubscribe` - berhenti auto-alert.
- `/sendalert` - kirim alert hari ini ke semua subscriber.
- `/chatid` - tampilkan chat id.

## Auto Alert

Aktifkan di `.env`:

```env
AUTO_ALERTS=true
DAILY_ALERT_TIME=20:00
```

Bot akan mengirim alert harian sesuai `TIMEZONE`.

## Interaktif Di Telegram

Aktif secara default:

```env
INTERACTIVE_AGENT=true
PRINT_ALERT_TO_TERMINAL=false
```

Contoh chat:

```text
/ask game mana yang edge-nya paling kuat hari ini?
/ask upset risk terbesar?
/ask bandingkan Yankees vs Rangers
kenapa Dodgers dipilih?
```

Terminal hanya dipakai untuk log. Kalau ingin debug dan mencetak alert ke terminal:

```env
PRINT_ALERT_TO_TERMINAL=true
```

## Post-game Recap & Memory

Aktif secara default:

```env
POST_GAME_ALERTS=true
POST_GAME_POLL_MINUTES=5
MODEL_MEMORY=true
```

Cara kerjanya:

1. Saat pre-game alert dibuat, pick disimpan ke `data/state.json`.
2. Bot mengecek game yang sudah final setiap `POST_GAME_POLL_MINUTES`.
3. Kalau hasil final tersedia, bot mengirim recap post-game.
4. Jika pick salah, memory menyimpan error dan memberi adjustment kecil untuk prediksi berikutnya.

Memory hanya dipakai sebagai bias kecil, bukan pengganti stats utama.

## Detail Alert

Default-nya ringkas. Untuk selalu menampilkan advanced stats:

```env
ALERT_DETAIL=full
```

Kalau tetap `compact`, kamu masih bisa pakai `/deep` dari Telegram kapan saja.

## OpenAI Opsional

Kalau ingin Analyst Agent membuat pick final:

```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
ANALYST_AGENT=true
ANALYST_AGENT_MODE=local
```

Alurnya:

```text
MLB stats + standings + H2H + memory
  -> baseline model
  -> Analyst Agent
  -> Telegram alert
  -> post-game evaluator
  -> memory update
```

Jika agent aktif, alert menampilkan `🤖 Agent` sebagai probabilitas final dan `📐 Baseline` sebagai pembanding. Post-game memory mengevaluasi pick agent.

Agent memakai playbook `mlb-analyst-v1.0` di [docs/analyst-playbook.md](E:/AI/MLB/docs/analyst-playbook.md). Playbook ini menekankan process-over-results, run creation, run prevention, starter edge, H2H sebagai tie-breaker kecil, dan memory sebagai kalibrasi ringan.

Setiap game juga punya analisa:

```text
Will there be a run in the 1st inning?
YES / YRFI atau NO / NRFI
```

Sinyalnya berasal dari riwayat team scored/allowed first inning, recent first-inning any-run, H2H first inning, dan starter hari itu.

Agent juga menerima sinyal tambahan:

- Bullpen fatigue 3 hari terakhir: pitch count, IP, back-to-back relievers, high-pitch relievers.
- Starting pitcher recent form: last 5 starts, ERA, WHIP, K/BB, HR, average pitches.
- Team splits vs handedness: record vs LHP/RHP dan home/road split sesuai starter lawan.
- Dashboard memory: akurasi full-game pick, confidence bucket, dan YRFI/NRFI.

Kalau kamu punya agent eksternal sendiri:

```env
ANALYST_AGENT_MODE=external
ANALYST_AGENT_URL=http://localhost:8000/mlb/analyze
ANALYST_AGENT_API_KEY=
```

Endpoint eksternal menerima JSON berisi `games`, `memory`, dan kontrak output. Balikan yang diharapkan:

```json
{
  "analyses": [
    {
      "gamePk": 123,
      "pickTeamId": 147,
      "awayProbability": 42,
      "homeProbability": 58,
      "confidence": "medium",
      "reasons": ["..."],
      "risk": "...",
      "memoryNote": "..."
    }
  ]
}
```

## Sumber Data

- MLB schedule/probable pitcher/team stats/standings: `statsapi.mlb.com`
- Telegram Bot API: `core.telegram.org/bots/api`
- OpenAI Responses API: `platform.openai.com/docs/api-reference/responses`
- Referensi endpoint GitHub: `github.com/toddrob99/MLB-StatsAPI/wiki/Endpoints`

Stats tambahan yang dipakai: L10, home/road record, run differential, expected W-L, streak, H2H record/probability, first-inning scored/allowed/recent/H2H profile, bullpen fatigue, pitcher recent starts, splits vs LHP/RHP, post-game outcome memory, ISO, K%, BB%, pitching K-BB%, HR/9, SP ERA/WHIP.
