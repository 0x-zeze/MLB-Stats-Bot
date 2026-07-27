#!/usr/bin/env node
/**
 * Replay a frozen prediction snapshot and print decision parity.
 *
 * Usage:
 *   node scripts/replay_prediction.js --snapshot path/to/snapshot.json
 */

import { resolve } from 'node:path';
import { replaySnapshotFile, replayTwice } from '../src/prediction_replay.js';
import { readSnapshotFile } from '../src/prediction_serializer.js';

function parseArgs(argv) {
  const args = { snapshot: null, twice: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--snapshot' && argv[i + 1]) args.snapshot = resolve(argv[++i]);
    else if (argv[i] === '--twice') args.twice = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.snapshot) {
    process.stdout.write(
      'Usage: node scripts/replay_prediction.js --snapshot PATH [--twice]\n'
    );
    process.exit(args.help ? 0 : 1);
  }

  if (args.twice) {
    const snapshot = readSnapshotFile(args.snapshot);
    const result = replayTwice(snapshot);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.parity.ok ? 0 : 2);
  }

  const result = replaySnapshotFile(args.snapshot);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.parity.ok ? 0 : 2);
}

main();
