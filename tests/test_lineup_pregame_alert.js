import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configureLineupMonitor,
  startLineupMonitor,
  stopLineupMonitorForChat
} from '../src/lineupMonitor.js';

function lineupTeam(prefix) {
  const players = {};
  for (let i = 1; i <= 9; i += 1) {
    players[`ID${prefix}${i}`] = {
      person: { fullName: `${prefix} Hitter ${i}` },
      position: { abbreviation: i === 1 ? 'CF' : 'DH' },
      battingOrder: String(i * 100)
    };
  }
  return { players, pitchers: [] };
}

function boxscore() {
  return {
    teams: {
      away: lineupTeam('A'),
      home: lineupTeam('H')
    }
  };
}

function partialBoxscore() {
  return {
    teams: {
      away: lineupTeam('A'),
      home: { players: {}, pitchers: [] }
    }
  };
}

function wait(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('lineup monitor sends one pre-game prediction alert when both lineups confirm', async () => {
  const originalFetch = global.fetch;
  const originalFlag = process.env.LINEUP_PREGAME_ALERTS;
  process.env.LINEUP_PREGAME_ALERTS = 'true';

  const sentMessages = [];
  const callbacks = [];
  let reserved = false;
  const storage = {
    getMeta: () => '1',
    getSubscriber: () => ({}),
    reserveLineupAlert: () => {
      if (reserved) return false;
      reserved = true;
      return true;
    },
    getFeatureSnapshot: () => null,
    setFeatureSnapshot: () => true
  };
  const bot = {
    sendMessage: async (chatId, text) => {
      sentMessages.push({ chatId, text });
    }
  };

  global.fetch = async () => ({ ok: true, json: async () => boxscore() });

  try {
    configureLineupMonitor({
      bot,
      storage,
      config: { lineupMonitor: { intervalMinutes: 60 } },
      onBothLineupsConfirmed: async (payload) => {
        callbacks.push(payload);
      }
    });

    const monitor = startLineupMonitor([
      {
        gamePk: 'lineup-test-1',
        status: 'Scheduled',
        away: { name: 'Away Team', abbreviation: 'AWY' },
        home: { name: 'Home Team', abbreviation: 'HOM' }
      }
    ], 'chat-1');

    assert.ok(monitor);
    await wait();

    assert.equal(callbacks.length, 1);
    assert.equal(callbacks[0].gamePk, 'lineup-test-1');
    // Legacy side-confirmed message is suppressed when the both-lineups pregame
    // callback path succeeds.
    assert.equal(sentMessages.length, 0);

    stopLineupMonitorForChat('chat-1');
  } finally {
    stopLineupMonitorForChat('chat-1');
    global.fetch = originalFetch;
    if (originalFlag === undefined) delete process.env.LINEUP_PREGAME_ALERTS;
    else process.env.LINEUP_PREGAME_ALERTS = originalFlag;
  }
});

test('lineup monitor suppresses one-side lineup alerts when pre-game alert mode is on', async () => {
  const originalFetch = global.fetch;
  const originalFlag = process.env.LINEUP_PREGAME_ALERTS;
  process.env.LINEUP_PREGAME_ALERTS = 'true';

  const sentMessages = [];
  const callbacks = [];
  const storage = {
    getMeta: () => '1',
    getSubscriber: () => ({}),
    reserveLineupAlert: () => true,
    getFeatureSnapshot: () => null,
    setFeatureSnapshot: () => true
  };
  const bot = {
    sendMessage: async (chatId, text) => {
      sentMessages.push({ chatId, text });
    }
  };

  global.fetch = async () => ({ ok: true, json: async () => partialBoxscore() });

  try {
    configureLineupMonitor({
      bot,
      storage,
      config: { lineupMonitor: { intervalMinutes: 60 } },
      onBothLineupsConfirmed: async (payload) => {
        callbacks.push(payload);
      }
    });

    const monitor = startLineupMonitor([
      {
        gamePk: 'lineup-test-2',
        status: 'Scheduled',
        away: { name: 'Away Team', abbreviation: 'AWY' },
        home: { name: 'Home Team', abbreviation: 'HOM' }
      }
    ], 'chat-2');

    assert.ok(monitor);
    await wait();

    assert.equal(callbacks.length, 0);
    assert.equal(sentMessages.length, 0);

    stopLineupMonitorForChat('chat-2');
  } finally {
    stopLineupMonitorForChat('chat-2');
    global.fetch = originalFetch;
    if (originalFlag === undefined) delete process.env.LINEUP_PREGAME_ALERTS;
    else process.env.LINEUP_PREGAME_ALERTS = originalFlag;
  }
});

test('lineup monitor uses durable per-chat dedupe instead of shared lineup cache', async () => {
  const originalFetch = global.fetch;
  const originalFlag = process.env.LINEUP_PREGAME_ALERTS;
  process.env.LINEUP_PREGAME_ALERTS = 'true';

  const callbacks = [];
  const seen = new Set();
  const storage = {
    getMeta: () => '1',
    getSubscriber: () => ({}),
    reserveLineupAlert: (chatId, gamePk) => {
      const key = `${chatId}:${gamePk}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    },
    getFeatureSnapshot: () => null,
    setFeatureSnapshot: () => true
  };
  const bot = { sendMessage: async () => {} };

  global.fetch = async () => ({ ok: true, json: async () => boxscore() });

  try {
    configureLineupMonitor({
      bot,
      storage,
      config: { lineupMonitor: { intervalMinutes: 60 } },
      onBothLineupsConfirmed: async (payload) => {
        callbacks.push(payload);
      }
    });

    const game = {
      gamePk: 'lineup-test-3',
      status: 'Scheduled',
      away: { name: 'Away Team', abbreviation: 'AWY' },
      home: { name: 'Home Team', abbreviation: 'HOM' }
    };

    assert.ok(startLineupMonitor([game], 'chat-a'));
    await wait();
    assert.ok(startLineupMonitor([game], 'chat-b'));
    await wait();

    assert.deepEqual(callbacks.map((item) => item.chatId).sort(), ['chat-a', 'chat-b']);

    stopLineupMonitorForChat('chat-a');
    stopLineupMonitorForChat('chat-b');
  } finally {
    stopLineupMonitorForChat('chat-a');
    stopLineupMonitorForChat('chat-b');
    global.fetch = originalFetch;
    if (originalFlag === undefined) delete process.env.LINEUP_PREGAME_ALERTS;
    else process.env.LINEUP_PREGAME_ALERTS = originalFlag;
  }
});
