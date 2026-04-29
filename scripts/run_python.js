import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

function loadDotEnv(filePath = resolve(process.cwd(), '.env')) {
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

function candidateCommands() {
  const configured = process.env.PYTHON_BIN?.trim();
  const defaults = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  return [...new Set([configured, ...defaults].filter(Boolean))];
}

function run(command, args) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });

    child.on('error', (error) => {
      resolveRun({ command, error });
    });
    child.on('close', (code) => {
      resolveRun({ command, code });
    });
  });
}

loadDotEnv();

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node scripts/run_python.js <python args...>');
  process.exit(1);
}

let lastError = null;
for (const command of candidateCommands()) {
  const result = await run(command, args);
  if (result.error?.code === 'ENOENT') {
    lastError = result.error;
    continue;
  }
  if (result.error) {
    console.error(`${command} failed: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.code ?? 0);
}

console.error(
  `Python was not found. Tried: ${candidateCommands().join(', ')}. Install python3 or set PYTHON_BIN in .env.`
);
if (lastError) console.error(lastError.message);
process.exit(1);
