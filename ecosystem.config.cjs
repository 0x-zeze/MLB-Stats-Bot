// PM2 process definition for the MLB Stats Telegram bot.
//
// Runs only the Telegram bot (src/index.js). The dashboard API (Python/uvicorn)
// and the React web UI are separate services; add them as extra apps here if you
// want PM2 to manage them too.
//
// Start:   pm2 start ecosystem.config.cjs
// Logs:    pm2 logs mlb-bot
// Restart: pm2 restart mlb-bot
// Stop:    pm2 stop mlb-bot

const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'mlb-bot',
      script: 'src/index.js',
      cwd: __dirname,
      // Pin the interpreter to the Node build better-sqlite3 was compiled for
      // (ABI 137 / Node v24). Using a different Node causes ERR_DLOPEN_FAILED.
      interpreter: path.join(
        process.env.HOME || '/root',
        '.nvm/versions/node/v24.18.0/bin/node'
      ),
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '20s',
      restart_delay: 3000,
      max_memory_restart: '400M',
      env: {
        NODE_ENV: 'production',
        DASHBOARD_ENABLED: 'false',
      },
      out_file: path.join(__dirname, 'logs', 'mlb-bot.out.log'),
      error_file: path.join(__dirname, 'logs', 'mlb-bot.err.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
