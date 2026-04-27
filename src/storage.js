import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULT_STATE = {
  lastUpdateId: 0,
  lastAutoAlertDate: '',
  subscribers: {},
  predictions: {},
  memory: {
    version: 1,
    totalPicks: 0,
    correctPicks: 0,
    wrongPicks: 0,
    byConfidence: {},
    firstInning: {
      totalPicks: 0,
      correctPicks: 0,
      wrongPicks: 0,
      byPick: {
        YES: { total: 0, correct: 0 },
        NO: { total: 0, correct: 0 }
      }
    },
    teamBias: {},
    learningLog: []
  }
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeState(state) {
  return {
    ...DEFAULT_STATE,
    ...state,
    subscribers: state?.subscribers || {},
    predictions: state?.predictions || {},
    memory: {
      ...DEFAULT_STATE.memory,
      ...(state?.memory || {}),
      firstInning: {
        ...DEFAULT_STATE.memory.firstInning,
        ...(state?.memory?.firstInning || {}),
        byPick: {
          ...DEFAULT_STATE.memory.firstInning.byPick,
          ...(state?.memory?.firstInning?.byPick || {})
        }
      },
      byConfidence: state?.memory?.byConfidence || {},
      teamBias: state?.memory?.teamBias || {},
      learningLog: state?.memory?.learningLog || []
    }
  };
}

function compactPrediction(prediction, dateYmd) {
  const agent = prediction.agentAnalysis;
  const awayProbability = agent?.awayProbability ?? Math.round(prediction.away.winProbability);
  const homeProbability = agent?.homeProbability ?? Math.round(prediction.home.winProbability);
  const agentPick =
    agent?.pickTeamId === prediction.away.id
      ? prediction.away
      : agent?.pickTeamId === prediction.home.id
        ? prediction.home
        : prediction.winner;
  const pickProbability =
    agentPick.id === prediction.away.id
      ? awayProbability
      : agentPick.id === prediction.home.id
        ? homeProbability
        : Math.round(prediction.winner.winProbability);

  return {
    gamePk: prediction.gamePk,
    dateYmd,
    status: prediction.status,
    matchup: `${prediction.away.name} @ ${prediction.home.name}`,
    away: {
      id: prediction.away.id,
      name: prediction.away.name,
      abbreviation: prediction.away.abbreviation,
      winProbability: awayProbability
    },
    home: {
      id: prediction.home.id,
      name: prediction.home.name,
      abbreviation: prediction.home.abbreviation,
      winProbability: homeProbability
    },
    pick: {
      id: agentPick.id,
      name: agentPick.name,
      abbreviation: agentPick.abbreviation,
      winProbability: pickProbability,
      source: agent ? 'analyst-agent' : 'baseline-model',
      confidence: agent?.confidence || 'model'
    },
    reasons: agent?.reasons || prediction.reasons,
    firstInning: prediction.firstInning
      ? {
          pick: prediction.firstInning.agent?.pick || prediction.firstInning.baselinePick,
          probability: Math.round(
            prediction.firstInning.agent?.probability ?? prediction.firstInning.baselineProbability
          ),
          source: prediction.firstInning.agent ? 'analyst-agent' : 'baseline-model',
          reasons: prediction.firstInning.agent?.reasons || prediction.firstInning.reasons || []
        }
      : null,
    agentRisk: agent?.risk || '',
    agentMemoryNote: agent?.memoryNote || '',
    savedAt: new Date().toISOString()
  };
}

export class Storage {
  constructor(filePath = resolve(process.cwd(), 'data', 'state.json')) {
    this.filePath = filePath;
    this.state = this.read();
  }

  read() {
    if (!existsSync(this.filePath)) return normalizeState(DEFAULT_STATE);

    try {
      return normalizeState(JSON.parse(readFileSync(this.filePath, 'utf8')));
    } catch {
      return normalizeState(DEFAULT_STATE);
    }
  }

  save() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  getLastUpdateId() {
    return this.state.lastUpdateId || 0;
  }

  setLastUpdateId(updateId) {
    this.state.lastUpdateId = updateId;
    this.save();
  }

  addSubscriber(chat) {
    this.state.subscribers[String(chat.id)] = {
      id: chat.id,
      title: chat.title || chat.username || chat.first_name || String(chat.id),
      subscribedAt: new Date().toISOString()
    };
    this.save();
  }

  removeSubscriber(chatId) {
    delete this.state.subscribers[String(chatId)];
    this.save();
  }

  listSubscriberIds() {
    return Object.keys(this.state.subscribers);
  }

  getLastAutoAlertDate() {
    return this.state.lastAutoAlertDate || '';
  }

  setLastAutoAlertDate(dateYmd) {
    this.state.lastAutoAlertDate = dateYmd;
    this.save();
  }

  savePredictions(dateYmd, predictions) {
    for (const prediction of predictions) {
      if (String(prediction.status).toLowerCase().includes('final')) continue;

      const key = String(prediction.gamePk);
      const existing = this.state.predictions[key] || {};
      this.state.predictions[key] = {
        ...compactPrediction(prediction, dateYmd),
        postGameProcessed: existing.postGameProcessed || false,
        postGameProcessedAt: existing.postGameProcessedAt || null
      };
    }

    this.save();
  }

  getPrediction(gamePk) {
    return this.state.predictions[String(gamePk)] || null;
  }

  listPendingPredictionDates() {
    return [
      ...new Set(
        Object.values(this.state.predictions)
          .filter((prediction) => !prediction.postGameProcessed)
          .map((prediction) => prediction.dateYmd)
          .filter(Boolean)
      )
    ];
  }

  markPostGameProcessed(gamePk) {
    const key = String(gamePk);
    if (!this.state.predictions[key]) return;

    this.state.predictions[key].postGameProcessed = true;
    this.state.predictions[key].postGameProcessedAt = new Date().toISOString();
    this.save();
  }

  getMemory() {
    return this.state.memory;
  }

  getMemorySummary() {
    const memory = this.state.memory;
    const accuracy =
      memory.totalPicks > 0 ? Math.round((memory.correctPicks / memory.totalPicks) * 100) : 0;
    const firstInningAccuracy =
      memory.firstInning.totalPicks > 0
        ? Math.round((memory.firstInning.correctPicks / memory.firstInning.totalPicks) * 100)
        : 0;

    return {
      totalPicks: memory.totalPicks,
      correctPicks: memory.correctPicks,
      wrongPicks: memory.wrongPicks,
      accuracy,
      byConfidence: memory.byConfidence,
      firstInning: {
        ...memory.firstInning,
        accuracy: firstInningAccuracy
      },
      recentLog: memory.learningLog.slice(0, 5)
    };
  }

  recordOutcome(prediction, result, { enabled = true } = {}) {
    const correct = prediction.pick.id === result.winner.id;
    const memory = this.state.memory;

    memory.totalPicks += 1;
    if (correct) memory.correctPicks += 1;
    if (!correct) memory.wrongPicks += 1;

    const confidence = prediction.pick.confidence || 'unknown';
    if (!memory.byConfidence[confidence]) {
      memory.byConfidence[confidence] = { total: 0, correct: 0 };
    }
    memory.byConfidence[confidence].total += 1;
    if (correct) memory.byConfidence[confidence].correct += 1;

    let firstInningCorrect = null;
    if (prediction.firstInning && result.firstInning?.anyRun !== null) {
      const actualPick = result.firstInning.anyRun ? 'YES' : 'NO';
      const predictedPick = prediction.firstInning.pick || 'NO';
      firstInningCorrect = predictedPick === actualPick;
      memory.firstInning.totalPicks += 1;
      if (firstInningCorrect) memory.firstInning.correctPicks += 1;
      if (!firstInningCorrect) memory.firstInning.wrongPicks += 1;

      if (!memory.firstInning.byPick[predictedPick]) {
        memory.firstInning.byPick[predictedPick] = { total: 0, correct: 0 };
      }
      memory.firstInning.byPick[predictedPick].total += 1;
      if (firstInningCorrect) memory.firstInning.byPick[predictedPick].correct += 1;
    }

    if (enabled) {
      const winnerKey = String(result.winner.id);
      const loserKey = String(result.loser.id);
      const pickKey = String(prediction.pick.id);

      const winnerBump = correct ? 0.004 : 0.025;
      const loserDrop = correct ? 0.002 : 0.018;
      memory.teamBias[winnerKey] = clamp((memory.teamBias[winnerKey] || 0) + winnerBump, -0.18, 0.18);
      memory.teamBias[loserKey] = clamp((memory.teamBias[loserKey] || 0) - loserDrop, -0.18, 0.18);

      if (!correct) {
        memory.teamBias[pickKey] = clamp((memory.teamBias[pickKey] || 0) - 0.015, -0.18, 0.18);
      }
    }

    memory.learningLog.unshift({
      at: new Date().toISOString(),
      gamePk: prediction.gamePk,
      matchup: prediction.matchup,
      pick: prediction.pick.name,
      pickProbability: prediction.pick.winProbability,
      winner: result.winner.name,
      score: `${result.away.abbreviation || result.away.name} ${result.away.score} - ${result.home.score} ${result.home.abbreviation || result.home.name}`,
      correct,
      firstInningCorrect,
      firstInningPick: prediction.firstInning?.pick || null,
      firstInningActual:
        result.firstInning?.anyRun === null ? null : result.firstInning.anyRun ? 'YES' : 'NO',
      note: correct
        ? `Pick benar: ${prediction.pick.name}. Bias model diperkuat kecil.`
        : `Pick salah: ${prediction.pick.name}, pemenang ${result.winner.name}. Memory menurunkan bias pick dan menaikkan bias pemenang.`
    });

    memory.learningLog = memory.learningLog.slice(0, 75);
    this.markPostGameProcessed(prediction.gamePk);
  }
}
