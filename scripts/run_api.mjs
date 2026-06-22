import { pythonCommand, startProcess, waitForProcesses } from './process_runner.mjs';

let apiHost = process.env.DASHBOARD_API_HOST || '0.0.0.0';
const apiPort = process.env.DASHBOARD_API_PORT || '8010';
const python = pythonCommand();

// The control-center API allows all requests when DASHBOARD_API_TOKEN is empty
// (verify_token only enforces in production) and exposes compute-heavy routes
// (/api/evolve, /api/backtest). Refuse to bind a non-loopback host without a
// token so an open API never lands on the network by default; fall back to
// loopback instead of crashing the launcher.
const isLoopback = ['127.0.0.1', 'localhost', '::1', ''].includes(apiHost.trim());
if (!isLoopback && !(process.env.DASHBOARD_API_TOKEN || '').trim()) {
  console.warn(
    `Dashboard API: refusing to bind ${apiHost} without DASHBOARD_API_TOKEN; using 127.0.0.1. Set a token to expose it.`
  );
  apiHost = '127.0.0.1';
}

// Opt-in hot reload for development so Python code changes load without a manual
// restart. Off by default (production runs a fixed process). Enable with
// DASHBOARD_API_RELOAD=1 or NODE_ENV=development.
const reloadEnabled =
  process.env.DASHBOARD_API_RELOAD === '1' ||
  process.env.DASHBOARD_API_RELOAD === 'true' ||
  (process.env.NODE_ENV || '').toLowerCase() === 'development';

const uvicornArgs = [
  '-m',
  'uvicorn',
  'src.dashboard_api:app',
  '--host',
  apiHost,
  '--port',
  apiPort,
  ...(reloadEnabled ? ['--reload', '--reload-dir', 'src'] : [])
];

const processes = [startProcess('Dashboard API', python, uvicornArgs)];

console.log(`Dashboard API: http://${apiHost}:${apiPort}${reloadEnabled ? ' (hot reload on)' : ''}`);

const exitCode = await waitForProcesses(processes);
process.exit(exitCode);
