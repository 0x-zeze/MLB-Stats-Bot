import assert from 'node:assert/strict';
import test from 'node:test';

import { collectDoctorChecks, formatDoctorReport } from '../scripts/doctor.mjs';

test('doctor reports missing required production secrets with fixes', () => {
  const checks = collectDoctorChecks({
    env: {
      NODE_ENV: 'production',
      TELEGRAM_BOT_TOKEN: '',
      DASHBOARD_API_TOKEN: '',
      DASHBOARD_CORS_ORIGINS: '*',
    },
    rootDir: process.cwd(),
    nodeVersion: 'v18.15.0',
    runCommand: () => ({ ok: true, stdout: 'Python 3.11.0' }),
  });

  const telegram = checks.find((check) => check.id === 'telegram_token');
  const dashboardToken = checks.find((check) => check.id === 'dashboard_api_token');
  const cors = checks.find((check) => check.id === 'dashboard_cors_origins');

  assert.equal(telegram.status, 'fail');
  assert.match(telegram.fix, /TELEGRAM_BOT_TOKEN/);
  assert.equal(dashboardToken.status, 'fail');
  assert.match(dashboardToken.fix, /DASHBOARD_API_TOKEN/);
  assert.equal(cors.status, 'fail');
});

test('doctor distinguishes optional odds and weather keys from required checks', () => {
  const checks = collectDoctorChecks({
    env: {
      NODE_ENV: 'development',
      TELEGRAM_BOT_TOKEN: 'token',
      DASHBOARD_API_TOKEN: '',
      DASHBOARD_CORS_ORIGINS: 'http://localhost:5173',
      ODDS_API_KEY: '',
      THE_ODDS_API_KEY: '',
      OPENWEATHER_API_KEY: '',
    },
    rootDir: process.cwd(),
    nodeVersion: 'v20.11.0',
    runCommand: () => ({ ok: true, stdout: 'Python 3.11.0' }),
  });

  const optional = checks.filter((check) => ['odds_api_key', 'weather_api_key'].includes(check.id));
  const dashboardToken = checks.find((check) => check.id === 'dashboard_api_token');
  assert.ok(optional.every((check) => check.status === 'warn'));
  assert.equal(dashboardToken.status, 'warn');
  assert.match(dashboardToken.fix, /DASHBOARD_API_TOKEN/);
  assert.ok(checks.some((check) => check.id === 'node_version' && check.status === 'pass'));
});

test('doctor passes dashboard token when configured', () => {
  const checks = collectDoctorChecks({
    env: {
      NODE_ENV: 'production',
      TELEGRAM_BOT_TOKEN: 'token',
      DASHBOARD_API_TOKEN: 'dashboard-token',
      DASHBOARD_CORS_ORIGINS: 'https://example.com',
    },
    rootDir: process.cwd(),
    nodeVersion: 'v20.11.0',
    runCommand: () => ({ ok: true, stdout: 'Python 3.11.0' }),
  });

  const dashboardToken = checks.find((check) => check.id === 'dashboard_api_token');
  assert.equal(dashboardToken.status, 'pass');
});

test('doctor report prints pass warn and fail guidance', () => {
  const report = formatDoctorReport([
    { status: 'pass', label: 'Node.js', detail: 'v20.11.0', fix: '' },
    { status: 'warn', label: 'Odds API', detail: 'not set', fix: 'Set ODDS_API_KEY for odds.' },
    { status: 'fail', label: 'Telegram token', detail: 'missing', fix: 'Set TELEGRAM_BOT_TOKEN.' },
  ]);

  assert.match(report, /\[PASS\] Node\.js/);
  assert.match(report, /\[WARN\] Odds API/);
  assert.match(report, /\[FAIL\] Telegram token/);
  assert.match(report, /Set TELEGRAM_BOT_TOKEN/);
});
