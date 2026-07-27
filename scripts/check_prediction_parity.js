#!/usr/bin/env node
/**
 * Check deterministic parity for a frozen snapshot.
 *
 * Usage:
 *   node scripts/check_prediction_parity.js --snapshot path/to/snapshot.json
 */

import { resolve } from 'node:path';
import { readSnapshotFile } from '../src/prediction_serializer.js';
import { replayTwice } from '../src/prediction_replay.js';

const argv = process.argv.slice(2);
const index = argv.indexOf('--snapshot');
if (index < 0 || !argv[index + 1]) {
  process.stderr.write('Usage: node scripts/check_prediction_parity.js --snapshot PATH\n');
  process.exit(1);
}

const snapshot = readSnapshotFile(resolve(argv[index + 1]));
const result = replayTwice(snapshot);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.parity.ok ? 0 : 2);
