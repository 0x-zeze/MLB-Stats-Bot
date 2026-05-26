#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_ROOT = resolve(new URL('..', import.meta.url).pathname);

function parseEnvFile(rootDir) {
  const path = join(rootDir, '.env');
  if (!existsSync(path)) return {};

  const parsed = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#') || !text.includes('=')) continue;
    const index = text.indexOf('=');
    const key = text.slice(0, index).trim();
    let value = text.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) parsed[key] = value;
  }
  return parsed;
}

function defaultRunCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || DEFAULT_ROOT,
    encoding: 'utf8',
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
    status: result.status,
  };
}

function check(id, status, label, detail, fix = '') {
  return { id, status, label, detail, fix };
}

function envValue(env, key) {
  return String(env[key] || '').trim();
}

function nodeMajor(version) {
  const match = String(version || '').match(/v?(\d+)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function commandPass(runCommand, command, args, cwd) {
  const result = runCommand(command, args, { cwd });
  return result.ok;
}

export function collectDoctorChecks(options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT;
  const fileEnv = parseEnvFile(rootDir);
  const env = { ...fileEnv, ...process.env, ...(options.env || {}) };
  const runCommand = options.runCommand || defaultRunCommand;
  const version = options.nodeVersion || process.version;
  const production = envValue(env, 'NODE_ENV').toLowerCase() === 'production';
  const checks = [];

  const requiredFiles = [
    'package.json',
    'package-lock.json',
    'requirements.txt',
    'src/index.js',
    'src/dashboard_api.py',
    'dashboard-react/package.json',
    'dashboard-react/package-lock.json',
    '.env.example',
  ];
  for (const file of requiredFiles) {
    const exists = existsSync(join(rootDir, file));
    checks.push(
      check(
        `file_${file.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`,
        exists ? 'pass' : 'fail',
        `Required file ${file}`,
        exists ? 'found' : 'missing',
        exists ? '' : `Restore ${file} from the repository.`
      )
    );
  }

  const major = nodeMajor(version);
  checks.push(
    check(
      'node_version',
      major >= 18 ? 'pass' : 'fail',
      'Node.js version',
      version,
      major >= 18 ? '' : 'Install Node.js 18.15 or newer.'
    )
  );

  const python = envValue(env, 'PYTHON_BIN') || 'python3';
  const pythonVersion = runCommand(python, ['--version'], { cwd: rootDir });
  checks.push(
    check(
      'python_available',
      pythonVersion.ok ? 'pass' : 'fail',
      'Python availability',
      (pythonVersion.stdout || pythonVersion.stderr || '').trim() || python,
      pythonVersion.ok ? '' : 'Install Python 3.10+ or set PYTHON_BIN in .env.'
    )
  );

  const telegramToken = envValue(env, 'TELEGRAM_BOT_TOKEN');
  checks.push(
    check(
      'telegram_token',
      telegramToken ? 'pass' : 'fail',
      'Telegram bot token',
      telegramToken ? 'set' : 'missing',
      telegramToken ? '' : 'Set TELEGRAM_BOT_TOKEN in .env from @BotFather.'
    )
  );

  checks.push(
    check(
      'telegram_chat_id',
      envValue(env, 'TELEGRAM_CHAT_ID') || envValue(env, 'ALLOWED_CHAT_IDS') ? 'pass' : 'warn',
      'Telegram chat target',
      envValue(env, 'TELEGRAM_CHAT_ID') ? 'TELEGRAM_CHAT_ID set' : 'not set',
      'Set TELEGRAM_CHAT_ID or ALLOWED_CHAT_IDS after running /chatid.'
    )
  );

  const dashboardToken = envValue(env, 'DASHBOARD_API_TOKEN');
  checks.push(
    check(
      'dashboard_api_token',
      dashboardToken ? 'pass' : production ? 'fail' : 'warn',
      'Dashboard API token',
      dashboardToken ? 'set' : 'missing',
      dashboardToken
        ? ''
        : 'Set DASHBOARD_API_TOKEN before exposing the dashboard. Generate one with: openssl rand -hex 32'
    )
  );

  const corsOrigins = envValue(env, 'DASHBOARD_CORS_ORIGINS');
  const corsUnsafe = production && (!corsOrigins || corsOrigins.split(',').map((item) => item.trim()).includes('*'));
  checks.push(
    check(
      'dashboard_cors_origins',
      corsUnsafe ? 'fail' : corsOrigins ? 'pass' : 'warn',
      'Dashboard CORS origins',
      corsOrigins || 'not set',
      corsUnsafe
        ? 'Set DASHBOARD_CORS_ORIGINS to your exact dashboard origin, for example https://dashboard.example.com.'
        : 'Set DASHBOARD_CORS_ORIGINS to comma-separated trusted origins in production.'
    )
  );

  const apiPort = envValue(env, 'DASHBOARD_API_PORT') || '8010';
  const webPort = envValue(env, 'DASHBOARD_WEB_PORT') || '5173';
  checks.push(check('dashboard_api_config', 'pass', 'Dashboard API config', `port ${apiPort}`, ''));
  checks.push(check('dashboard_web_config', 'pass', 'Dashboard web config', `port ${webPort}`, ''));

  const rootDependencyInstalled = existsSync(join(rootDir, 'node_modules', 'better-sqlite3', 'package.json'));
  checks.push(
    check(
      'root_node_dependencies',
      rootDependencyInstalled ? 'pass' : 'warn',
      'Root npm dependencies',
      rootDependencyInstalled ? 'installed' : 'not installed',
      'Run npm install or npm ci.'
    )
  );

  const dashboardDependencyInstalled = existsSync(join(rootDir, 'dashboard-react', 'node_modules', 'vite', 'package.json'));
  checks.push(
    check(
      'dashboard_node_dependencies',
      dashboardDependencyInstalled ? 'pass' : 'warn',
      'Dashboard npm dependencies',
      dashboardDependencyInstalled ? 'installed' : 'not installed',
      'Run npm --prefix dashboard-react install or npm --prefix dashboard-react ci.'
    )
  );

  const pytestAvailable = commandPass(runCommand, python, ['-m', 'pytest', '--version'], rootDir);
  checks.push(
    check(
      'pytest_available',
      pytestAvailable ? 'pass' : 'warn',
      'pytest',
      pytestAvailable ? 'available' : 'not available',
      'Install Python dependencies with python3 -m pip install -r requirements.txt.'
    )
  );

  checks.push(
    check(
      'odds_api_key',
      envValue(env, 'ODDS_API_KEY') || envValue(env, 'THE_ODDS_API_KEY') ? 'pass' : 'warn',
      'Odds API key',
      envValue(env, 'ODDS_API_KEY') || envValue(env, 'THE_ODDS_API_KEY') ? 'set' : 'not set',
      'Set ODDS_API_KEY or THE_ODDS_API_KEY to enable live odds and line movement.'
    )
  );

  checks.push(
    check(
      'weather_api_key',
      envValue(env, 'OPENWEATHER_API_KEY') ? 'pass' : 'warn',
      'Weather API key',
      envValue(env, 'OPENWEATHER_API_KEY') ? 'set' : 'not set',
      'Set OPENWEATHER_API_KEY to enable external weather enrichment.'
    )
  );

  return checks;
}

export function formatDoctorReport(checks) {
  const lines = ['MLB Stats Bot doctor', ''];
  for (const item of checks) {
    const status = String(item.status || 'warn').toUpperCase();
    lines.push(`[${status}] ${item.label}: ${item.detail}`);
    if (item.status !== 'pass' && item.fix) {
      lines.push(`       Fix: ${item.fix}`);
    }
  }
  const failed = checks.filter((item) => item.status === 'fail').length;
  const warned = checks.filter((item) => item.status === 'warn').length;
  lines.push('');
  lines.push(`Summary: ${failed} failed, ${warned} warnings, ${checks.length - failed - warned} passed`);
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const checks = collectDoctorChecks();
  console.log(formatDoctorReport(checks));
  process.exit(checks.some((item) => item.status === 'fail') ? 1 : 0);
}
