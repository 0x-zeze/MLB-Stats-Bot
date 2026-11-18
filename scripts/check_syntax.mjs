#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET_DIRS = ['src', 'scripts', 'tests'];
const EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

function walk(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walk(full));
    } else if (entry.isFile() && EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      results.push(full);
    }
  }
  return results.sort();
}

const files = [
  resolve(ROOT, 'ecosystem.config.cjs'),
  ...TARGET_DIRS.flatMap((dir) => walk(resolve(ROOT, dir)))
];

let failed = 0;
for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true
  });
  if (res.status !== 0) {
    failed += 1;
    process.stderr.write(`Syntax check failed: ${relative(ROOT, file)}\n${res.stderr || res.stdout}\n`);
  }
}

if (failed > 0) {
  process.exit(1);
}
console.log(`Syntax check passed (${files.length} files).`);
