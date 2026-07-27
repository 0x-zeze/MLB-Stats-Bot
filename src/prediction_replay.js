/**
 * Replay helpers for frozen prediction snapshots.
 *
 * Full pure-core extraction of predictGame is still in progress. This module
 * replays the *decision projection* from a snapshot twice and asserts parity,
 * which is the gate for any later full-core extraction.
 */

import {
  assertReplayParity,
  projectDecisionFromSnapshot
} from './prediction_snapshot.js';
import { parseSnapshot, readSnapshotFile, serializeSnapshot } from './prediction_serializer.js';

export function replaySnapshot(snapshot) {
  const first = projectDecisionFromSnapshot(snapshot);
  // Round-trip through canonical serialization to ensure hash stability.
  const roundTrip = parseSnapshot(serializeSnapshot(snapshot));
  const second = projectDecisionFromSnapshot(roundTrip);
  const parity = assertReplayParity(first, second);
  return {
    decision: first,
    parity,
    snapshotHash: snapshot.snapshotHash
  };
}

export function replaySnapshotFile(path) {
  return replaySnapshot(readSnapshotFile(path));
}

export function replayTwice(snapshot) {
  const a = replaySnapshot(snapshot);
  const b = replaySnapshot(snapshot);
  const parity = assertReplayParity(a.decision, b.decision);
  return { a, b, parity };
}
