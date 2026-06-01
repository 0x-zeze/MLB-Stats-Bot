import { pythonCommand, startProcess, waitForProcesses } from './process_runner.mjs';

const apiHost = process.env.DASHBOARD_API_HOST || '0.0.0.0';
const apiPort = process.env.DASHBOARD_API_PORT || '8010';
const python = pythonCommand();

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
