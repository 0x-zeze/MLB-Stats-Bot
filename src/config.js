import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const equalsIndex = trimmed.indexOf('=');
  if (equalsIndex === -1) return null;

  const key = trimmed.slice(0, equalsIndex).trim();
  let value = trimmed.slice(equalsIndex + 1).trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return [key, value];
}

export function loadDotEnv(filePath = resolve(process.cwd(), '.env')) {
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;

    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function boolFromEnv(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function csv(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function intFromEnv(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberFromEnv(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig() {
  loadDotEnv();

  return {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    allowedChatIds: csv(process.env.ALLOWED_CHAT_IDS),
    telegramWebhook: {
      enabled: boolFromEnv(process.env.TELEGRAM_WEBHOOK_MODE, false),
      url: process.env.TELEGRAM_WEBHOOK_URL || '',
      port: intFromEnv(process.env.TELEGRAM_WEBHOOK_PORT, 8443),
      secret: process.env.TELEGRAM_WEBHOOK_SECRET || ''
    },
    timezone: process.env.TIMEZONE || 'Asia/Jakarta',
    autoAlerts: boolFromEnv(process.env.AUTO_ALERTS, false),
    dailyAlertTime: process.env.DAILY_ALERT_TIME || '20:00',
    postGameAlerts: boolFromEnv(process.env.POST_GAME_ALERTS, true),
    postGamePollMinutes: intFromEnv(process.env.POST_GAME_POLL_MINUTES, 5),
    modelMemory: boolFromEnv(process.env.MODEL_MEMORY, true),
    interactiveAgent: boolFromEnv(process.env.INTERACTIVE_AGENT, true),
    printAlertToTerminal: boolFromEnv(process.env.PRINT_ALERT_TO_TERMINAL, false),
    maxGamesPerMessage: intFromEnv(process.env.MAX_GAMES_PER_MESSAGE, 8),
    pythonExecutable: process.env.PYTHON_BIN || 'python',
    dashboard: {
      enabled: boolFromEnv(process.env.DASHBOARD_ENABLED, true),
      host: process.env.DASHBOARD_HOST || '0.0.0.0',
      port: intFromEnv(process.env.DASHBOARD_PORT, 3008)
    },
    lineMonitor: {
      enabled: boolFromEnv(process.env.LINE_MOVEMENT_ALERTS, true),
      intervalMinutes: intFromEnv(process.env.LINE_MONITOR_INTERVAL_MINUTES, 10),
      moneylineThreshold: numberFromEnv(process.env.LINE_MOVEMENT_THRESHOLD_ML, 15),
      totalThreshold: numberFromEnv(process.env.LINE_MOVEMENT_THRESHOLD_TOTAL, 0.5),
      oddsApiKey: process.env.ODDS_API_KEY || process.env.THE_ODDS_API_KEY || ''
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || '',
      baseUrl: process.env.OPENAI_BASE_URL || '',
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      useSummary: boolFromEnv(process.env.USE_OPENAI_SUMMARY, false)
    },
    analystAgent: {
      enabled: boolFromEnv(process.env.ANALYST_AGENT, false),
      mode: process.env.ANALYST_AGENT_MODE || 'local',
      url: process.env.ANALYST_AGENT_URL || '',
      apiKey: process.env.ANALYST_AGENT_API_KEY || '',
      timeoutMs: intFromEnv(process.env.ANALYST_AGENT_TIMEOUT_MS, 45000)
    },
    alertDetail: process.env.ALERT_DETAIL === 'full' ? 'full' : 'compact'
  };
}
