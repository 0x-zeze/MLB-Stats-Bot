import assert from 'node:assert/strict';
import test from 'node:test';

import { weekdayInTimezone, dateInTimezone } from '../src/utils.js';

// 2026-06-14 is a Sunday (UTC). At 20:00 UTC it is already Sunday in Jakarta
// (UTC+7 → Monday 03:00) while still Sunday in New York (UTC-4 → 16:00). The
// helper must report the weekday in the REQUESTED zone, not the server's.
test('weekdayInTimezone reflects the requested timezone, not server local', () => {
  const sundayEvening = new Date('2026-06-14T20:00:00Z');
  // New York: still Sunday.
  assert.equal(weekdayInTimezone('America/New_York', sundayEvening), 0);
  // Jakarta: already Monday.
  assert.equal(weekdayInTimezone('Asia/Jakarta', sundayEvening), 1);
});

test('weekdayInTimezone agrees with dateInTimezone across the day boundary', () => {
  // 2026-06-15T02:00Z: Jakarta is Monday 09:00 (2026-06-15), UTC is Monday.
  const d = new Date('2026-06-15T02:00:00Z');
  assert.equal(weekdayInTimezone('Asia/Jakarta', d), 1); // Monday
  assert.equal(dateInTimezone('Asia/Jakarta', d), '2026-06-15');
});

test('weekdayInTimezone covers all seven days', () => {
  // Anchor: 2026-06-14 (Sun) .. 2026-06-20 (Sat), read at UTC noon so the zone
  // offset never crosses into an adjacent day.
  const expected = [0, 1, 2, 3, 4, 5, 6];
  for (let i = 0; i < 7; i++) {
    const day = String(14 + i).padStart(2, '0');
    const d = new Date(`2026-06-${day}T12:00:00Z`);
    assert.equal(weekdayInTimezone('UTC', d), expected[i], `2026-06-${day}`);
  }
});
