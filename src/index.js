import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { ANALYST_SKILL_VERSION, buildAnalystSkillSummary } from './analystSkill.js';
import {
  analyzePredictionsWithAgent,
  answerInteractiveQuestion,
  summarizeDailyAlertWithOpenAI
} from './llm.js';
import {
  applyMoneylineValueMarket,
  applyTotalRunMarket,
  formatPredictions,
  getFinalGameResults,
  getMlbPredictions,
  getMlbScheduleChoices,
  moneylineDecisionLines
} from './mlb.js';
import { Storage } from './storage.js';
import { setupWebhook, TelegramBot } from './telegram.js';
import { UI_LINE, UI_THIN_LINE, uiBullet, uiCommand, uiKV, uiSection, uiTitle } from './telegramFormat.js';
import { dateInTimezone, isValidDateYmd, percent, timeInTimezone } from './utils.js';
import { startDashboard } from './dashboard.js';
import {
  attachCurrentOdds,
  checkLineMovement,
  configureLineMonitor,
  lineMonitorSettings,
  startLineMonitor,
  stopLineMonitorForChat
} from './lineMovement.js';

const config = loadConfig();
const storage = new Storage();
let postGameCheckRunning = false;
let autoUpdateCheckRunning = false;
const PREDICT_CALLBACK_PREFIX = 'predict_live:';
const LEGACY_PREDICT_CALLBACK_PREFIX = 'predict:';
const AGENT_TOOL_CALLBACK_PREFIX = 'agent_tool:';
const TOTAL_MARKET_BUTTONS = [6.5, 7.5, 8.5, 9.5, 10.5, 11.5];
const EVOLUTION_COMMANDS = {
  run: {
    module: 'src.evolution.evolution_engine',
    args: ['--run-cycle'],
    label: 'Evolution cycle'
  },
  summary: {
    module: 'src.evolution.evolution_report',
    args: ['--summary'],
    label: 'Evolution summary'
  },
  logtoday: {
    module: 'src.evolution.trajectory_logger',
    args: ['--log-today'],
    label: 'Log trajectory hari ini'
  },
  evaluate: {
    module: 'src.evolution.evolution_engine',
    args: ['--evaluate-yesterday'],
    label: 'Evaluate yesterday'
  },
  lessons: {
    module: 'src.evolution.evolution_engine',
    args: ['--generate-lessons'],
    label: 'Generate lessons'
  },
  loss: {
    module: 'src.evolution.language_loss',
    args: ['--generate'],
    label: 'Generate language loss'
  },
  gradient: {
    module: 'src.evolution.language_gradient',
    args: ['--generate'],
    label: 'Generate language gradients'
  },
  propose: {
    module: 'src.evolution.symbolic_optimizer',
    args: ['--propose-updates'],
    label: 'Propose symbolic updates'
  },
  rules: {
    module: 'src.evolution.evolution_engine',
    args: ['--propose-rules'],
    label: 'Propose rule candidates'
  },
  backtest: {
    module: 'src.evolution.evolution_engine',
    args: ['--backtest-candidates'],
    label: 'Backtest candidates'
  },
  promote: {
    module: 'src.evolution.evolution_engine',
    args: ['--promote-approved'],
    label: 'Promotion status'
  }
};
const EVOLUTION_ALIASES = {
  start: 'run',
  learn: 'run',
  belajar: 'run',
  cycle: 'run',
  status: 'summary',
  eval: 'evaluate',
  yesterday: 'evaluate',
  lesson: 'lessons',
  losses: 'loss',
  gradients: 'gradient',
  candidate: 'propose',
  candidates: 'propose',
  update: 'propose',
  updates: 'propose',
  rule: 'rules',
  approve: 'promote',
  promotion: 'promote',
  log: 'logtoday',
  logtoday: 'logtoday'
};
const AUDIT_COMMAND = {
  module: 'src.evolution.evolution_audit',
  args: ['--summary', '--apply-safe'],
  label: 'Evolution audit + safe apply'
};

function helpText() {
  return [
    uiTitle('⚾', 'MLB Bot | command utama'),
    '',
    uiSection('📋', '6 command aktif'),
    uiCommand('/today', 'list ringkas semua game hari ini'),
    uiCommand('/deep', 'semua game dengan statistik lengkap'),
    uiCommand('/game TEAM', 'cek tim tertentu hari ini'),
    uiCommand('/ask pertanyaan', 'tanya Analyst Agent, termasuk top pick'),
    uiCommand('/audit', 'audit kelemahan + apply guardrail aman'),
    uiCommand('/linealerts on|off|status', 'atur notifikasi line movement'),
    '',
    uiBullet('💬', 'Pertanyaan biasa tanpa slash tetap masuk ke Analyst Agent.'),
    uiBullet('🧰', 'Command lama tetap hidden/backward-compatible, tapi tidak ditampilkan agar menu bersih.')
  ].join('\n');
}

function botCommandList() {
  return [
    { command: 'today', description: 'List ringkas semua game' },
    { command: 'deep', description: 'Semua game dengan statistik lengkap' },
    { command: 'game', description: 'Cek tim tertentu hari ini' },
    { command: 'ask', description: 'Tanya Analyst Agent' },
    { command: 'audit', description: 'Audit + safe guardrail' },
    { command: 'linealerts', description: 'Atur line movement alerts' }
  ];
}

function isAllowed(chatId) {
  if (config.allowedChatIds.length === 0) return true;
  return config.allowedChatIds.includes(String(chatId));
}

async function buildAlertPayload(dateYmd, options = {}) {
  const modelMemory = config.modelMemory ? storage.getMemory() : {};
  const predictions = await getMlbPredictions(dateYmd, modelMemory);
  const includeAdvanced = options.includeAdvanced ?? config.alertDetail === 'full';

  await attachOddsContext(predictions);
  await attachAgentAnalyses(predictions);
  await attachMarketContext(predictions);
  storage.savePredictions(dateYmd, predictions);

  if (options.allowSummary && !options.teamFilter && !includeAdvanced && !config.analystAgent.enabled) {
    const llmText = await summarizeDailyAlertWithOpenAI(config, predictions).catch(() => null);
    if (llmText) return { text: llmText, predictions };
  }

  return {
    text: formatPredictions(dateYmd, predictions, {
      maxGames: options.maxGames ?? (includeAdvanced ? config.maxGamesPerMessage : predictions.length),
      teamFilter: options.teamFilter || '',
      includeAdvanced
    }),
    predictions
  };
}

async function attachOddsContext(predictions) {
  await attachCurrentOdds(predictions).catch((error) => {
    console.warn('Odds/value engine context unavailable:', error.message);
    return null;
  });
}

async function attachMarketContext(predictions) {
  if (!predictions.some((prediction) => prediction.currentOdds)) {
    await attachOddsContext(predictions);
  }

  for (const prediction of predictions) {
    if (prediction.currentOdds?.totalLine && prediction.totalRuns) {
      prediction.totalRuns = applyTotalRunMarket(prediction.totalRuns, prediction.currentOdds.totalLine);
    }
    applyMoneylineValueMarket(prediction);
  }

  return predictions;
}

async function buildAlert(dateYmd, options = {}) {
  const payload = await buildAlertPayload(dateYmd, options);
  return payload.text;
}

async function attachAgentAnalyses(predictions) {
  const analyses = await analyzePredictionsWithAgent(
    config,
    predictions,
    storage.getMemorySummary()
  ).catch((error) => {
    console.error('Analyst Agent error:', error.message);
    return [];
  });

  const analysesByGame = new Map(analyses.map((analysis) => [analysis.gamePk, analysis]));
  for (const prediction of predictions) {
    const analysis = analysesByGame.get(prediction.gamePk) || null;
    prediction.agentAnalysis = analysis;
    if (analysis?.firstInning && prediction.firstInning) {
      prediction.firstInning.agent = analysis.firstInning;
    }
  }

  return predictions;
}

function targetChatIds() {
  const chatIds = new Set(storage.listSubscriberIds());
  if (config.telegramChatId) chatIds.add(String(config.telegramChatId));
  return [...chatIds];
}

function isValidTime(value) {
  if (!/^\d{2}:\d{2}$/.test(String(value || ''))) return false;
  const [hour, minute] = String(value).split(':').map((item) => Number.parseInt(item, 10));
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function targetAutoUpdateChats() {
  const targets = new Map();
  for (const target of storage.listAutoUpdateTargets(config.dailyAlertTime)) {
    targets.set(String(target.chatId), target);
  }

  if (config.autoAlerts) {
    for (const chatId of targetChatIds()) {
      if (!targets.has(String(chatId))) {
        targets.set(String(chatId), {
          chatId: String(chatId),
          title: String(chatId),
          dailyTime: config.dailyAlertTime,
          lastSentDate: storage.getLastAutoAlertDate(),
          legacyEnv: true
        });
      }
    }
  }

  return [...targets.values()];
}

async function sendTextToAll(bot, text) {
  const chatIds = targetChatIds();
  for (const chatId of chatIds) {
    await bot.sendMessage(chatId, text).catch((error) => {
      console.error(`Gagal kirim ke ${chatId}:`, error.message);
    });
  }

  return chatIds.length;
}

function maybeStartLineMonitor(predictions, chatId, dateYmd) {
  if (dateYmd !== dateInTimezone(config.timezone)) return;
  startLineMonitor(predictions, chatId);
}

async function sendAlert(bot, chatId, dateYmd, options = {}) {
  await bot.sendMessage(chatId, uiKV('⏳', 'Mengambil data MLB', dateYmd));
  const { text, predictions } = await buildAlertPayload(dateYmd, options);
  await bot.sendMessage(chatId, text);
  maybeStartLineMonitor(predictions, chatId, dateYmd);
  console.log(`Alert ${dateYmd} sent to ${chatId}.`);
}

function predictionHelpText() {
  return [
    uiTitle('📊', 'MLB Prediction | help'),
    '',
    uiKV('🧭', 'Menu', '/predict'),
    uiKV('⌨️', 'Manual', '/predict HOME | AWAY | odds_opsional'),
    '',
    uiSection('💡', 'Contoh'),
    uiCommand('/predict', 'pilih game dari tombol'),
    uiCommand('/predict 2026-04-27', 'pilih game tanggal tertentu'),
    uiCommand('/predict Los Angeles Dodgers | New York Yankees', 'manual matchup'),
    uiCommand('/predict Los Angeles Dodgers | New York Yankees | -120', 'manual + American odds'),
    uiCommand('/predict Los Angeles Dodgers | New York Yankees | decimal 1.91', 'manual + decimal odds'),
    '',
    uiBullet('⚠️', '/predict tanpa matchup memakai schedule MLB live. Tombol Total 6.5-11.5 dipakai untuk cek market total.')
  ].join('\n');
}

function predictionKeyboard(dateYmd, games) {
  return {
    inline_keyboard: games.map((game) => [
      {
        text: `${game.away.abbreviation || game.away.name} @ ${game.home.abbreviation || game.home.name} - ${game.start}`,
        callback_data: `${PREDICT_CALLBACK_PREFIX}${dateYmd}:${game.gamePk}`
      }
    ])
  };
}

function totalMarketKeyboard(dateYmd, gamePk) {
  return {
    inline_keyboard: [
      TOTAL_MARKET_BUTTONS.slice(0, 3).map((line) => ({
        text: `Total ${line}`,
        callback_data: `${PREDICT_CALLBACK_PREFIX}${dateYmd}:${gamePk}:${line}`
      })),
      TOTAL_MARKET_BUTTONS.slice(3).map((line) => ({
        text: `Total ${line}`,
        callback_data: `${PREDICT_CALLBACK_PREFIX}${dateYmd}:${gamePk}:${line}`
      })),
      [
        {
          text: 'Refresh',
          callback_data: `${PREDICT_CALLBACK_PREFIX}${dateYmd}:${gamePk}`
        }
      ]
    ]
  };
}

async function sendPredictionGameMenu(bot, chatId, dateYmd = '') {
  const targetDate = dateYmd || dateInTimezone(config.timezone);
  const games = await getMlbScheduleChoices(targetDate);

  if (games.length === 0) {
    await bot.sendMessage(
      chatId,
      [
        uiTitle('📊', 'MLB Prediction | game list'),
        uiKV('📅', 'Tanggal', targetDate),
        '',
        uiBullet('⚠️', 'Tidak ada game MLB pada tanggal ini.'),
        uiCommand('/predict Los Angeles Dodgers | New York Yankees', 'pakai format manual')
      ].join('\n')
    );
    return;
  }

  await bot.sendMessage(
    chatId,
    [
      uiTitle('📊', 'Pilih Game | MLB prediction'),
      uiKV('📅', 'Tanggal', targetDate),
      uiKV('📡', 'Sumber', `MLB StatsAPI live schedule | ${games.length} game`),
      '',
      uiBullet('👇', 'Tap salah satu matchup di bawah.')
    ].join('\n'),
    {
      reply_markup: predictionKeyboard(targetDate, games)
    }
  );
}

function parsePredictCommand(text) {
  const payload = text.replace(/^\/predict(?:@\S+)?\s*/i, '').trim();
  if (!payload) return { menu: true };
  if (isValidDateYmd(payload)) return { menu: true, dateYmd: payload };

  const parts = payload
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) return null;

  const [home, away, rawOdds] = parts;
  let odds = '';
  let oddsFormat = 'american';

  if (rawOdds) {
    const decimalMatch = rawOdds.match(/^(decimal|dec)\s+(.+)$/i);
    if (decimalMatch) {
      oddsFormat = 'decimal';
      odds = decimalMatch[2].trim();
    } else {
      odds = rawOdds;
    }
  }

  return { home, away, odds, oddsFormat };
}

function runPythonPrediction({ home, away, odds, oddsFormat }) {
  return new Promise((resolve, reject) => {
    const args = ['-m', 'src.predict', '--home', home, '--away', away];
    if (odds) {
      args.push('--home-odds', odds, '--odds-format', oddsFormat);
    }

    const child = spawn(config.pythonExecutable, args, {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Python prediction timeout. Coba lagi atau cek PYTHON_BIN.'));
    }, 20_000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error((stderr || stdout || `Python exited with code ${code}`).trim()));
    });
  });
}

function runAgentBridge(action, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.pythonExecutable, ['-m', 'src.telegram_agent_bridge', action, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1'
      },
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Agent tools timeout. Coba lagi sebentar.'));
    }, 20_000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || stdout || `Python exited with code ${code}`).trim()));
        return;
      }

      try {
        resolve(JSON.parse(stdout.trim() || '{}'));
      } catch (error) {
        reject(new Error(`Agent tools output tidak valid: ${error.message}`));
      }
    });
  });
}

function runPythonModule(moduleName, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.pythonExecutable, ['-m', moduleName, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1'
      },
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(options.timeoutMessage || 'Evolution command timeout. Coba lagi sebentar.'));
    }, options.timeoutMs || 60_000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || stdout || `Python exited with code ${code}`).trim()));
        return;
      }

      resolve(stdout.trim());
    });
  });
}

function formatPythonPredictionOutput(output) {
  return [
    uiTitle('📊', 'MLB Python Prediction'),
    '',
    output,
    '',
    uiBullet('⚠️', 'Estimasi model, bukan jaminan hasil atau betting advice.')
  ].join('\n');
}

function evolutionHelpText() {
  return [
    uiTitle('🧠', 'MLB Agent Evolution | help'),
    '',
    uiSection('📋', 'Telegram command'),
    uiCommand('/evolve', 'jalankan evolution cycle dari history/post-game'),
    uiCommand('/evolve run', 'sama seperti /evolve'),
    uiCommand('/evolve summary', 'ringkasan evolution'),
    uiCommand('/evolve logtoday', 'simpan trajectory pre-game hari ini'),
    uiCommand('/evolve evaluate', 'evaluasi game kemarin'),
    uiCommand('/evolve lessons', 'cek lesson tersimpan'),
    uiCommand('/evolve loss', 'generate language loss'),
    uiCommand('/evolve gradient', 'generate language gradient'),
    uiCommand('/evolve propose', 'propose symbolic update'),
    uiCommand('/evolve rules', 'propose rule candidate'),
    uiCommand('/evolve backtest', 'cek candidate yang perlu backtest'),
    uiCommand('/evolve promote', 'cek status promotion gate'),
    '',
    uiBullet('🛡️', 'Tidak auto-ubah production. Semua candidate tetap butuh backtest dan promotion gate.')
  ].join('\n');
}

function parseJsonOutput(output) {
  try {
    return JSON.parse(output || '{}');
  } catch {
    return { raw: output };
  }
}

function formatEvolutionSummary(payload) {
  const summary = payload.summary || {};
  return [
    uiTitle('🧠', 'MLB Agent Evolution | summary'),
    '',
    uiKV('📊', 'Evaluated', summary.total_predictions_evaluated || 0),
    uiKV('📚', 'Lessons', summary.lessons_generated || 0),
    uiKV('⚠️', 'Language loss', summary.language_losses_generated || 0),
    uiKV('🧭', 'Language gradient', summary.language_gradients_generated || 0),
    uiKV('🧪', 'Candidates', summary.candidates_proposed || 0),
    uiKV('✅', 'Approved', summary.candidates_approved || 0),
    uiKV('❌', 'Rejected', summary.candidates_rejected || 0),
    '',
    uiSection('🏷️', 'Active versions'),
    uiKV('💬', 'Prompt', summary.current_prompt_version || '-'),
    uiKV('📏', 'Rules', summary.current_rule_version || '-'),
    uiKV('⚖️', 'Weights', summary.current_weight_version || '-'),
    '',
    uiBullet('📌', 'Lihat detail di dashboard tab Evolution.')
  ].join('\n');
}

function formatEvolutionCycleResult(payload) {
  const postgame = payload.postgame || {};
  const ingest = payload.ingest || {};
  const summary = payload.summary || {};
  return [
    uiTitle('🧠', 'MLB Agent Evolution | run'),
    '',
    uiKV('🏁', 'Post-game dates checked', postgame.dates_checked || 0),
    uiKV('🧠', 'New games learned', postgame.learned_games || 0),
    uiKV('📚', 'History rows found', ingest.history_rows || 0),
    uiKV('📊', 'Evaluations added', ingest.evaluated || 0),
    uiKV('♻️', 'Duplicates skipped', ingest.skipped_duplicates || 0),
    uiKV('📘', 'Lessons added', ingest.lessons || 0),
    uiKV('⚠️', 'Language losses added', ingest.language_losses || 0),
    uiKV('🧭', 'Language gradients added', ingest.language_gradients || 0),
    uiKV('🧪', 'Symbolic candidates added', payload.symbolic_candidates || 0),
    uiKV('📏', 'Rule candidates added', payload.rule_candidates || 0),
    '',
    uiSection('📌', 'Current totals'),
    uiKV('📊', 'Evaluated', summary.total_predictions_evaluated || 0),
    uiKV('📚', 'Lessons', summary.lessons_generated || 0),
    uiKV('🧭', 'Gradients', summary.language_gradients_generated || 0),
    uiKV('🧪', 'Candidates', summary.candidates_proposed || 0),
    '',
    uiBullet('🛡️', 'Candidate tidak auto-promote. Rules/prompt/weights production tetap menunggu backtest dan promotion gate.')
  ].join('\n');
}

function formatAuditSegment(segment) {
  const record = segment.decided
    ? `${segment.wins || 0}-${segment.losses || 0}`
    : `${segment.no_bets || 0} no-bet`;
  const rate = segment.decided ? `${segment.accuracy || 0}%` : `NB quality ${segment.no_bet_quality || 0}%`;
  return uiBullet('•', `${segment.segment} | ${record} | ${rate} | ${segment.sample_size || 0} sample`);
}

function formatAuditCalibration(bucket) {
  return uiBullet(
    '•',
    `${bucket.bucket} | ${bucket.wins || 0}-${bucket.losses || 0} | pred ${bucket.avg_predicted_probability || 0}% | actual ${bucket.observed_win_rate || 0}% | ${bucket.verdict || 'unknown'}`
  );
}

function formatReasonQuality(item) {
  const sample = item.sample_size || 0;
  const record = sample ? `${item.wins || 0}-${item.losses || 0}` : `${item.loss_mentions || 0} loss mentions`;
  return uiBullet('•', `${item.factor} | ${record} | ${item.accuracy || 0}% | ${item.verdict || 'neutral'}`);
}

function formatConfidenceCapCandidate(item) {
  return uiBullet('•', `${item.target || item.type} | ${item.update || item.reason}`);
}

function formatAppliedAuditUpdate(item) {
  return uiBullet('•', `${item.type || 'weight'} | ${item.rule || item.reason || item.version}`);
}

function formatEvolutionAudit(payload) {
  const summary = payload.summary || {};
  const weakest = payload.weakest_segments || [];
  const causes = payload.root_causes || [];
  const recommendations = payload.priority_recommendations || [];
  const candidates = payload.candidate_priorities || [];
  const calibration = payload.calibration_buckets || [];
  const clv = payload.clv_report || {};
  const reasonQuality = payload.reason_quality || [];
  const confidenceCaps = payload.confidence_cap_candidates || [];
  const applied = payload.applied_updates || {};
  const appliedRules = applied.rules_added || [];
  const appliedWeights = applied.weight_versions_added || [];

  return [
    uiTitle('🔎', 'MLB Agent Evolution | audit'),
    '',
    uiKV('📊', 'Evaluated', summary.evaluated || 0),
    uiKV('🎯', 'Decided', summary.decided || 0),
    uiKV('🏁', 'Record', `${summary.wins || 0}-${summary.losses || 0}`),
    uiKV('📈', 'Accuracy', `${summary.accuracy || 0}%`),
    uiKV('🛑', 'No Bet', summary.no_bets || 0),
    summary.average_clv !== null && summary.average_clv !== undefined ? uiKV('📉', 'Avg CLV', summary.average_clv) : null,
    uiKV('📈', 'CLV sample', `${clv.sample_size || 0} | avg ${clv.average_clv ?? '-'} | positive ${clv.positive_rate || 0}%`),
    '',
    uiSection('🎚️', 'Calibration buckets'),
    ...(calibration.length ? calibration.slice(0, 5).map(formatAuditCalibration) : [uiBullet('•', 'Belum ada sample calibration.')]),
    '',
    uiSection('🧾', 'Reason quality'),
    ...(reasonQuality.length ? reasonQuality.slice(0, 5).map(formatReasonQuality) : [uiBullet('•', 'Belum ada reason quality sample.')]),
    '',
    uiSection('🧯', 'Confidence cap candidates'),
    ...(confidenceCaps.length ? confidenceCaps.slice(0, 4).map(formatConfidenceCapCandidate) : [uiBullet('•', 'Belum ada confidence cap candidate dari audit.')]),
    '',
    uiSection('⚠️', 'Weakest segments'),
    ...(weakest.length ? weakest.slice(0, 4).map(formatAuditSegment) : [uiBullet('•', 'Belum cukup sample segment.')]),
    '',
    uiSection('🧩', 'Root causes'),
    ...(causes.length
      ? causes.slice(0, 5).map((cause) => uiBullet('•', `${cause.loss_type} | ${cause.count}x | ${cause.primary_factor}`))
      : [uiBullet('•', 'Belum ada language loss.')]),
    '',
    uiSection('🛠️', 'Top fixes'),
    ...(recommendations.length
      ? recommendations.slice(0, 4).map((item, index) => `${index + 1}. ${item.recommendation}`)
      : ['1. Jalankan /audit setelah beberapa game final agar weakness/lesson terlihat.']),
    '',
    uiSection('🧪', 'Candidate priority'),
    ...(candidates.length
      ? candidates.slice(0, 3).map((item) => uiBullet('•', `${item.type} | score ${item.priority_score} | backtest ${item.backtest_status}`))
      : [uiBullet('•', 'Belum ada candidate prioritas.')]),
    '',
    uiSection('🔧', 'Applied safe updates'),
    ...(appliedRules.length || appliedWeights.length
      ? [
          ...appliedRules.map(formatAppliedAuditUpdate),
          ...appliedWeights.map((item) => uiBullet('•', `weight_version | ${item.version} | SP weight adjusted safely`))
        ]
      : [uiBullet('•', 'Tidak ada update baru. Guardrail aktif yang sama tidak ditulis ulang.')]),
    '',
    uiBullet('🛡️', 'Audit boleh apply guardrail konservatif. Tidak menaikkan confidence dan tidak menghapus NO BET protection.')
  ]
    .filter((line) => line !== null && line !== undefined)
    .join('\n');
}

function formatKeyValuePayload(title, payload) {
  if (payload.raw) {
    return [uiTitle('📦', title), '', payload.raw].join('\n');
  }

  const lines = Object.entries(payload).map(([key, value]) => {
    const label = key.replace(/_/g, ' ');
    if (Array.isArray(value)) return uiKV('•', label, value.length);
    if (value && typeof value === 'object') return uiKV('•', label, JSON.stringify(value));
    return uiKV('•', label, value);
  });

  return [uiTitle('📦', title), '', ...(lines.length ? lines : [uiBullet('•', 'Tidak ada perubahan.')])].join('\n');
}

function formatEvolutionResult(action, payload) {
  if (action === 'run') return formatEvolutionCycleResult(payload);
  if (action === 'summary') return formatEvolutionSummary(payload);
  return formatKeyValuePayload(EVOLUTION_COMMANDS[action]?.label || 'Evolution command', payload);
}

async function processStoredPostGamesForEvolution() {
  const dates = storage.listPendingPredictionDates();
  const result = {
    dates_checked: 0,
    evaluated_games: 0,
    learned_games: 0,
    errors: []
  };

  for (const dateYmd of dates) {
    result.dates_checked += 1;
    try {
      const evaluations = await evaluatePostGames(dateYmd, {
        markProcessed: true,
        includeProcessed: false
      });
      result.evaluated_games += evaluations.length;
      result.learned_games += evaluations.filter((evaluation) => evaluation.learned).length;
    } catch (error) {
      result.errors.push(`${dateYmd}: ${error.message}`);
    }
  }

  return result;
}

async function handleEvolutionCommand(bot, chatId, args) {
  const requested = String(args[0] || 'run').toLowerCase();
  if (requested === 'help' || requested === 'menu') {
    await bot.sendMessage(chatId, evolutionHelpText());
    return;
  }

  const action = EVOLUTION_COMMANDS[requested] ? requested : EVOLUTION_ALIASES[requested];
  if (!action || !EVOLUTION_COMMANDS[action]) {
    await bot.sendMessage(chatId, evolutionHelpText());
    return;
  }

  const commandConfig = EVOLUTION_COMMANDS[action];
  const commandArgs = [...commandConfig.args];
  if (action === 'logtoday') {
    const source = String(args[1] || 'live').toLowerCase();
    if (['live', 'sample', 'mock'].includes(source)) {
      commandArgs.push('--source', source);
    }
  }

  await bot.sendMessage(chatId, uiKV('⏳', 'Menjalankan', commandConfig.label));
  const postgame = action === 'run' ? await processStoredPostGamesForEvolution() : null;
  const output = await runPythonModule(commandConfig.module, commandArgs, {
    timeoutMessage: 'Evolution command timeout. Coba lagi sebentar.',
    timeoutMs: 90_000
  });
  const payload = parseJsonOutput(output);
  if (postgame) payload.postgame = postgame;
  await bot.sendMessage(chatId, formatEvolutionResult(action, payload));
}

async function handleAuditCommand(bot, chatId) {
  await bot.sendMessage(chatId, uiKV('⏳', 'Menjalankan', 'Evolution audit'));
  const output = await runPythonModule(AUDIT_COMMAND.module, AUDIT_COMMAND.args, {
    timeoutMessage: 'Audit command timeout. Coba lagi sebentar.',
    timeoutMs: 90_000
  });
  const payload = parseJsonOutput(output);
  await bot.sendMessage(chatId, formatEvolutionAudit(payload));
}

function agentToolHomeKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'Game Tools', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}games` },
        { text: 'Knowledge', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}knowledge` }
      ]
    ]
  };
}

function agentToolGamesKeyboard(games) {
  return {
    inline_keyboard: [
      ...games.map((game) => [
        {
          text: game.label,
          callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}game:${game.id}`
        }
      ]),
      [{ text: 'Knowledge', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}knowledge` }]
    ]
  };
}

function agentToolActionKeyboard(gameId) {
  return {
    inline_keyboard: [
      [
        { text: 'Moneyline', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}moneyline:${gameId}` },
        { text: 'Total', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}total:${gameId}` }
      ],
      [
        { text: 'Context', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}context:${gameId}` },
        { text: 'Full', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}full:${gameId}` }
      ],
      [{ text: 'Back to Games', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}games` }]
    ]
  };
}

function agentKnowledgeKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'wRC+ vs OPS', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}kb:wrc` },
        { text: 'FIP vs ERA', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}kb:fip` }
      ],
      [
        { text: 'Wind & Over', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}kb:wind` },
        { text: 'Bullpen Fatigue', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}kb:bullpen` }
      ],
      [
        { text: 'Market Total', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}kb:market` },
        { text: 'Value Bet', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}kb:value` }
      ],
      [
        { text: 'Markets', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}kb:markets` },
        { text: 'First 5', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}kb:f5` }
      ],
      [{ text: 'Game Tools', callback_data: `${AGENT_TOOL_CALLBACK_PREFIX}games` }]
    ]
  };
}

async function sendAgentToolsMenu(bot, chatId) {
  await bot.sendMessage(
    chatId,
    [uiTitle('🧰', 'MLB Agent Tools'), '', uiBullet('👇', 'Pilih action.')].join('\n'),
    { reply_markup: agentToolHomeKeyboard() }
  );
}

async function sendAgentToolGames(bot, chatId) {
  const payload = await runAgentBridge('games');
  await bot.sendMessage(chatId, payload.text || uiTitle('📋', 'Pilih Game'), {
    reply_markup: agentToolGamesKeyboard(payload.games || [])
  });
}

async function sendKnowledgeAnswer(bot, chatId, query) {
  const payload = await runAgentBridge('knowledge', [query]);
  await bot.sendMessage(chatId, payload.text || uiBullet('⚠️', 'Knowledge tidak tersedia.'), {
    reply_markup: agentKnowledgeKeyboard()
  });
}

function displayedPredictionProbabilities(prediction) {
  return {
    away: prediction.agentAnalysis?.awayProbability ?? Math.round(prediction.away.winProbability),
    home: prediction.agentAnalysis?.homeProbability ?? Math.round(prediction.home.winProbability)
  };
}

function predictionPick(prediction) {
  const agent = prediction.agentAnalysis;
  if (agent?.pickTeamId === prediction.away.id) return prediction.away;
  if (agent?.pickTeamId === prediction.home.id) return prediction.home;
  return prediction.winner;
}

function signedRuns(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '-';
  return `${parsed >= 0 ? '+' : ''}${parsed.toFixed(1)}`;
}

function sumNumberValues(...values) {
  return values.reduce((sum, value) => {
    const parsed = Number(value);
    return sum + (Number.isFinite(parsed) ? parsed : 0);
  }, 0);
}

function totalProbabilityLines(label, probabilities) {
  return TOTAL_MARKET_BUTTONS.map(
    (line) => uiKV('•', `${label} ${line}`, percent(probabilities[String(line)] || 0))
  );
}

function totalDriverLines(totalDetail) {
  return [
    uiKV('•', 'Offense', signedRuns(sumNumberValues(totalDetail.homeOffense, totalDetail.awayOffense))),
    uiKV('•', 'Starting pitcher', signedRuns(sumNumberValues(totalDetail.homeStarterAllowed, totalDetail.awayStarterAllowed))),
    uiKV('•', 'Bullpen', signedRuns(sumNumberValues(totalDetail.homeBullpenAllowed, totalDetail.awayBullpenAllowed))),
    uiKV('•', 'Weather', signedRuns(totalDetail.weather)),
    uiKV('•', 'Lineup', signedRuns(sumNumberValues(totalDetail.homeLineupAdj, totalDetail.awayLineupAdj)))
  ];
}

function lineupContextLines(lineupLine) {
  const lines = String(lineupLine || '')
    .split(' | ')
    .filter(Boolean);

  return lines.length ? lines.map((line) => uiBullet('•', line)) : [uiKV('•', 'Lineup', 'belum tersedia')];
}

function formatLivePrediction(dateYmd, prediction, options = {}) {
  const probabilities = displayedPredictionProbabilities(prediction);
  const pick = predictionPick(prediction);
  const agentActive = Boolean(prediction.agentAnalysis);
  const reasons = agentActive ? prediction.agentAnalysis.reasons : prediction.reasons;
  const confidence = agentActive ? prediction.agentAnalysis.confidence : 'model';
  const pickProbability =
    pick.id === prediction.away.id ? probabilities.away : probabilities.home;
  const opponent = pick.id === prediction.away.id ? prediction.home : prediction.away;
  const opponentProbability =
    pick.id === prediction.away.id ? probabilities.home : probabilities.away;
  const firstInning = prediction.firstInning;
  const firstPick = firstInning?.agent?.pick || firstInning?.baselinePick || 'NO';
  const firstProbability = firstInning?.agent?.probability ?? firstInning?.baselineProbability ?? 50;
  const firstLabel = firstPick === 'YES' ? 'YES / YRFI' : 'NO / NRFI';
  const injuryLines = prediction.injuryDetailLines?.length
    ? prediction.injuryDetailLines.map((line) => `• ${line}`)
    : [`• ${prediction.injuryLine || 'Data injury tidak tersedia.'}`];
  const modelReferenceLines = prediction.modelReferenceLines?.length
    ? prediction.modelReferenceLines.map((line) => `• ${line}`)
    : [`• ${prediction.modelReferenceLine}`];
  const totalMarketLine = options.marketLine ?? prediction.currentOdds?.totalLine ?? prediction.totalRuns?.marketLine;
  const totalRuns = applyTotalRunMarket(prediction.totalRuns, totalMarketLine);
  const totalDetail = totalRuns?.detail || {};
  const totalRunLines = totalRuns
    ? [
        uiSection('📌', 'Projection'),
        uiKV('•', 'Projected total', `${totalRuns.projectedTotal.toFixed(1)} runs`),
        uiKV('•', 'Expected runs', `${prediction.away.abbreviation || prediction.away.name} ${totalRuns.awayExpectedRuns.toFixed(1)} | ${prediction.home.abbreviation || prediction.home.name} ${totalRuns.homeExpectedRuns.toFixed(1)}`),
        uiKV('•', 'Market total', `${totalRuns.marketLine} | ${signedRuns(totalRuns.marketDeltaRuns)} runs vs model`),
        uiKV('•', 'Best lean', `${totalRuns.bestLean} | ${totalRuns.confidence}`),
        uiKV('•', 'Model edge', `${signedRuns(totalRuns.modelEdge)}% vs 50% baseline`),
        '',
        uiSection('📈', 'Over Probability'),
        ...totalProbabilityLines('Over', totalRuns.over),
        '',
        uiSection('📉', 'Under Probability'),
        ...totalProbabilityLines('Under', totalRuns.under),
        '',
        uiSection('⚙️', 'Run Drivers'),
        ...totalDriverLines(totalDetail),
        '',
        uiSection('🏟️', 'Context'),
        uiKV('•', 'Park', `${totalRuns.detail?.park?.label || prediction.venue} | Run PF ${totalRuns.detail?.park?.runFactorPct || 100} | HR PF ${totalRuns.detail?.park?.homeRunFactorPct || 100}`),
        ...lineupContextLines(prediction.lineupLine),
        '',
        uiSection('🧾', 'Main Factors'),
        ...totalRuns.factors.slice(0, 4).map((factor) => `• ${factor}`)
      ]
    : ['Data total runs tidak tersedia.'];

  return [
    uiTitle('📊', 'MLB Prediction'),
    uiKV('📅', 'Tanggal', dateYmd),
    '',
    uiKV('🏟️', 'Matchup', `${prediction.away.name} @ ${prediction.home.name}`),
    uiKV('🕒', 'Waktu', prediction.start),
    uiKV('📍', 'Stadium', prediction.venue),
    '',
    UI_THIN_LINE,
    uiSection('🏆', 'Hasil Predict'),
    uiKV('✅', 'Predicted Winner', pick.name),
    uiKV('📈', 'Win Probability', percent(pickProbability)),
    uiKV('🥊', 'Opponent', `${opponent.name} | ${percent(opponentProbability)}`),
    uiKV('🎚️', 'Confidence', confidence),
    ...moneylineDecisionLines(prediction),
    uiKV('📡', 'Source', agentActive ? 'Analyst Agent + live MLB stats' : 'Baseline model + live MLB stats'),
    '',
    UI_THIN_LINE,
    uiSection('📊', 'Probabilitas Detail'),
    uiKV('📊', 'Model', `${prediction.away.abbreviation || prediction.away.name} ${percent(probabilities.away)} | ${prediction.home.abbreviation || prediction.home.name} ${percent(probabilities.home)}`),
    agentActive
      ? uiKV('📐', 'Baseline', `${prediction.away.abbreviation || prediction.away.name} ${percent(prediction.away.winProbability)} | ${prediction.home.abbreviation || prediction.home.name} ${percent(prediction.home.winProbability)}`)
      : null,
    '',
    UI_THIN_LINE,
    uiSection('🔥', 'Starting Pitcher'),
    `${prediction.away.starterLine} vs ${prediction.home.starterLine}`,
    '',
    uiSection('🏥', 'Injury Report'),
    ...injuryLines,
    '',
    uiSection('🧠', 'ML Reference'),
    ...modelReferenceLines,
    '',
    uiSection('🏁', 'First Inning'),
    uiKV('🏁', 'Run in 1st', `${firstLabel} | ${percent(firstProbability)}`),
    '',
    uiSection('🏃', 'Total Runs / Over-Under'),
    ...totalRunLines,
    '',
    uiSection('💡', 'Alasan'),
    ...reasons.slice(0, 3).map((reason) => `• ${reason}`),
    agentActive ? uiKV('⚠️', 'Risk', prediction.agentAnalysis.risk) : null,
    '',
    uiBullet('⚠️', 'Estimasi model, bukan jaminan hasil atau betting advice.')
  ]
    .filter((line) => line !== null && line !== undefined)
    .join('\n');
}

async function sendPythonPrediction(bot, chatId, text) {
  const request = parsePredictCommand(text);
  if (!request) {
    await bot.sendMessage(chatId, predictionHelpText());
    return;
  }

  if (request.menu) {
    await bot.sendMessage(
      chatId,
      uiKV('⏳', 'Mengambil semua game MLB', request.dateYmd || dateInTimezone(config.timezone))
    );
    await sendPredictionGameMenu(bot, chatId, request.dateYmd);
    return;
  }

  await bot.sendMessage(chatId, uiKV('⏳', 'Menjalankan Python prediction', `${request.away} @ ${request.home}`));
  const output = await runPythonPrediction(request);
  await bot.sendMessage(chatId, formatPythonPredictionOutput(output));
  console.log(`Python prediction handled for ${chatId}: ${request.away} @ ${request.home}.`);
}

async function handlePredictCallback(bot, callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  const data = callbackQuery.data || '';
  const [dateYmd, rawGamePk, rawMarketLine] = data.slice(PREDICT_CALLBACK_PREFIX.length).split(':');
  const gamePk = Number.parseInt(rawGamePk, 10);
  const marketLine = rawMarketLine ? Number.parseFloat(rawMarketLine) : undefined;

  await bot.answerCallbackQuery(callbackQuery.id, { text: 'Mengambil prediksi...' }).catch(() => {});

  if (!chatId) return;
  if (!isValidDateYmd(dateYmd) || !Number.isFinite(gamePk) || (rawMarketLine && !Number.isFinite(marketLine))) {
    await bot.sendMessage(chatId, uiBullet('⚠️', 'Data tombol tidak valid. Coba kirim /predict lagi untuk refresh daftar.'));
    return;
  }

  await bot.sendMessage(chatId, uiKV('⏳', 'Menganalisa game MLB', dateYmd));
  const modelMemory = config.modelMemory ? storage.getMemory() : {};
  const predictions = await getMlbPredictions(dateYmd, modelMemory);
  const prediction = predictions.find((item) => item.gamePk === gamePk);

  if (!prediction) {
    await bot.sendMessage(chatId, uiBullet('⚠️', 'Game tidak ditemukan. Coba kirim /predict lagi untuk refresh daftar.'));
    return;
  }

  await attachOddsContext([prediction]);
  await attachAgentAnalyses([prediction]);
  await attachMarketContext([prediction]);
  storage.savePredictions(dateYmd, [prediction]);
  await bot.sendMessage(chatId, formatLivePrediction(dateYmd, prediction, { marketLine }), {
    reply_markup: totalMarketKeyboard(dateYmd, gamePk)
  });
  console.log(
    `Live prediction callback handled for ${chatId}: ${prediction.away.name} @ ${prediction.home.name}.`
  );
}

async function handleAgentToolCallback(bot, callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  const data = callbackQuery.data || '';
  const [action, value = ''] = data.slice(AGENT_TOOL_CALLBACK_PREFIX.length).split(':');

  await bot.answerCallbackQuery(callbackQuery.id, { text: 'Loading...' }).catch(() => {});
  if (!chatId) return;

  if (action === 'games') {
    await sendAgentToolGames(bot, chatId);
    return;
  }

  if (action === 'knowledge') {
    await bot.sendMessage(chatId, uiTitle('📚', 'Pilih Topik | knowledge'), {
      reply_markup: agentKnowledgeKeyboard()
    });
    return;
  }

  if (action === 'kb') {
    await sendKnowledgeAnswer(bot, chatId, value || 'wrc');
    return;
  }

  if (action === 'game') {
    const payload = await runAgentBridge('game', [value]);
    await bot.sendMessage(chatId, payload.text || uiBullet('⚠️', 'Game tidak tersedia.'), {
      reply_markup: agentToolActionKeyboard(value)
    });
    return;
  }

  if (['moneyline', 'total', 'context', 'full'].includes(action)) {
    const payload = await runAgentBridge(action, [value]);
    await bot.sendMessage(chatId, payload.text || uiBullet('⚠️', 'Output tidak tersedia.'), {
      reply_markup: agentToolActionKeyboard(value)
    });
    return;
  }

  await bot.sendMessage(chatId, uiBullet('⚠️', 'Action tidak dikenal. Coba /agenttools lagi.'));
}

async function sendAlertToAll(bot, dateYmd) {
  const chatIds = targetChatIds();

  if (chatIds.length === 0) {
    return 0;
  }

  const { text, predictions } = await buildAlertPayload(dateYmd);
  for (const chatId of chatIds) {
    await bot
      .sendMessage(chatId, text)
      .then(() => {
        maybeStartLineMonitor(predictions, chatId, dateYmd);
      })
      .catch((error) => {
        console.error(`Gagal kirim ke ${chatId}:`, error.message);
      });
  }

  return chatIds.length;
}

function formatLineCheckMovement(movement) {
  const market =
    movement.storageMarket === 'total'
      ? 'Total'
      : `Moneyline ${movement.teamLabel || ''}`.trim();
  const delta =
    movement.unit === 'runs'
      ? `${movement.delta >= 0 ? '+' : ''}${movement.delta.toFixed(1)}`
      : `${movement.delta >= 0 ? '+' : ''}${Math.round(movement.delta)}`;

  return uiBullet('•', `${movement.matchup} | ${market} | ${movement.oldText} -> ${movement.newText} | ${delta} ${movement.unit}`);
}

function formatLineCheckSummary(dateYmd, result, { source = 'stored predictions' } = {}) {
  const settings = lineMonitorSettings();

  if (!result.hasOddsApiKey) {
    return [
      uiTitle('📊', 'Linecheck MLB'),
      uiKV('📅', 'Tanggal', dateYmd),
      '',
      uiBullet('⚠️', 'ODDS_API_KEY/THE_ODDS_API_KEY belum diisi, jadi odds live belum bisa dicek.')
    ].join('\n');
  }

  if (result.checkedGames === 0) {
    return [uiTitle('📊', 'Linecheck MLB'), uiKV('📅', 'Tanggal', dateYmd), '', uiBullet('⚠️', 'Tidak ada game aktif untuk dicek.')].join(
      '\n'
    );
  }

  const movementLines = result.movements.slice(0, 6).map(formatLineCheckMovement);
  const hiddenMovements = Math.max(0, result.movements.length - movementLines.length);

  return [
    uiTitle('📊', 'Linecheck MLB'),
    uiKV('📅', 'Tanggal', dateYmd),
    uiKV('📡', 'Sumber game', source),
    uiKV('🎯', 'Matched odds', `${result.matchedGames}/${result.checkedGames}`),
    uiKV('📏', 'Threshold', `ML ${settings.moneylineThreshold} cents | Total ${settings.totalThreshold} runs`),
    result.initializedSnapshots > 0
      ? uiKV('💾', 'Baseline odds tersimpan', `${result.initializedSnapshots} market`)
      : null,
    '',
    result.movements.length > 0
      ? uiKV('📈', 'Movement melewati threshold', `${result.movements.length} | ${result.alertsSent} alert terkirim`)
      : uiBullet('✅', 'Belum ada movement yang melewati threshold.'),
    ...movementLines,
    hiddenMovements > 0 ? uiBullet('➕', `${hiddenMovements} movement lain.`) : null
  ]
    .filter(Boolean)
    .join('\n');
}

async function loadLineCheckGames(dateYmd) {
  const storedPredictions = storage.listPredictionsByDate(dateYmd);
  if (storedPredictions.length > 0) {
    return { games: storedPredictions, source: 'stored pre-game alert' };
  }

  const scheduleGames = await getMlbScheduleChoices(dateYmd);
  return { games: scheduleGames, source: 'MLB live schedule' };
}

async function handleLineCheckCommand(bot, chatId) {
  const dateYmd = dateInTimezone(config.timezone);
  await bot.sendMessage(chatId, uiKV('⏳', 'Mengecek line movement MLB', dateYmd));
  const { games, source } = await loadLineCheckGames(dateYmd);
  const result = await checkLineMovement(games, chatId, { sendAlerts: true });
  await bot.sendMessage(chatId, formatLineCheckSummary(dateYmd, result, { source }));
}

function formatMemorySummary() {
  const summary = storage.getMemorySummary();
  const confidenceLines = Object.entries(summary.byConfidence || {})
    .map(([key, value]) => {
      const accuracy = value.total > 0 ? Math.round((value.correct / value.total) * 100) : 0;
      return uiKV('•', key, `${value.correct}/${value.total} | ${accuracy}%`);
    })
    .join('\n');
  const matchupMemory = summary.matchupMemory || { totalMatchups: 0, recent: [] };
  const matchupLines = (matchupMemory.recent || [])
    .map((item) => uiBullet('•', item.note))
    .join('\n');

  return [
    uiTitle('🧠', 'MLB Model Memory'),
    '',
    uiKV('📊', 'Total pick', summary.totalPicks),
    uiKV('✅', 'Benar', summary.correctPicks),
    uiKV('❌', 'Salah', summary.wrongPicks),
    uiKV('📈', 'Akurasi', `${summary.accuracy}%`),
    '',
    uiSection('🎚️', 'Confidence'),
    confidenceLines || 'Belum ada data confidence.',
    '',
    uiSection('🏁', 'First Inning'),
    uiKV('📊', 'Total', summary.firstInning.totalPicks),
    uiKV('✅', 'Benar', summary.firstInning.correctPicks),
    uiKV('❌', 'Salah', summary.firstInning.wrongPicks),
    uiKV('📈', 'Akurasi', `${summary.firstInning.accuracy}%`),
    uiKV('YES', 'Record', `${summary.firstInning.byPick.YES.correct}/${summary.firstInning.byPick.YES.total}`),
    uiKV('NO', 'Record', `${summary.firstInning.byPick.NO.correct}/${summary.firstInning.byPick.NO.total}`),
    '',
    uiSection('🧩', 'Matchup memory'),
    uiKV('📌', 'Tracked matchups', matchupMemory.totalMatchups),
    matchupLines || 'Belum ada matchup berulang yang tersimpan.',
    '',
    uiSection('🧠', 'Recent learning'),
    summary.recentLog.length
      ? summary.recentLog.map((item) => `${item.correct ? '✅' : '❌'} ${item.note}`).join('\n')
      : 'Belum ada post-game learning.'
  ].join('\n');
}

function formatAgentStatus() {
  const summary = storage.getMemorySummary();

  return [
    uiTitle('🤖', 'MLB Analyst Agent'),
    '',
    uiKV('🟢', 'Status', config.analystAgent.enabled ? 'aktif' : 'mati'),
    uiKV('⚙️', 'Mode', config.analystAgent.mode),
    uiKV('🧠', 'Skill', ANALYST_SKILL_VERSION),
    uiKV('🤖', 'Model', config.openai.model),
    uiKV('💾', 'Memory', config.modelMemory ? 'aktif' : 'mati'),
    uiKV('💬', 'Interactive chat', config.interactiveAgent ? 'aktif' : 'mati'),
    uiKV('🏁', 'Post-game learning', config.postGameAlerts ? 'aktif' : 'mati'),
    uiKV('🧰', 'Tools', '/agenttools | /kb'),
    '',
    uiKV('📊', 'Memory sample', `${summary.totalPicks} pick | akurasi ${summary.accuracy}%`),
    '',
    config.analystAgent.enabled
      ? uiBullet('✅', 'Agent membuat pick final dari stats, H2H, baseline model, dan memory.')
      : uiBullet('⚠️', 'Agent mati, bot memakai baseline model statistik.')
  ].join('\n');
}

function autoUpdateHelpText() {
  return [
    uiTitle('🔔', 'Auto Update MLB | help'),
    '',
    uiCommand('/autoupdate on', 'aktifkan update harian untuk chat ini'),
    uiCommand('/autoupdate off', 'matikan update harian'),
    uiCommand('/autoupdate time HH:mm', 'ubah jam update'),
    uiCommand('/autoupdate status', 'lihat status'),
    '',
    uiKV('🌐', 'Timezone', config.timezone),
    uiKV('🕒', 'Default time', config.dailyAlertTime)
  ].join('\n');
}

function formatAutoUpdateStatus(chatId) {
  const status = storage.getAutoUpdate(chatId);
  return [
    uiTitle('🔔', 'Auto Update MLB'),
    '',
    uiKV('🟢', 'Status', status.enabled ? 'aktif' : 'mati'),
    uiKV('🕒', 'Jam update', status.dailyTime || config.dailyAlertTime),
    uiKV('🌐', 'Timezone', config.timezone),
    uiKV('📤', 'Terakhir terkirim', status.lastSentDate || '-'),
    '',
    uiSection('📋', 'Command'),
    uiCommand('/autoupdate on', 'aktif'),
    uiCommand('/autoupdate off', 'mati'),
    uiCommand('/autoupdate time 20:00', 'ubah jam')
  ].join('\n');
}

async function handleAutoUpdateCommand(bot, chat, args) {
  const chatId = chat.id;
  const action = String(args[0] || 'status').toLowerCase();

  if (action === 'help') {
    await bot.sendMessage(chatId, autoUpdateHelpText());
    return;
  }

  if (action === 'status') {
    await bot.sendMessage(chatId, formatAutoUpdateStatus(chatId));
    return;
  }

  if (action === 'on') {
    const current = storage.getAutoUpdate(chatId);
    storage.setAutoUpdate(chat, {
      enabled: true,
      dailyTime: current.dailyTime || config.dailyAlertTime
    });
    await bot.sendMessage(chatId, formatAutoUpdateStatus(chatId));
    return;
  }

  if (action === 'off') {
    storage.setAutoUpdate(chat, { enabled: false });
    await bot.sendMessage(chatId, formatAutoUpdateStatus(chatId));
    return;
  }

  if (action === 'time') {
    const dailyTime = args[1];
    if (!isValidTime(dailyTime)) {
      await bot.sendMessage(chatId, uiKV('⌨️', 'Format jam salah', '/autoupdate time 20:00'));
      return;
    }

    storage.setAutoUpdate(chat, {
      enabled: true,
      dailyTime
    });
    await bot.sendMessage(chatId, formatAutoUpdateStatus(chatId));
    return;
  }

  await bot.sendMessage(chatId, autoUpdateHelpText());
}

function lineAlertsHelpText() {
  return [
    uiTitle('📈', 'Line Movement Alerts | help'),
    '',
    uiCommand('/linealerts on', 'aktifkan notifikasi line movement'),
    uiCommand('/linealerts off', 'matikan notifikasi line movement'),
    uiCommand('/linealerts status', 'lihat status'),
    '',
    uiSection('🔁', 'Alias'),
    uiCommand('/linemove on', 'aktif'),
    uiCommand('/linemove off', 'mati'),
    uiCommand('/linemove status', 'status')
  ].join('\n');
}

function formatLineAlertsStatus(chatId, stoppedCount = null) {
  const status = storage.getLineMovementAlerts(chatId);
  const settings = lineMonitorSettings();
  const lines = [
    uiTitle('📈', 'Line Movement Alerts'),
    '',
    uiKV('💬', 'Status chat', status.enabled ? 'aktif' : 'mati'),
    uiKV('🌐', 'Status global env', settings.enabled ? 'aktif' : 'mati'),
    uiKV('⏱️', 'Interval cek', `${settings.intervalMinutes} menit`),
    uiKV('📏', 'Threshold ML', `${settings.moneylineThreshold} cents`),
    uiKV('📏', 'Threshold total', `${settings.totalThreshold} runs`),
    uiKV('🔑', 'Odds API', settings.hasOddsApiKey ? 'tersedia' : 'belum diisi')
  ];

  if (stoppedCount !== null) {
    lines.push(uiKV('🛑', 'Monitor dihentikan', stoppedCount));
  }

  lines.push('', uiSection('📋', 'Command'), uiCommand('/linealerts on', 'aktif'), uiCommand('/linealerts off', 'mati'), uiCommand('/linealerts status', 'status'));
  return lines.join('\n');
}

async function handleLineAlertsCommand(bot, chat, args) {
  const chatId = chat.id;
  const action = String(args[0] || 'status').toLowerCase();

  if (action === 'help') {
    await bot.sendMessage(chatId, lineAlertsHelpText());
    return;
  }

  if (action === 'status') {
    await bot.sendMessage(chatId, formatLineAlertsStatus(chatId));
    return;
  }

  if (action === 'on') {
    storage.setLineMovementAlerts(chat, { enabled: true });
    await bot.sendMessage(chatId, formatLineAlertsStatus(chatId));
    return;
  }

  if (action === 'off') {
    storage.setLineMovementAlerts(chat, { enabled: false });
    const stoppedCount = stopLineMonitorForChat(chatId);
    await bot.sendMessage(chatId, formatLineAlertsStatus(chatId, stoppedCount));
    return;
  }

  await bot.sendMessage(chatId, lineAlertsHelpText());
}

async function askAgent(bot, chatId, question, dateYmd = dateInTimezone(config.timezone)) {
  if (!question.trim()) {
    await bot.sendMessage(
      chatId,
      [
        uiTitle('💬', 'Ask Analyst Agent | help'),
        '',
        uiKV('⌨️', 'Format', '/ask pertanyaan'),
        '',
        uiSection('💡', 'Contoh'),
        uiCommand('/ask best 5 top pick for today', 'top pick ringkas'),
        uiCommand('/ask game mana yang edge-nya paling kuat hari ini?', 'edge terkuat'),
        uiCommand('/ask kenapa Yankees dipilih?', 'alasan pick'),
        uiCommand('/ask upset risk terbesar hari ini?', 'risk upset')
      ].join('\n')
    );
    return;
  }

  await bot.sendMessage(chatId, uiKV('🤖', 'Analyst Agent membaca slate MLB', dateYmd));
  const predictions = await getMlbPredictions(dateYmd, config.modelMemory ? storage.getMemory() : {});
  await attachAgentAnalyses(predictions);
  await attachMarketContext(predictions);
  storage.savePredictions(dateYmd, predictions);

  const answer = await answerInteractiveQuestion(config, {
    question,
    dateYmd,
    predictions,
    memorySummary: storage.getMemorySummary()
  }).catch((error) => {
    console.error('Interactive Agent error:', error.message);
    return null;
  });

  await bot.sendMessage(
    chatId,
    answer ||
      uiBullet('⚠️', 'Agent belum bisa menjawab sekarang. Coba cek /today dulu atau pastikan OPENAI_API_KEY dan ANALYST_AGENT aktif.')
  );
  console.log(`Interactive question handled for ${chatId}.`);
}

async function evaluatePostGames(dateYmd, { markProcessed = true, includeProcessed = false } = {}) {
  const results = await getFinalGameResults(dateYmd);
  const evaluations = [];

  for (const result of results) {
    const prediction = storage.getPrediction(result.gamePk);
    if (!prediction) continue;
    if (prediction.postGameProcessed && markProcessed && !includeProcessed) continue;

    const correct = prediction.pick.id === result.winner.id;
    const learned = markProcessed && !prediction.postGameProcessed;

    evaluations.push({
      prediction,
      result,
      correct,
      learned
    });

    if (learned) {
      storage.recordOutcome(prediction, result, { enabled: config.modelMemory });
    }
  }

  return evaluations;
}

function formatPostGameRecap(dateYmd, evaluations) {
  if (evaluations.length === 0) {
    return [
      uiTitle('🏁', 'MLB Post-game Recap'),
      uiKV('📅', 'Tanggal', dateYmd),
      '',
      uiBullet('⚠️', 'Belum ada game final dengan pick pre-game yang tersimpan.'),
      uiBullet('📌', 'Pastikan /today, /deep, atau auto-alert sudah jalan sebelum game dimulai.')
    ].join('\n');
  }

  const correctCount = evaluations.filter((item) => item.correct).length;
  const separator = UI_LINE;
  const lines = [
    uiTitle('🏁', 'MLB Post-game Recap'),
    uiKV('📅', 'Tanggal', dateYmd),
    uiKV('🎯', 'Akurasi pick', `${correctCount}/${evaluations.length}`),
    '',
    separator
  ];

  for (const item of evaluations) {
    const { prediction, result, correct, learned } = item;
    const scoreLine = `${result.away.abbreviation || result.away.name} ${result.away.score} - ${result.home.score} ${result.home.abbreviation || result.home.name}`;
    const firstInningActual =
      result.firstInning?.anyRun === null ? 'unavailable' : result.firstInning.anyRun ? 'YES' : 'NO';
    const firstInningCorrect =
      prediction.firstInning && result.firstInning?.anyRun !== null
        ? prediction.firstInning.pick === firstInningActual
        : null;
    const memoryLine = learned
      ? correct
        ? 'Memory: pick benar; matchup pattern disimpan sebagai sinyal kecil.'
        : `Memory: pick salah disimpan; matchup pattern mencatat ${result.winner.abbreviation || result.winner.name} menang tanpa auto-bias berlebihan.`
      : 'Memory: game ini sudah pernah diproses.';

    lines.push(
      [
        uiKV('🏟️', 'Matchup', prediction.matchup),
        uiKV('📍', 'Final', scoreLine),
        uiKV('🏆', 'Winner', result.winner.name),
        uiKV('🎯', 'Pick', `${prediction.pick.name} | ${prediction.pick.winProbability}%`),
        uiBullet(correct ? '✅' : '❌', correct ? 'Benar' : 'Salah'),
        prediction.firstInning
          ? uiKV('🏁', '1st inning', `pick ${prediction.firstInning.pick} | ${prediction.firstInning.probability}% | actual ${firstInningActual}${firstInningCorrect === null ? '' : firstInningCorrect ? ' ✅' : ' ❌'}`)
          : null,
        uiBullet('🧠', memoryLine)
      ].filter(Boolean).join('\n')
    );
    lines.push(separator);
  }

  lines.push(uiBullet('⚠️', 'Memory adalah adjustment kecil, bukan jaminan hasil berikutnya.'));
  return lines.join('\n\n');
}

async function handleMessage(bot, message) {
  const chat = message.chat;
  const chatId = chat.id;
  const text = message.text?.trim() || '';
  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand?.replace(/@.+$/, '').toLowerCase();

  if (command === '/chatid') {
    await bot.sendMessage(chatId, uiKV('💬', 'Chat ID', chatId));
    return;
  }

  if (!isAllowed(chatId)) {
    await bot.sendMessage(chatId, uiBullet('⛔', 'Chat ini belum diizinkan. Tambahkan ID ini ke ALLOWED_CHAT_IDS.'));
    return;
  }

  if (command === '/start' || command === '/help') {
    await bot.sendMessage(chatId, helpText());
    return;
  }

  if (command === '/subscribe') {
    storage.addSubscriber(chat, {
      autoUpdate: {
        enabled: true,
        dailyTime: storage.getAutoUpdate(chatId).dailyTime || config.dailyAlertTime
      }
    });
    await bot.sendMessage(chatId, formatAutoUpdateStatus(chatId));
    return;
  }

  if (command === '/unsubscribe') {
    storage.removeSubscriber(chatId);
    await bot.sendMessage(chatId, uiBullet('🛑', 'Auto-alert dimatikan untuk chat ini.'));
    return;
  }

  if (command === '/today') {
    const maybeDate = args[0];
    const dateYmd = isValidDateYmd(maybeDate) ? maybeDate : dateInTimezone(config.timezone);
    await sendAlert(bot, chatId, dateYmd, { includeAdvanced: false });
    return;
  }

  if (command === '/deep') {
    const maybeDate = args[0];
    const dateYmd = isValidDateYmd(maybeDate) ? maybeDate : dateInTimezone(config.timezone);
    await sendAlert(bot, chatId, dateYmd, { includeAdvanced: true, maxGames: Number.MAX_SAFE_INTEGER });
    return;
  }

  if (command === '/date') {
    const dateYmd = args[0];
    if (!isValidDateYmd(dateYmd)) {
      await bot.sendMessage(chatId, uiKV('⌨️', 'Format', '/date YYYY-MM-DD'));
      return;
    }

    await sendAlert(bot, chatId, dateYmd);
    return;
  }

  if (command === '/game') {
    const teamFilter = args.join(' ').trim();
    if (!teamFilter) {
      await bot.sendMessage(chatId, uiKV('⌨️', 'Format', '/game Yankees atau /game LAD'));
      return;
    }

    await sendAlert(bot, chatId, dateInTimezone(config.timezone), { teamFilter, includeAdvanced: true });
    return;
  }

  if (command === '/predict') {
    await sendPythonPrediction(bot, chatId, text);
    return;
  }

  if (command === '/agenttools' || command === '/tools') {
    await sendAgentToolsMenu(bot, chatId);
    return;
  }

  if (command === '/kb' || command === '/knowledge') {
    const query = args.join(' ').trim();
    if (!query) {
      await bot.sendMessage(chatId, uiTitle('📚', 'Pilih Topik | knowledge'), {
        reply_markup: agentKnowledgeKeyboard()
      });
      return;
    }
    await sendKnowledgeAnswer(bot, chatId, query);
    return;
  }

  if (command === '/ask') {
    await askAgent(bot, chatId, args.join(' '));
    return;
  }

  if (command === '/autoupdate') {
    await handleAutoUpdateCommand(bot, chat, args);
    return;
  }

  if (command === '/sendalert') {
    const dateYmd = dateInTimezone(config.timezone);
    const sent = await sendAlertToAll(bot, dateYmd);
    await bot.sendMessage(chatId, sent > 0 ? uiKV('📤', 'Alert terkirim', `${sent} chat`) : uiBullet('⚠️', 'Belum ada subscriber/chat id target.'));
    return;
  }

  if (command === '/linecheck') {
    await handleLineCheckCommand(bot, chatId);
    return;
  }

  if (command === '/linealerts' || command === '/linemove') {
    await handleLineAlertsCommand(bot, chat, args);
    return;
  }

  if (command === '/evolve' || command === '/evolution') {
    await handleEvolutionCommand(bot, chatId, args);
    return;
  }

  if (command === '/audit') {
    await handleAuditCommand(bot, chatId);
    return;
  }

  if (command === '/postgame') {
    const maybeDate = args[0];
    const dateYmd = isValidDateYmd(maybeDate) ? maybeDate : dateInTimezone(config.timezone);
    await bot.sendMessage(chatId, uiKV('⏳', 'Mengecek final game MLB', dateYmd));
    const evaluations = await evaluatePostGames(dateYmd, {
      markProcessed: true,
      includeProcessed: true
    });
    await bot.sendMessage(chatId, formatPostGameRecap(dateYmd, evaluations));
    return;
  }

  if (command === '/memory') {
    await bot.sendMessage(chatId, formatMemorySummary());
    return;
  }

  if (command === '/agent') {
    await bot.sendMessage(chatId, formatAgentStatus());
    return;
  }

  if (command === '/skill') {
    await bot.sendMessage(chatId, buildAnalystSkillSummary());
    return;
  }

  if (text && !text.startsWith('/') && config.interactiveAgent) {
    await askAgent(bot, chatId, text);
    return;
  }

  await bot.sendMessage(chatId, helpText());
}

async function handleCallbackQuery(bot, callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  if (!chatId) return;

  if (!isAllowed(chatId)) {
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: 'Chat ini belum diizinkan.',
      show_alert: true
    });
    return;
  }

  const data = callbackQuery.data || '';
  if (data.startsWith(PREDICT_CALLBACK_PREFIX)) {
    await handlePredictCallback(bot, callbackQuery);
    return;
  }

  if (data.startsWith(AGENT_TOOL_CALLBACK_PREFIX)) {
    await handleAgentToolCallback(bot, callbackQuery);
    return;
  }

  if (data.startsWith(LEGACY_PREDICT_CALLBACK_PREFIX)) {
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: 'Tombol ini dari menu lama. Kirim /predict lagi untuk live schedule.',
      show_alert: true
    });
    return;
  }

  await bot.answerCallbackQuery(callbackQuery.id, {
    text: 'Aksi tombol tidak dikenal.',
    show_alert: false
  });
}

async function processTelegramUpdate(bot, update) {
  if (update.update_id !== undefined) {
    storage.setLastUpdateId(update.update_id);
  }

  if (update.message) {
    await handleMessage(bot, update.message).catch(async (error) => {
      console.error(error);
      await bot.sendMessage(update.message.chat.id, uiKV('⚠️', 'Error', error.message)).catch(() => {});
    });
  }

  if (update.callback_query) {
    await handleCallbackQuery(bot, update.callback_query).catch(async (error) => {
      console.error(error);
      const chatId = update.callback_query.message?.chat?.id;
      if (chatId) {
        await bot.sendMessage(chatId, uiKV('⚠️', 'Error', error.message)).catch(() => {});
      }
    });
  }
}

async function poll(bot) {
  let offset = storage.getLastUpdateId() ? storage.getLastUpdateId() + 1 : undefined;
  console.log('Telegram bot polling aktif.');

  while (true) {
    try {
      const updates = await bot.getUpdates({ offset, timeout: 30 });
      for (const update of updates) {
        offset = update.update_id + 1;
        await processTelegramUpdate(bot, update);
      }
    } catch (error) {
      console.error('Polling error:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

async function startWebhookMode(bot) {
  const webhook = await setupWebhook(bot, {
    webhookUrl: config.telegramWebhook.url,
    port: config.telegramWebhook.port,
    secret: config.telegramWebhook.secret,
    onUpdate: (update) => processTelegramUpdate(bot, update)
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} diterima. Menghapus Telegram webhook dan menutup server...`);
    await webhook.close({ deleteWebhook: true });
    process.exit(0);
  };

  process.once('SIGTERM', () => {
    shutdown('SIGTERM').catch((error) => {
      console.error('Graceful shutdown gagal:', error.message);
      process.exit(1);
    });
  });
  process.once('SIGINT', () => {
    shutdown('SIGINT').catch((error) => {
      console.error('Graceful shutdown gagal:', error.message);
      process.exit(1);
    });
  });

  await new Promise(() => {});
}

async function processPendingPostGames(bot) {
  if (postGameCheckRunning) return;
  if (targetChatIds().length === 0) return;

  postGameCheckRunning = true;
  try {
    for (const dateYmd of storage.listPendingPredictionDates()) {
      const evaluations = await evaluatePostGames(dateYmd, { markProcessed: true });
      if (evaluations.length === 0) continue;

      const text = formatPostGameRecap(dateYmd, evaluations);
      const sent = await sendTextToAll(bot, text);
      console.log(`Post-game recap ${dateYmd} terkirim ke ${sent} chat.`);
    }
  } finally {
    postGameCheckRunning = false;
  }
}

async function processAutoUpdates(bot) {
  if (autoUpdateCheckRunning) return;

  const today = dateInTimezone(config.timezone);
  const now = timeInTimezone(config.timezone);
  const targets = targetAutoUpdateChats().filter(
    (target) => now >= target.dailyTime && target.lastSentDate !== today
  );

  if (targets.length === 0) return;

  autoUpdateCheckRunning = true;
  try {
    const { text, predictions } = await buildAlertPayload(today);
    for (const target of targets) {
      await bot
        .sendMessage(target.chatId, text)
        .then(() => {
          maybeStartLineMonitor(predictions, target.chatId, today);
          if (target.legacyEnv) {
            storage.setLastAutoAlertDate(today);
          } else {
            storage.setAutoUpdateLastSent(target.chatId, today);
          }
          console.log(`Auto-update ${today} terkirim ke ${target.chatId}.`);
        })
        .catch((error) => {
          console.error(`Gagal auto-update ke ${target.chatId}:`, error.message);
        });
    }
  } finally {
    autoUpdateCheckRunning = false;
  }
}

function startScheduler(bot) {
  processAutoUpdates(bot).catch((error) => {
    console.error('Auto-update check error:', error.message);
  });

  setInterval(() => {
    processAutoUpdates(bot).catch((error) => {
      console.error('Auto-update check error:', error.message);
    });
  }, 60_000);

  if (config.postGameAlerts) {
    processPendingPostGames(bot).catch((error) => {
      console.error('Post-game check error:', error.message);
    });

    setInterval(() => {
      processPendingPostGames(bot).catch((error) => {
        console.error('Post-game check error:', error.message);
      });
    }, Math.max(1, config.postGamePollMinutes) * 60_000);
  }
}

async function runOnce() {
  const dateYmd = dateInTimezone(config.timezone);
  const text = await buildAlert(dateYmd);

  if (config.telegramToken && config.telegramChatId) {
    const bot = new TelegramBot(config.telegramToken);
    await bot.sendMessage(config.telegramChatId, text);
    console.log(`Alert ${dateYmd} terkirim ke ${config.telegramChatId}.`);
  } else if (config.printAlertToTerminal) {
    console.log(text);
  } else {
    console.log(
      `Alert ${dateYmd} dibuat, tapi TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID belum lengkap. Terminal output hanya log.`
    );
  }
}

async function main() {
  if (process.argv.includes('--once')) {
    await runOnce();
    return;
  }

  await startDashboard({ enabled: config.dashboard.enabled }).catch((error) => {
    console.error(`Dashboard tidak bisa start: ${error.message}`);
  });

  const bot = new TelegramBot(config.telegramToken);
  await bot.setMyCommands(botCommandList()).catch((error) => {
    console.warn(`setMyCommands gagal/diabaikan: ${error.message}`);
  });
  configureLineMonitor({ bot, storage, config });
  startScheduler(bot);

  if (config.telegramWebhook.enabled) {
    await startWebhookMode(bot);
    return;
  }

  await bot.deleteWebhook({ drop_pending_updates: false }).catch((error) => {
    console.warn(`deleteWebhook fallback polling gagal/diabaikan: ${error.message}`);
  });
  await poll(bot);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
