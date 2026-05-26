# Deployment

This guide covers a fresh VPS clone through a running Telegram bot, FastAPI dashboard API, and React dashboard.

## Requirements

- Ubuntu/Debian VPS or similar Linux host.
- Git.
- Node.js 18.15 or newer.
- Python 3.10 or newer with `pip`.
- Docker Engine and Docker Compose plugin for the Docker path.
- Telegram bot token from `@BotFather`.
- A domain name is recommended for HTTPS.

Optional API keys:

- `OPENAI_API_KEY` for OpenAI-compatible summaries or analyst features.
- `ODDS_API_KEY` or `THE_ODDS_API_KEY` for live odds.
- `OPENWEATHER_API_KEY` for weather enrichment.

## Fresh Clone

```bash
git clone https://github.com/grahito12/MLB-Stats-Bot.git
cd MLB-Stats-Bot
cp .env.example .env
```

Edit `.env` and set at minimum:

```env
TELEGRAM_BOT_TOKEN=your_botfather_token
TELEGRAM_CHAT_ID=your_chat_id
NODE_ENV=production
DASHBOARD_API_TOKEN=generate_with_openssl_rand_hex_32
DASHBOARD_CORS_ORIGINS=https://your-domain.example
```

Generate a dashboard token:

```bash
openssl rand -hex 32
```

Do not set `VITE_DASHBOARD_API_TOKEN` in production. The React login page stores the token in browser session storage after you enter it.

## Preflight Check

```bash
npm run doctor
```

The doctor command reports required env vars, Node/Python availability, expected files, dashboard API settings, Telegram config, and optional odds/weather keys.

## Docker Compose

Build and start:

```bash
docker compose up -d --build
```

Services:

- `bot`: Telegram bot and main app.
- `dashboard-api`: FastAPI backend on the internal Docker network.
- `dashboard-web`: Nginx serving the React build and proxying `/api` plus `/health`.

Persistent state is mapped from `./data` into containers. Secrets come from `.env`; none are hardcoded in `docker-compose.yml`.

Useful commands:

```bash
docker compose ps
docker compose logs -f bot
docker compose logs -f dashboard-api
docker compose restart bot dashboard-api dashboard-web
```

Health checks:

```bash
curl http://127.0.0.1:5173/health
```

## Without Docker

Install dependencies:

```bash
npm ci
npm --prefix dashboard-react ci
python3 -m pip install -r requirements.txt
```

Run all main processes:

```bash
npm start
```

Run separately:

```bash
npm run bot
npm run dashboard:api
npm run dashboard:web
```

Validate:

```bash
npm run check
npm run test:js
python3 -m pytest
npm run dashboard:build
```

## PM2 Option

For non-Docker VPS usage:

```bash
npm install -g pm2
pm2 start npm --name mlb-bot -- run bot
pm2 start npm --name mlb-dashboard-api -- run dashboard:api
pm2 save
pm2 startup
```

For the React dashboard in production, prefer `npm run dashboard:build` and serve `dashboard-react/dist` through Nginx. Vite dev server is acceptable for private testing, not public production.

## systemd Option

Example bot unit at `/etc/systemd/system/mlb-bot.service`:

```ini
[Unit]
Description=MLB Telegram Bot
After=network.target

[Service]
WorkingDirectory=/opt/MLB-Stats-Bot
EnvironmentFile=/opt/MLB-Stats-Bot/.env
ExecStart=/usr/bin/npm run bot
Restart=always
RestartSec=5
User=mlb

[Install]
WantedBy=multi-user.target
```

Reload and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mlb-bot
sudo journalctl -u mlb-bot -f
```

Create similar units for `npm run dashboard:api`; serve the React build with Nginx.

## Nginx Reverse Proxy

Docker Compose example, where dashboard web is bound to localhost:

```nginx
server {
    listen 80;
    server_name dashboard.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name dashboard.example.com;

    ssl_certificate /etc/letsencrypt/live/dashboard.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dashboard.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:5173;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

Telegram webhook proxy, if enabled:

```nginx
location /telegram/webhook {
    proxy_pass http://127.0.0.1:8443;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
}
```

## SSL/HTTPS

Use Let's Encrypt:

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d dashboard.example.com
```

Keep the FastAPI port private. Public traffic should enter through Nginx/Caddy with HTTPS. Set `DASHBOARD_CORS_ORIGINS` to the exact HTTPS origin.

## Common Errors

- `DASHBOARD_API_TOKEN must be set in production`: set `DASHBOARD_API_TOKEN` in `.env`.
- `Invalid dashboard API token`: enter the same token in the React login page.
- Dashboard loads but API calls fail: check `DASHBOARD_CORS_ORIGINS`, Nginx proxy headers, and `docker compose logs dashboard-api`.
- No odds or market value: set `ODDS_API_KEY` or `THE_ODDS_API_KEY`; otherwise odds are intentionally marked unavailable.
- Bot receives no Telegram messages: verify `TELEGRAM_BOT_TOKEN`, webhook vs polling mode, and `getWebhookInfo`.
- Python import errors: run `python3 -m pip install -r requirements.txt`.
- Node module errors: run `npm ci` and `npm --prefix dashboard-react ci`.

## Safety

The bot is an analytics tool. It does not guarantee betting profit. Keep `NO BET` guardrails enabled, cap exposure, and avoid using stale lineup, pitcher, or odds data.
