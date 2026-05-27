import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { ANALYST_SKILL_VERSION, buildAnalystSkillSummary } from './analystSkill.js';
import { buildEvolutionContext } from './evolutionContext.js';
import {
  analyzePredictionsWithAgent,
  answerInteractiveQuestion
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
  captureClosingLines,
  checkLineMovement,
  configureLineMonitor,
  lineMonitorSettings,
  startLineMonitor,
  stopLineMonitorForChat
} from './lineMovement.js';
import {
  configureLineupMonitor,
  lineupMonitorSettings,
  startLineupMonitor,
  stopLineupMonitorForChat
} from './lineupMonitor.js';

const config = loadConfig();
const storage = new Storage();
let postGameCheckRunning = false;
let autoUpdateCheckRunning = false;
const predictionCache = new Map();
const PREDICT_CALLBACK_PREFIX = 'predict_live:';
const LEGACY_PREDICT_CALLBACK_PREFIX = 'predict:';
const EVOLVE_CALLBACK_PREFIX = 'evolve:';
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
  status: 'status',
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
  args: ['--summary', '--apply-safe', '--update-memory'],
  label: 'Evolution audit + learning memory'
};
const AUDIT_LEARN_COMMAND = {
  module: 'src.evolution.evolution_engine',
  args: ['--ingest-bot-history'],
  label: 'Post-game learning ingest'
};

function helpText() {
  return [
    uiTitle('⚾', 'MLB Bot | command utama'),
    '',
    uiSection('📋', 'Shortcut analyst'),
    uiCommand('/picks', 'top 5 pick model hari ini'),
    uiCommand('/picks YYYY-MM-DD', 'top pick untuk tanggal tertentu'),
    uiCommand('/analyze', 'analisa edge, risk, value, dan no-bet slate hari ini'),
    uiCommand('/analyze TEAM', 'analisa tim/game tertentu dari data bot'),
    uiCommand('/news', 'ringkas injury, lineup, market, weather, dan data-quality risk'),
    '',
    uiSection('📊', 'Data & kontrol'),
    uiCommand('/today', 'list ringkas semua game hari ini'),
    uiCommand('/deep', 'semua game dengan statistik lengkap'),
    uiCommand('/game TEAM', 'cek tim tertentu hari ini'),
    uiCommand('/ask pertanyaan', 'tanya Analyst Agent bebas'),
    uiCommand('/audit', 'belajar dari hasil final + update guardrail'),
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
    { command: 'picks', description: 'Top model picks' },
    { command: 'analyze', description: 'Analisa slate atau tim' },
    { command: 'news', description: 'Risk/news context dari data bot' },
    { command: 'game', description: 'Cek tim tertentu hari ini' },
    { command: 'ask', description: 'Tanya Analyst Agent' },
    { command: 'audit', description: 'Audit + learning memory' },
    { command: 'linealerts', description: 'Atur line movement alerts' }
  ];
}

function parseDateArg(args) {
  const first = args[0];
  if (!isValidDateYmd(first)) {
    return { dateYmd: dateInTimezone(config.timezone), rest: args };
  }
  return { dateYmd: first, rest: args.slice(1) };
}

function buildPicksQuestion(args) {
  const { dateYmd } = parseDateArg(args);
  return { dateYmd, question: 'best 5 top pick for today' };
}

function buildAnalyzeQuestion(args) {
  const text = args.join(' ').trim();
  return text
    ? `Analisa ${text}. Fokus pada edge model, risiko utama, market value, dan no-bet warning dari data yang tersedia.`
    : 'Analisa slate MLB hari ini. Fokus pada edge terkuat, risiko terbesar, market value, dan game yang sebaiknya no bet.';
}

function buildNewsQuestion(args) {
  const { dateYmd, rest } = parseDateArg(args);
  const target = rest.join(' ').trim();
  const scope = target ? `untuk ${target}` : 'untuk slate MLB hari ini';
  return {
    dateYmd,
    question: `Ringkas risk/news context ${scope} dari data yang tersedia saja: lineup, injury, probable pitcher, weather/park, market movement, dan data-quality warning. Jangan mengarang headline atau berita live yang tidak ada di data.`
  };
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
  await attachMarketContext(predictions);
  await attachAgentAnalyses(predictions);
  storage.savePredictions(dateYmd, predictions);

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
  const evolutionData = buildEvolutionContext();
  const analyses = await analyzePredictionsWithAgent(
    config,
    predictions,
    storage.getMemorySummary(),
    evolutionData
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
  startLineupMonitor(predictions, chatId);
}

async function sendAlert(bot, chatId, dateYmd, options = {}) {
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
  return { menu: true };
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

function fetchKnowledgeContext(question) {
  return new Promise((resolve) => {
    const child = spawn(config.pythonExecutable, [
      '-c',
      'import json, sys; from src.knowledge.baseball_knowledge import BaseballKnowledgeBase; kb = BaseballKnowledgeBase(); print(json.dumps(kb.search(sys.argv[1], limit=3), default=str))',
      question
    ], {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      windowsHide: true
    });

    let stdout = '';
    const timer = setTimeout(() => { child.kill(); resolve(''); }, 8000);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { resolve(''); return; }
      try {
        const chunks = JSON.parse(stdout.trim() || '[]');
        const text = chunks
          .map((c) => `[${c.heading || c.source || 'MLB'}] ${c.text || c.content || ''}`.slice(0, 500))
          .join('\n\n');
        resolve(text);
      } catch {
        resolve('');
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
  const pending = storage.listPendingPredictionDates();
  const pendingCount = pending.length;

  const nextSteps = [];
  if (pendingCount > 0) nextSteps.push(`/evolve run — ${pendingCount} tanggal belum dievaluasi`);
  if ((summary.candidates_proposed || 0) > (summary.candidates_approved || 0)) nextSteps.push('/evolve rules — ada candidate pending untuk review');
  if ((summary.lessons_generated || 0) > 0) nextSteps.push('/audit — apply guardrails dari lesson yang ada');
  if (nextSteps.length === 0) nextSteps.push('System idle — menunggu game final baru.');

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
    uiSection('💡', 'Next steps'),
    ...nextSteps.map((step) => uiBullet('👉', step)),
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

function formatAuditMemoryPattern(item) {
  return uiBullet('•', `${item.type || 'pattern'} | ${item.factor || 'general'} | ${item.count || 0}x`);
}

function formatEvolutionAudit(payload) {
  const summary = payload.summary || {};
  const postgame = payload.postgame || {};
  const learning = payload.learning_ingest || {};
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
  const memoryUpdate = payload.memory_update || {};
  const memoryPatterns = memoryUpdate.top_patterns || [];

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
    uiSection('🧠', 'Learning run'),
    uiKV('🏁', 'Post-game checked', postgame.dates_checked || 0),
    uiKV('📥', 'New final games learned', postgame.learned_games || 0),
    uiKV('📚', 'Evolution lessons added', learning.lessons || 0),
    uiKV('⚠️', 'Language losses added', learning.language_losses || 0),
    uiKV('🧭', 'Language gradients added', learning.language_gradients || 0),
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
    uiSection('🧠', 'Learning memory'),
    uiKV('📝', 'Wrong picks remembered', memoryUpdate.wrong_predictions || 0),
    uiKV('📌', 'Patterns stored', memoryUpdate.patterns_written || 0),
    ...(memoryPatterns.length ? memoryPatterns.map(formatAuditMemoryPattern) : [uiBullet('•', 'Belum ada pola kesalahan berulang yang disimpan.')]),
    '',
    uiBullet('🛡️', 'Memory dipakai sebagai caution/guardrail. Current data tetap menang dan NO BET protection tidak dihapus.')
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

function formatEvolutionLessons(payload) {
  const lessons = Array.isArray(payload.recent_lessons) ? payload.recent_lessons : Array.isArray(payload.lessons) ? payload.lessons : [];
  const total = payload.total_lessons ?? payload.lessons_count ?? lessons.length;
  const lines = [
    uiTitle('📚', 'Evolution Lessons'),
    uiKV('📊', 'Total lessons', total),
    ''
  ];

  if (lessons.length === 0) {
    lines.push(uiBullet('•', 'Belum ada lesson tersimpan. Jalankan /evolve run setelah ada game final.'));
    return lines.join('\n');
  }

  for (const lesson of lessons.slice(0, 5)) {
    const type = lesson.lesson_type || lesson.type || 'unknown';
    const game = lesson.game_id || lesson.gamePk || '-';
    const summary = lesson.summary || lesson.loss_summary || '-';
    const adjustment = lesson.suggested_adjustment || '';
    lines.push(uiKV('📝', type, `game ${game}`));
    lines.push(uiBullet('•', summary.slice(0, 140)));
    if (adjustment) lines.push(uiBullet('💡', adjustment.slice(0, 120)));
    lines.push('');
  }

  return lines.join('\n');
}

function formatEvolutionLoss(payload) {
  const losses = Array.isArray(payload.top_losses) ? payload.top_losses : Array.isArray(payload.losses) ? payload.losses : [];
  const total = payload.total_losses ?? payload.language_losses ?? losses.length;
  const lines = [
    uiTitle('⚠️', 'Language Losses'),
    uiKV('📊', 'Total losses', total),
    ''
  ];

  if (losses.length === 0) {
    lines.push(uiBullet('•', 'Belum ada language loss. Jalankan /evolve run setelah ada game final.'));
    return lines.join('\n');
  }

  for (const loss of losses.slice(0, 5)) {
    const type = loss.loss_type || loss.type || 'unknown';
    const factor = loss.affected_factor || loss.factor || '-';
    const severity = loss.severity || 'medium';
    const summary = loss.loss_summary || loss.summary || '';
    lines.push(uiKV('🔴', type, `${factor} | severity: ${severity}`));
    if (summary) lines.push(uiBullet('•', summary.slice(0, 140)));
    lines.push('');
  }

  return lines.join('\n');
}

function formatEvolutionGradient(payload) {
  const gradients = Array.isArray(payload.top_gradients) ? payload.top_gradients : Array.isArray(payload.gradients) ? payload.gradients : [];
  const total = payload.total_gradients ?? payload.language_gradients ?? gradients.length;
  const lines = [
    uiTitle('🧭', 'Language Gradients'),
    uiKV('📊', 'Total gradients', total),
    ''
  ];

  if (gradients.length === 0) {
    lines.push(uiBullet('•', 'Belum ada gradient. Jalankan /evolve run setelah ada game final.'));
    return lines.join('\n');
  }

  for (const grad of gradients.slice(0, 5)) {
    const direction = grad.direction || grad.gradient_direction || 'unknown';
    const factor = grad.target_factor || grad.affected_factor || '-';
    const change = grad.suggested_change || grad.update || '';
    lines.push(uiKV('🧭', direction, factor));
    if (change) lines.push(uiBullet('💡', change.slice(0, 140)));
    lines.push('');
  }

  return lines.join('\n');
}

function formatEvolutionPropose(payload) {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const total = payload.total_candidates ?? payload.candidates_count ?? candidates.length;
  const lines = [
    uiTitle('🧪', 'Symbolic Update Candidates'),
    uiKV('📊', 'Total candidates', total),
    ''
  ];

  if (candidates.length === 0) {
    lines.push(uiBullet('•', 'Belum ada candidate. Butuh lebih banyak lesson dan gradient.'));
    return lines.join('\n');
  }

  for (const c of candidates.slice(0, 5)) {
    const type = c.type || 'symbolic_update';
    const rule = c.rule || c.update || c.reason || '-';
    const score = c.priority_score || c.source_count || 0;
    lines.push(uiKV('🧪', type, `score ${score}`));
    lines.push(uiBullet('•', rule.slice(0, 140)));
    lines.push('');
  }

  return lines.join('\n');
}

function formatEvolutionRules(payload) {
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const total = payload.total_candidates ?? candidates.length;
  const lines = [
    uiTitle('📏', 'Rule Candidates'),
    uiKV('📊', 'Total candidates', total),
    ''
  ];

  if (candidates.length === 0) {
    lines.push(uiBullet('•', 'Belum ada rule candidate. Butuh minimal 5 lesson berulang.'));
    return lines.join('\n');
  }

  for (const c of candidates.slice(0, 5)) {
    const type = c.type || 'rule';
    const rule = c.rule || c.update || '-';
    const backtest = c.backtest_status || 'pending';
    const promotion = c.promotion_status || 'pending';
    lines.push(uiKV('📏', type, `backtest: ${backtest} | promotion: ${promotion}`));
    lines.push(uiBullet('•', rule.slice(0, 140)));
    lines.push('');
  }

  return lines.join('\n');
}

function formatEvolutionBacktest(payload) {
  const pending = payload.pending_candidates ?? 0;
  const status = payload.backtest_status || 'requires_metrics';
  const lines = [
    uiTitle('🧪', 'Backtest Status'),
    uiKV('📊', 'Pending candidates', pending),
    uiKV('🔄', 'Status', status),
    '',
    uiBullet('📌', 'Candidates membutuhkan before/after metrics sebelum bisa dipromosikan.'),
    uiBullet('💡', 'Jalankan backtest manual via dashboard atau /evolve promote setelah validasi.')
  ];

  return lines.join('\n');
}

function formatEvolutionPromote(payload) {
  const message = payload.message || 'Gunakan promotion_gate dengan validated metrics.';
  const lines = [
    uiTitle('✅', 'Promotion Gate'),
    '',
    uiBullet('📌', message),
    '',
    uiBullet('🛡️', 'Promotion hanya terjadi setelah backtest menunjukkan improvement.'),
    uiBullet('💡', 'Jalankan /audit untuk apply conservative guardrails tanpa promotion.')
  ];

  return lines.join('\n');
}

function formatEvolutionResult(action, payload) {
  if (action === 'run') return formatEvolutionCycleResult(payload);
  if (action === 'summary') return formatEvolutionSummary(payload);
  if (action === 'lessons') return formatEvolutionLessons(payload);
  if (action === 'loss') return formatEvolutionLoss(payload);
  if (action === 'gradient') return formatEvolutionGradient(payload);
  if (action === 'propose') return formatEvolutionPropose(payload);
  if (action === 'rules') return formatEvolutionRules(payload);
  if (action === 'backtest') return formatEvolutionBacktest(payload);
  if (action === 'promote') return formatEvolutionPromote(payload);
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

function evolutionKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'Run Cycle', callback_data: `${EVOLVE_CALLBACK_PREFIX}run` },
        { text: 'Summary', callback_data: `${EVOLVE_CALLBACK_PREFIX}summary` },
        { text: 'Lessons', callback_data: `${EVOLVE_CALLBACK_PREFIX}lessons` }
      ],
      [
        { text: 'Audit', callback_data: `${EVOLVE_CALLBACK_PREFIX}audit` },
        { text: 'Rules', callback_data: `${EVOLVE_CALLBACK_PREFIX}rules` },
        { text: 'Full Pipeline', callback_data: `${EVOLVE_CALLBACK_PREFIX}full` }
      ]
    ]
  };
}

function formatEvolutionStatus(payload) {
  const summary = payload.summary || {};
  const pending = storage.listPendingPredictionDates();
  const pendingCount = pending.length;
  const memorySummary = storage.getMemorySummary();

  const nextAction = pendingCount > 0
    ? `Ada ${pendingCount} tanggal dengan game belum dievaluasi. Jalankan /evolve run atau tap Run Cycle.`
    : summary.candidates_proposed > 0
      ? 'Ada candidate pending. Jalankan /audit untuk apply guardrails.'
      : 'System idle — menunggu game final baru.';

  return [
    uiTitle('🧠', 'Evolution Status'),
    '',
    uiKV('📊', 'Evaluated', summary.total_predictions_evaluated || 0),
    uiKV('📈', 'Bot accuracy', `${memorySummary.accuracy}% (${memorySummary.totalPicks} picks)`),
    uiKV('📚', 'Lessons', summary.lessons_generated || 0),
    uiKV('🧪', 'Candidates', summary.candidates_proposed || 0),
    uiKV('✅', 'Approved', summary.candidates_approved || 0),
    '',
    uiSection('🏷️', 'Active versions'),
    uiKV('📏', 'Rules', summary.current_rule_version || '-'),
    uiKV('⚖️', 'Weights', summary.current_weight_version || '-'),
    uiKV('💬', 'Prompt', summary.current_prompt_version || '-'),
    '',
    uiSection('📋', 'Pending'),
    uiKV('📅', 'Dates to evaluate', pendingCount),
    '',
    uiSection('💡', 'Next step'),
    uiBullet('👉', nextAction)
  ].join('\n');
}

async function handleEvolutionFull(bot, chatId) {
  await bot.sendMessage(chatId, uiKV('⏳', 'Menjalankan', 'Full evolution pipeline'));

  const postgame = await processStoredPostGamesForEvolution();
  const learnOutput = await runPythonModule(AUDIT_LEARN_COMMAND.module, AUDIT_LEARN_COMMAND.args, {
    timeoutMessage: 'Learning ingest timeout.',
    timeoutMs: 90_000
  }).catch((error) => JSON.stringify({ error: error.message }));
  const learningIngest = parseJsonOutput(learnOutput);

  const cycleOutput = await runPythonModule('src.evolution.evolution_engine', ['--run-cycle'], {
    timeoutMessage: 'Evolution cycle timeout.',
    timeoutMs: 90_000
  });
  const cycleResult = parseJsonOutput(cycleOutput);

  const auditOutput = await runPythonModule(AUDIT_COMMAND.module, AUDIT_COMMAND.args, {
    timeoutMessage: 'Audit timeout.',
    timeoutMs: 90_000
  });
  const auditResult = parseJsonOutput(auditOutput);

  const lines = [
    uiTitle('🧠', 'Full Evolution Pipeline | complete'),
    '',
    uiSection('🏁', 'Post-game'),
    uiKV('📅', 'Dates checked', postgame.dates_checked || 0),
    uiKV('🧠', 'Games learned', postgame.learned_games || 0),
    '',
    uiSection('📥', 'Ingest'),
    uiKV('📊', 'Evaluated', learningIngest.evaluated || 0),
    uiKV('♻️', 'Skipped', learningIngest.skipped_duplicates || 0),
    '',
    uiSection('🔄', 'Cycle'),
    uiKV('🧪', 'Symbolic candidates', cycleResult.symbolic_candidates || 0),
    uiKV('📏', 'Rule candidates', cycleResult.rule_candidates || 0),
    '',
    uiSection('🔎', 'Audit'),
    uiKV('📊', 'Evaluated', auditResult.summary?.evaluated || 0),
    uiKV('📈', 'Accuracy', `${auditResult.summary?.accuracy || 0}%`),
    uiKV('🔧', 'Rules applied', (auditResult.applied_updates?.rules_added || []).length),
    uiKV('⚖️', 'Weight updates', (auditResult.applied_updates?.weight_versions_added || []).length),
    '',
    uiBullet('🛡️', 'Pipeline selesai. Guardrails diterapkan jika memenuhi threshold.')
  ];

  await bot.sendMessage(chatId, lines.join('\n'));
}

async function handleEvolutionCommand(bot, chatId, args) {
  const requested = String(args[0] || 'status').toLowerCase();
  if (requested === 'help' || requested === 'menu') {
    await bot.sendMessage(chatId, evolutionHelpText());
    return;
  }

  if (requested === 'full' || requested === 'pipeline') {
    await handleEvolutionFull(bot, chatId);
    return;
  }

  if (requested === 'auto') {
    const toggle = String(args[1] || 'status').toLowerCase();
    const current = storage.getAutoEvolution?.() ?? false;
    if (toggle === 'on') {
      storage.setMeta('evolutionAuto', '1');
      await bot.sendMessage(chatId, uiKV('🟢', 'Evolution auto', 'aktif — cycle otomatis setelah post-game learning'));
    } else if (toggle === 'off') {
      storage.setMeta('evolutionAuto', '0');
      await bot.sendMessage(chatId, uiKV('🔴', 'Evolution auto', 'mati'));
    } else {
      const enabled = storage.getMeta('evolutionAuto', '0') === '1';
      await bot.sendMessage(chatId, [
        uiTitle('🔄', 'Evolution Auto'),
        uiKV('🟢', 'Status', enabled ? 'aktif' : 'mati'),
        '',
        uiCommand('/evolve auto on', 'aktifkan auto-evolution setelah post-game'),
        uiCommand('/evolve auto off', 'matikan auto-evolution')
      ].join('\n'));
    }
    return;
  }

  const action = EVOLUTION_COMMANDS[requested] ? requested : EVOLUTION_ALIASES[requested];

  if (action === 'status' || (!action && !requested)) {
    await bot.sendMessage(chatId, uiKV('⏳', 'Mengambil', 'Evolution status'));
    const output = await runPythonModule('src.evolution.evolution_report', ['--summary'], {
      timeoutMessage: 'Evolution status timeout.',
      timeoutMs: 30_000
    }).catch(() => '{}');
    const payload = parseJsonOutput(output);
    await bot.sendMessage(chatId, formatEvolutionStatus(payload), {
      reply_markup: evolutionKeyboard()
    });
    return;
  }

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
  await bot.sendMessage(chatId, uiKV('⏳', 'Menjalankan', 'Audit + learning memory'));
  const postgame = await processStoredPostGamesForEvolution();
  const learnOutput = await runPythonModule(AUDIT_LEARN_COMMAND.module, AUDIT_LEARN_COMMAND.args, {
    timeoutMessage: 'Learning ingest timeout. Audit tetap dilanjutkan.',
    timeoutMs: 90_000
  }).catch((error) => JSON.stringify({ error: error.message }));
  const learningIngest = parseJsonOutput(learnOutput);
  const output = await runPythonModule(AUDIT_COMMAND.module, AUDIT_COMMAND.args, {
    timeoutMessage: 'Audit command timeout. Coba lagi sebentar.',
    timeoutMs: 90_000
  });
  const payload = parseJsonOutput(output);
  payload.postgame = postgame;
  payload.learning_ingest = learningIngest;
  await bot.sendMessage(chatId, formatEvolutionAudit(payload));
}

async function sendKnowledgeAnswer(bot, chatId, query) {
  const payload = await runAgentBridge('knowledge', [query]);
  await bot.sendMessage(chatId, payload.text || uiBullet('⚠️', 'Knowledge tidak tersedia.'));
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
  await bot.sendMessage(
    chatId,
    uiKV('⏳', 'Mengambil semua game MLB', request.dateYmd || dateInTimezone(config.timezone))
  );
  await sendPredictionGameMenu(bot, chatId, request.dateYmd);
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
    uiKV('🧰', 'Tools', '/kb'),
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

const PREDICTION_CACHE_TTL_MS = 30 * 60 * 1000;

function isKnowledgeOnlyQuestion(question) {
  const text = String(question || '').toLowerCase();
  const knowledgePatterns = [
    /\b(apa itu|what is|define|definisi|artinya|meaning of)\b/,
    /\b(wrc\+|woba|xwoba|fip|xfip|siera|babip|ops|iso|whip|era|war)\b/,
    /\b(moneyline|run line|over.?under|implied probability|clv|closing line)\b/,
    /\b(sabermetric|sabermetrik|statistik|metric|formula|rumus)\b/,
    /\b(park factor|pythagorean|log5|expected|xba|xslg|barrel)\b/,
    /\b(bagaimana cara|how does|how to calculate|cara hitung)\b/,
    /\b(apa bedanya|difference between|beda|vs)\b.*\b(era|fip|ops|woba|whip)\b/
  ];
  return knowledgePatterns.some((pattern) => pattern.test(text));
}

function getCachedPredictions(chatId, dateYmd) {
  const key = `${chatId}:${dateYmd || 'today'}`;
  const cached = predictionCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > PREDICTION_CACHE_TTL_MS) {
    predictionCache.delete(key);
    return null;
  }
  return cached.predictions;
}

function setCachedPredictions(chatId, dateYmd, predictions) {
  const key = `${chatId}:${dateYmd || 'today'}`;
  predictionCache.set(key, { predictions, timestamp: Date.now() });
}

async function handleLineupAlertsCommand(bot, chat, args) {
  const chatId = chat.id;
  const action = String(args[0] || 'status').toLowerCase();

  if (action === 'on') {
    storage.setMeta(`lineupAlerts:${chatId}`, '1');
    await bot.sendMessage(chatId, uiKV('🟢', 'Lineup alerts', 'aktif — notifikasi saat lineup confirmed'));
    return;
  }

  if (action === 'off') {
    storage.setMeta(`lineupAlerts:${chatId}`, '0');
    const stopped = stopLineupMonitorForChat(chatId);
    await bot.sendMessage(chatId, [
      uiKV('🔴', 'Lineup alerts', 'mati'),
      stopped > 0 ? uiKV('🛑', 'Monitor dihentikan', stopped) : null
    ].filter(Boolean).join('\n'));
    return;
  }

  const enabled = storage.getMeta(`lineupAlerts:${chatId}`, '1') !== '0';
  const settings = lineupMonitorSettings();
  await bot.sendMessage(chatId, [
    uiTitle('📋', 'Lineup Monitor'),
    '',
    uiKV('🟢', 'Status', enabled ? 'aktif' : 'mati'),
    uiKV('⏱️', 'Interval cek', `${settings.intervalMinutes} menit`),
    '',
    uiSection('📋', 'Command'),
    uiCommand('/lineups on', 'aktifkan notifikasi lineup'),
    uiCommand('/lineups off', 'matikan notifikasi lineup'),
    '',
    uiBullet('💡', 'Bot akan kirim alert saat lineup resmi terdeteksi dari MLB StatsAPI (biasanya 1-3 jam sebelum game).')
  ].join('\n'));
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
        uiCommand('/ask apa itu wRC+?', 'sabermetrics'),
        uiCommand('/ask upset risk terbesar hari ini?', 'risk upset')
      ].join('\n')
    );
    return;
  }

  await bot.sendMessage(chatId, uiKV('🤖', 'Analyst Agent thinking...', dateYmd));
  storage.appendChatMessage(chatId, 'user', question);

  const knowledgeOnly = isKnowledgeOnlyQuestion(question);
  let predictions;

  if (knowledgeOnly) {
    predictions = getCachedPredictions(chatId, dateYmd) || [];
  } else {
    predictions = getCachedPredictions(chatId, dateYmd);
    if (!predictions) {
      predictions = await getMlbPredictions(dateYmd, config.modelMemory ? storage.getMemory() : {});
      predictions = predictions || [];
      await attachMarketContext(predictions);
      storage.savePredictions(dateYmd, predictions);
      setCachedPredictions(chatId, dateYmd, predictions);
    }
  }

  const [knowledgeContext] = await Promise.all([
    fetchKnowledgeContext(question)
  ]);

  const conversationHistory = storage.getChatHistory(chatId, 10);

  const answer = await answerInteractiveQuestion(config, {
    question,
    dateYmd,
    predictions,
    memorySummary: storage.getMemorySummary(),
    knowledgeContext,
    conversationHistory
  }).catch((error) => {
    console.error('Interactive Agent error:', error.message);
    return null;
  });

  const response = answer ||
    uiBullet('⚠️', 'Agent belum bisa menjawab sekarang. Coba cek /today dulu atau pastikan OPENAI_API_KEY dan ANALYST_AGENT aktif.');

  storage.appendChatMessage(chatId, 'assistant', response);
  await bot.sendMessage(chatId, response);
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

    let clv = null;
    const openingOdds = prediction.openingOdds;
    const closingHome = storage.getLineSnapshot(result.gamePk, 'closing_home');
    const closingAway = storage.getLineSnapshot(result.gamePk, 'closing_away');
    if (openingOdds && (closingHome || closingAway)) {
      const pickIsHome = String(prediction.pick.id) === String(prediction.home?.id);
      const openingLine = pickIsHome ? openingOdds.homeMoneyline : openingOdds.awayMoneyline;
      const closingLine = pickIsHome ? closingHome?.value : closingAway?.value;
      if (Number.isFinite(openingLine) && Number.isFinite(closingLine)) {
        clv = Math.round(openingLine - closingLine);
      }
    }

    evaluations.push({
      prediction,
      result,
      correct,
      learned,
      clv
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

  if (command === '/today' || command === '/deep') {
    const maybeDate = args[0];
    const dateYmd = isValidDateYmd(maybeDate) ? maybeDate : dateInTimezone(config.timezone);
    if (!acquireCommandLock(chatId, 'today')) return;
    try {
      const { text, predictions } = await buildAlertPayload(dateYmd, { includeAdvanced: false });
      const gameButtons = predictions.slice(0, 12).map((p) => [{
        text: `${p.away.abbreviation || p.away.name} @ ${p.home.abbreviation || p.home.name}`,
        callback_data: `${PREDICT_CALLBACK_PREFIX}${dateYmd}:${p.gamePk}`
      }]);
      await bot.sendMessage(chatId, text, {
        reply_markup: gameButtons.length ? { inline_keyboard: gameButtons } : undefined
      });
      maybeStartLineMonitor(predictions, chatId, dateYmd);
      console.log(`Alert ${dateYmd} sent to ${chatId}.`);
    } finally {
      releaseCommandLock(chatId, 'today');
    }
    return;
  }

  if (command === '/date') {
    const dateYmd = args[0];
    if (!isValidDateYmd(dateYmd)) {
      await bot.sendMessage(chatId, uiKV('⌨️', 'Format', '/date YYYY-MM-DD'));
      return;
    }

    if (!acquireCommandLock(chatId, 'date')) return;
    try {
      await sendAlert(bot, chatId, dateYmd);
    } finally {
      releaseCommandLock(chatId, 'date');
    }
    return;
  }

  if (command === '/game') {
    const teamFilter = args.join(' ').trim();
    if (!teamFilter) {
      await bot.sendMessage(chatId, uiKV('⌨️', 'Format', '/game Yankees atau /game LAD'));
      return;
    }

    if (!acquireCommandLock(chatId, 'game')) return;
    try {
      await sendAlert(bot, chatId, dateInTimezone(config.timezone), { teamFilter, includeAdvanced: true });
    } finally {
      releaseCommandLock(chatId, 'game');
    }
    return;
  }

  if (command === '/predict') {
    await sendPythonPrediction(bot, chatId, text);
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

  if (command === '/picks') {
    const { dateYmd, question } = buildPicksQuestion(args);
    if (!acquireCommandLock(chatId, 'picks')) return;
    try {
      await askAgent(bot, chatId, question, dateYmd);
    } finally {
      releaseCommandLock(chatId, 'picks');
    }
    return;
  }

  if (command === '/analyze') {
    if (!acquireCommandLock(chatId, 'analyze')) return;
    try {
      await askAgent(bot, chatId, buildAnalyzeQuestion(args));
    } finally {
      releaseCommandLock(chatId, 'analyze');
    }
    return;
  }

  if (command === '/news') {
    const { dateYmd, question } = buildNewsQuestion(args);
    if (!acquireCommandLock(chatId, 'news')) return;
    try {
      await askAgent(bot, chatId, question, dateYmd);
    } finally {
      releaseCommandLock(chatId, 'news');
    }
    return;
  }

  if (command === '/ask') {
    if (!acquireCommandLock(chatId, 'ask')) return;
    try {
      await askAgent(bot, chatId, args.join(' '));
    } finally {
      releaseCommandLock(chatId, 'ask');
    }
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

  if (command === '/lineups') {
    await handleLineupAlertsCommand(bot, chat, args);
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

  if (command === '/clear') {
    storage.clearChatHistory(chatId);
    await bot.sendMessage(chatId, uiBullet('🧹', 'Conversation history cleared. Mulai fresh.'));
    return;
  }

  if (text && !text.startsWith('/') && config.interactiveAgent) {
    await askAgent(bot, chatId, text);
    return;
  }

  await bot.sendMessage(chatId, helpText());
}

async function handleEvolveCallback(bot, callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  const data = callbackQuery.data || '';
  const action = data.slice(EVOLVE_CALLBACK_PREFIX.length);

  await bot.answerCallbackQuery(callbackQuery.id, { text: 'Processing...' }).catch(() => {});
  if (!chatId) return;

  if (action === 'audit') {
    await handleAuditCommand(bot, chatId);
    return;
  }

  if (action === 'full') {
    await handleEvolutionFull(bot, chatId);
    return;
  }

  await handleEvolutionCommand(bot, chatId, [action]);
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

  if (data.startsWith(EVOLVE_CALLBACK_PREFIX)) {
    await handleEvolveCallback(bot, callbackQuery);
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

const processedUpdateIds = new Set();
const commandLocks = new Map();

const COMMAND_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

function acquireCommandLock(chatId, command) {
  const key = `${chatId}:${command}`;
  const existing = commandLocks.get(key);
  if (existing) {
    // Release stale locks (TTL expired)
    if (Date.now() - existing > COMMAND_LOCK_TTL_MS) {
      commandLocks.delete(key);
    } else {
      return false;
    }
  }
  commandLocks.set(key, Date.now());
  return true;
}

function releaseCommandLock(chatId, command) {
  commandLocks.delete(`${chatId}:${command}`);
}

async function processTelegramUpdate(bot, update) {
  if (update.update_id !== undefined) {
    if (processedUpdateIds.has(update.update_id)) return;
    processedUpdateIds.add(update.update_id);
    if (processedUpdateIds.size > 500) {
      const ids = [...processedUpdateIds];
      for (const id of ids.slice(0, ids.length - 200)) processedUpdateIds.delete(id);
    }
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
  let newGamesLearned = 0;
  try {
    for (const dateYmd of storage.listPendingPredictionDates()) {
      const evaluations = await evaluatePostGames(dateYmd, { markProcessed: true });
      if (evaluations.length === 0) continue;

      newGamesLearned += evaluations.filter((evaluation) => evaluation.learned).length;
      const text = formatPostGameRecap(dateYmd, evaluations);
      const sent = await sendTextToAll(bot, text);
      console.log(`Post-game recap ${dateYmd} terkirim ke ${sent} chat.`);
    }

    if (newGamesLearned > 0) {
      try {
        console.log(`Post-game: ${newGamesLearned} new game(s) learned. Running evolution ingest...`);
        const ingestOutput = await runPythonModule('src.evolution.evolution_engine', ['--ingest-bot-history'], {
          timeoutMessage: 'Evolution ingest timeout (post-game). Skipped.',
          timeoutMs: 90_000
        });
        const ingestResult = parseJsonOutput(ingestOutput);
        if (ingestResult.evaluated > 0) {
          console.log(`Evolution ingest: ${ingestResult.evaluated} prediction(s) evaluated, ${ingestResult.language_losses || 0} loss(es) generated.`);
          try {
            await runPythonModule('src.evolution.evolution_audit', ['--update-memory'], {
              timeoutMessage: 'Audit memory update timeout (post-game). Skipped.',
              timeoutMs: 60_000
            });
            console.log('Audit memory updated after post-game learning.');
          } catch (auditError) {
            console.error('Audit memory update after post-game failed:', auditError.message);
          }

          if (storage.getMeta('evolutionAuto', '0') === '1') {
            try {
              console.log('Evolution auto enabled. Running full cycle...');
              await runPythonModule('src.evolution.evolution_engine', ['--run-cycle'], {
                timeoutMessage: 'Auto evolution cycle timeout. Skipped.',
                timeoutMs: 90_000
              });
              await runPythonModule('src.evolution.evolution_audit', ['--summary', '--apply-safe', '--update-memory'], {
                timeoutMessage: 'Auto audit timeout. Skipped.',
                timeoutMs: 90_000
              });
              console.log('Auto evolution cycle + audit completed.');
            } catch (autoError) {
              console.error('Auto evolution cycle failed:', autoError.message);
            }
          }
        }
      } catch (error) {
        console.error('Evolution ingest after post-game failed:', error.message);
      }
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

function formatWeeklyRecap(stats) {
  const lines = [
    uiTitle('📊', 'Weekly Performance Recap'),
    uiKV('📅', 'Periode', `${stats.startDate} — ${stats.endDate}`),
    '',
    uiKV('🎯', 'Total picks', stats.totalPicks),
    uiKV('✅', 'Benar', stats.correct),
    uiKV('❌', 'Salah', stats.wrong),
    uiKV('📈', 'Akurasi', `${stats.accuracy}%`),
    ''
  ];

  if (stats.bestPick) {
    lines.push(uiKV('🏆', 'Best pick', stats.bestPick));
  }
  if (stats.worstPick) {
    lines.push(uiKV('💔', 'Worst miss', stats.worstPick));
  }

  lines.push('');
  lines.push(uiSection('🎚️', 'By confidence'));
  for (const [level, data] of Object.entries(stats.byConfidence)) {
    if (data.total > 0) {
      lines.push(uiKV('•', level, `${data.correct}/${data.total} | ${Math.round((data.correct / data.total) * 100)}%`));
    }
  }

  lines.push('');
  lines.push(uiBullet('📌', 'Recap otomatis setiap minggu. Gunakan /memory untuk detail lengkap.'));
  return lines.join('\n');
}

function computeWeeklyStats() {
  const today = new Date();
  const dates = [];
  for (let i = 7; i >= 1; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  let totalPicks = 0;
  let correct = 0;
  let wrong = 0;
  const byConfidence = { high: { total: 0, correct: 0 }, medium: { total: 0, correct: 0 }, low: { total: 0, correct: 0 } };
  let bestPick = null;
  let worstPick = null;

  for (const dateYmd of dates) {
    const predictions = storage.listPredictionsByDate(dateYmd);
    for (const prediction of predictions) {
      if (!prediction.postGameProcessed) continue;
      totalPicks += 1;
      const log = (storage.state?.memory?.learningLog || []).find(
        (entry) => String(entry.gamePk) === String(prediction.gamePk)
      );
      if (!log) continue;

      if (log.correct) {
        correct += 1;
        if (!bestPick || (prediction.pick?.winProbability || 0) < (bestPick.prob || 100)) {
          bestPick = { label: `${prediction.matchup} — ${prediction.pick?.name}`, prob: prediction.pick?.winProbability };
        }
      } else {
        wrong += 1;
        if (!worstPick) {
          worstPick = `${prediction.matchup} — picked ${prediction.pick?.name}`;
        }
      }

      const conf = String(prediction.pick?.confidence || 'low').toLowerCase();
      if (byConfidence[conf]) {
        byConfidence[conf].total += 1;
        if (log.correct) byConfidence[conf].correct += 1;
      }
    }
  }

  return {
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    totalPicks,
    correct,
    wrong,
    accuracy: totalPicks > 0 ? Math.round((correct / totalPicks) * 100) : 0,
    bestPick: bestPick?.label || null,
    worstPick,
    byConfidence
  };
}

async function processWeeklyRecap(bot) {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const hour = Number(timeInTimezone(config.timezone).split(':')[0]);

  if (dayOfWeek !== 0 || hour < 9 || hour > 10) return;

  const lastRecapDate = storage.getMeta('lastWeeklyRecapDate', '');
  const today = dateInTimezone(config.timezone);
  if (lastRecapDate === today) return;

  const stats = computeWeeklyStats();
  if (stats.totalPicks === 0) return;

  const text = formatWeeklyRecap(stats);
  await sendTextToAll(bot, text);
  storage.setMeta('lastWeeklyRecapDate', today);
  console.log(`Weekly recap sent: ${stats.correct}/${stats.totalPicks} accuracy.`);
}

async function captureClosingLinesForUpcoming() {
  const dateYmd = dateInTimezone(config.timezone);
  const predictions = storage.listPredictionsByDate(dateYmd);
  if (!predictions.length) return;

  const now = Date.now();
  const soonGames = predictions.filter((p) => {
    if (storage.hasClosingLine(p.gamePk)) return false;
    const start = p.start || p.gameTime;
    if (!start) return false;
    const startMs = new Date(start).getTime();
    return Number.isFinite(startMs) && startMs - now <= 5 * 60_000 && startMs > now;
  });

  if (soonGames.length > 0) {
    const result = await captureClosingLines(soonGames);
    if (result.captured > 0) {
      console.log(`Closing lines captured for ${result.captured} game(s).`);
    }
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
    processWeeklyRecap(bot).catch((error) => {
      console.error('Weekly recap error:', error.message);
    });
    captureClosingLinesForUpcoming().catch((error) => {
      console.error('Closing line capture error:', error.message);
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
  configureLineupMonitor({ bot, storage, config });
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
