import { npmCommand, pythonCommand, startProcess, waitForProcesses, waitForUrlOk } from './process_runner.mjs';

const apiHost = process.env.DASHBOARD_API_HOST || '0.0.0.0';
const apiPort = process.env.DASHBOARD_API_PORT || '8010';
const webHost = process.env.DASHBOARD_WEB_HOST || '0.0.0.0';
const webPort = process.env.DASHBOARD_WEB_PORT || '5173';
const python = pythonCommand();

const processes = [
  startProcess('Dashboard API', python, [
    '-m',
    'uvicorn',
    'src.dashboard_api:app',
    '--host',
    apiHost,
    '--port',
    apiPort
  ]),
  startProcess('Dashboard web', npmCommand(), [
    '--prefix',
    'dashboard-react',
    'run',
    'dev',
    '--',
    '--host',
    webHost,
    '--port',
    webPort
  ])
];

const processExit = waitForProcesses(processes);
const healthUrl = `http://127.0.0.1:${apiPort}/health`;
const apiHealthy = await Promise.race([
  waitForUrlOk(healthUrl),
  processExit.then(() => false),
]);

console.log(`Dashboard API: http://${apiHost}:${apiPort}`);
console.log(`Dashboard Web: http://localhost:${webPort}`);
if (apiHealthy) {
  console.log(`Dashboard API health: ${healthUrl}`);
} else {
  console.warn(`Dashboard API health check did not pass at ${healthUrl}. Verify DASHBOARD_API_PORT and stop any stale legacy dashboard process on that port.`);
}

const exitCode = await processExit;
process.exit(exitCode);
