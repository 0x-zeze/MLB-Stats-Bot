import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { nodeCommand, npmSpawnSpec, pythonCommand, rootDir } from './process_runner.mjs';

function run(command, args, cwd = rootDir) {
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: useShell
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function runNpm(npmArgs, cwd = rootDir) {
  const spec = npmSpawnSpec(npmArgs);
  run(spec.command, spec.args, cwd);
}

function nodePackageReady(packageName, cwd = rootDir) {
  const result = spawnSync(
    nodeCommand(),
    [
      '-e',
      `import(${JSON.stringify(packageName)}).then(() => process.exit(0)).catch(() => process.exit(1));`
    ],
    {
      cwd,
      stdio: 'ignore'
    }
  );
  return !result.error && result.status === 0;
}

function pythonModuleReady(python, moduleName) {
  const result = spawnSync(python, ['-c', `import ${moduleName}`], {
    cwd: rootDir,
    stdio: 'ignore'
  });
  return !result.error && result.status === 0;
}

function ensureRootDependencies() {
  if (nodePackageReady('better-sqlite3')) return;

  console.log('Installing root npm dependencies...');
  runNpm(['install']);
}

function ensureDashboardDependencies() {
  const vitePath = join(rootDir, 'dashboard-react', 'node_modules', 'vite', 'package.json');
  if (existsSync(vitePath)) return;

  console.log('Installing dashboard npm dependencies...');
  runNpm(['--prefix', 'dashboard-react', 'install']);
}

function ensurePythonDependencies() {
  const python = pythonCommand();
  const requiredModules = ['fastapi', 'uvicorn', 'sklearn'];
  const missing = requiredModules.filter((moduleName) => !pythonModuleReady(python, moduleName));
  if (missing.length === 0) return;

  console.log(`Installing Python dependencies for dashboard API: ${missing.join(', ')}`);
  run(python, ['-m', 'pip', 'install', '-r', 'requirements.txt']);
}

function migrateStorage() {
  console.log('Preparing SQLite storage...');
  run(nodeCommand(), ['scripts/migrate_state_to_sqlite.js']);
}

function runModelValidation() {
  console.log('Running moneyline model validation (npm run model)...');
  const spec = npmSpawnSpec(['run', 'model']);
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(spec.command);
  const result = spawnSync(spec.command, spec.args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: useShell
  });
  if (result.error) {
    console.warn(`Model validation failed to start: ${result.error.message}`);
    return;
  }
  if (result.status !== 0) {
    console.warn(`Model validation exited with code ${result.status}; continuing startup.`);
  }
}

ensureRootDependencies();
ensureDashboardDependencies();
ensurePythonDependencies();
migrateStorage();
runModelValidation();
