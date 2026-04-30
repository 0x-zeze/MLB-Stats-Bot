import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv(filePath = resolve(rootDir, '.env')) {
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#') || !text.includes('=')) continue;

    const [rawKey, ...valueParts] = text.split('=');
    const key = rawKey.trim();
    const value = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

export function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

export function nodeCommand() {
  return process.execPath;
}

export function pythonCommand() {
  const candidates = [
    process.env.PYTHON_BIN,
    process.env.PYTHON_EXECUTABLE,
    process.env.PYTHON,
    process.platform === 'win32' ? 'python.exe' : 'python3',
    'python'
  ].filter(Boolean);
  const uniqueCandidates = [...new Set(candidates)];

  for (const candidate of uniqueCandidates) {
    const result = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (!result.error && result.status === 0) return candidate;
  }

  throw new Error('Python is required. Install python3, then run npm start again.');
}

export function startProcess(label, command, args, options = {}) {
  console.log(`Starting ${label}: ${command} ${args.join(' ')}`);
  const child = spawn(command, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      ...(options.env || {})
    },
    stdio: 'inherit'
  });
  child.label = label;
  return child;
}

export function stopProcesses(processes) {
  for (const child of processes) {
    if (!child.killed && child.exitCode === null && child.signalCode === null) {
      child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
    }
  }
}

export function waitForProcesses(processes) {
  return new Promise((resolveExitCode) => {
    let shuttingDown = false;

    const shutdown = (exitCode = 0) => {
      if (shuttingDown) return;
      shuttingDown = true;
      stopProcesses(processes);
      resolveExitCode(exitCode);
    };

    process.on('SIGINT', () => shutdown(0));
    process.on('SIGTERM', () => shutdown(0));

    for (const child of processes) {
      child.on('error', (error) => {
        if (shuttingDown) return;
        console.error(`${child.label || 'Process'} failed: ${error.message}`);
        shutdown(1);
      });

      child.on('exit', (code, signal) => {
        if (shuttingDown) return;
        const exitCode = code ?? (signal ? 1 : 0);
        console.error(`${child.label || 'Process'} exited with code ${exitCode}.`);
        shutdown(exitCode);
      });
    }
  });
}
