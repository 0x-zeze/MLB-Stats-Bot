import { pythonCommand, startProcess, waitForProcesses } from './process_runner.mjs';

const apiHost = process.env.DASHBOARD_API_HOST || '0.0.0.0';
const apiPort = process.env.DASHBOARD_API_PORT || '8010';
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
  ])
];

console.log(`Dashboard API: http://${apiHost}:${apiPort}`);

const exitCode = await waitForProcesses(processes);
process.exit(exitCode);
