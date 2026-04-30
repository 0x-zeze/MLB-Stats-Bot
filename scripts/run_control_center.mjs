import { npmCommand, pythonCommand, startProcess, waitForProcesses } from './process_runner.mjs';

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

console.log(`Dashboard API: http://${apiHost}:${apiPort}`);
console.log(`Dashboard Web: http://localhost:${webPort}`);

const exitCode = await waitForProcesses(processes);
process.exit(exitCode);
