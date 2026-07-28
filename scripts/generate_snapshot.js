#!/usr/bin/env node
/**
 * Freeze a prediction JSON (including its raw coreInputs) for replay.
 *
 * Usage:
 *   node scripts/generate_snapshot.js --prediction prediction.json --out snapshot.json
 *   node scripts/generate_snapshot.js --help
 *
 * The input must contain prediction.gamePk. For recompute-eligible snapshots it
 * must also contain prediction.coreInputs, captured by getMlbPredictions().
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { freezeCalibrationArtifact } from '../src/calibration.js';
import { buildPredictionSnapshot } from '../src/prediction_snapshot.js';
import { writeSnapshotFile } from '../src/prediction_serializer.js';

function parseArgs(argv) {
  const args = { prediction: null, out: null, dateYmd: null, asOfUtc: null, allowProjection: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--prediction' && argv[i + 1]) args.prediction = resolve(argv[++i]);
    else if (token === '--out' && argv[i + 1]) args.out = resolve(argv[++i]);
    else if (token === '--date' && argv[i + 1]) args.dateYmd = argv[++i];
    else if (token === '--as-of' && argv[i + 1]) args.asOfUtc = argv[++i];
    else if (token === '--allow-projection') args.allowProjection = true;
    else if (token === '--help' || token === '-h') args.help = true;
  }
  return args;
}

function usage() {
  return [
    'Usage: node scripts/generate_snapshot.js --prediction PATH --out PATH [options]',
    '',
    'Options:',
    '  --prediction PATH   JSON prediction captured from the live path (required)',
    '  --out PATH          destination snapshot JSON (required)',
    '  --date YYYY-MM-DD   override dateYmd',
    '  --as-of ISO-UTC     override prediction/as-of timestamp',
    '  --allow-projection  allow legacy output without coreInputs (not promotion-safe)',
    '  --help              show this help'
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!args.prediction || !args.out) {
    process.stderr.write(`${usage()}\n`);
    return 1;
  }

  let prediction;
  try {
    prediction = JSON.parse(readFileSync(args.prediction, 'utf8'));
  } catch (error) {
    process.stderr.write(`Could not read prediction JSON: ${error.message}\n`);
    return 1;
  }
  if (!prediction?.gamePk) {
    process.stderr.write('Prediction JSON must contain gamePk.\n');
    return 1;
  }
  if (!prediction.coreInputs && !args.allowProjection) {
    process.stderr.write(
      'Prediction has no coreInputs; refusing projection-only snapshot. Use --allow-projection only for legacy integrity checks.\n'
    );
    return 2;
  }

  const asOfUtc = args.asOfUtc || prediction.predictionTimestampUtc || prediction.asOfUtc || new Date().toISOString();
  const snapshot = buildPredictionSnapshot({
    prediction,
    dateYmd: args.dateYmd || prediction.dateYmd || null,
    asOfUtc,
    predictionTimestampUtc: asOfUtc,
    firstPitchUtc: prediction.startTime || prediction.firstPitchUtc || null,
    versions: prediction.versions || {},
    coreInputs: prediction.coreInputs || null,
    calibrationArtifact: prediction.calibrationArtifact || freezeCalibrationArtifact('moneyline')
  });
  writeSnapshotFile(args.out, snapshot);
  process.stdout.write(
    `${JSON.stringify({
      path: args.out,
      snapshotHash: snapshot.snapshotHash,
      gamePk: snapshot.gamePk,
      mode: snapshot.coreInputs?.game ? 'recompute' : 'projection',
      promotionEligible: Boolean(snapshot.coreInputs?.game)
    }, null, 2)}\n`
  );
  return 0;
}

process.exitCode = main();
