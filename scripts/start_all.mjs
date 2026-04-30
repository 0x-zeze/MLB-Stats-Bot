import {
  nodeCommand,
  npmCommand,
  pythonCommand,
  startProcess,
  waitForProcesses
} from './process_runner.mjs';

const apiHost = process.env.DASHBOARD_API_HOST || '0.0.0.0';
const apiPort = process.env.DASHBOARD_API_PORT || '8010';
const webHost = process.env.DASHBOARD_WEB_HOST || '0.0.0.0';
const webPort = process.env.DASHBOARD_WEB_PORT || '5173';
const python = pythonCommand();

const processes = [
  startProcess('Telegram bot', nodeCommand(), ['src/index.js'], {
    env: {
      DASHBOARD_ENABLED: process.env.START_LEGACY_DASHBOARD || 'false'
    }
  }),
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

console.log('Telegram bot: running from src/index.js');
console.log(`Dashboard API: http://${apiHost}:${apiPort}`);
console.log(`Dashboard Web: http://localhost:${webPort}`);
console.log('Open from VPS IP with the dashboard web port, for example http://YOUR_VPS_IP:5173');

const exitCode = await waitForProcesses(processes);
process.exit(exitCode);
