/**
 * Canonical serialization for prediction snapshots (stable key order + hash).
 */

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  buildPredictionSnapshot,
  hashPayload,
  SNAPSHOT_SCHEMA_VERSION
} from './prediction_snapshot.js';

function stableStringify(value, space = 0) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => stableStringify(item, space));
    if (!space) return `[${items.join(',')}]`;
    return `[\n${items.map((item) => `${' '.repeat(space)}${item}`).join(',\n')}\n]`;
  }
  const keys = Object.keys(value).sort();
  if (!space) {
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key], 0)}`)
      .join(',')}}`;
  }
  const pad = ' '.repeat(space);
  return `{\n${keys
    .map((key) => `${pad}${JSON.stringify(key)}: ${stableStringify(value[key], space)}`)
    .join(',\n')}\n}`;
}

export function serializeSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error('serializeSnapshot: invalid schema');
  }
  // Re-hash without the hash field for integrity.
  const { snapshotHash, ...rest } = snapshot;
  const expected = hashPayload(rest);
  if (snapshotHash && snapshotHash !== expected) {
    throw new Error(
      `serializeSnapshot: snapshotHash mismatch expected=${expected} got=${snapshotHash}`
    );
  }
  const normalized = { ...rest, snapshotHash: expected };
  return `${stableStringify(normalized, 2)}\n`;
}

export function parseSnapshot(text) {
  const parsed = JSON.parse(text);
  if (!parsed || parsed.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error('parseSnapshot: unsupported schema');
  }
  const { snapshotHash, ...rest } = parsed;
  const expected = hashPayload(rest);
  if (snapshotHash !== expected) {
    throw new Error('parseSnapshot: snapshot hash integrity failure');
  }
  return { ...rest, snapshotHash };
}

export function writeSnapshotFile(path, snapshot) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeSnapshot(snapshot), 'utf8');
  return path;
}

export function readSnapshotFile(path) {
  return parseSnapshot(readFileSync(path, 'utf8'));
}

export function captureLiveSnapshot(prediction, context = {}) {
  return buildPredictionSnapshot({ prediction, ...context });
}
