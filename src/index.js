import { loadConfig } from './config.js';
import { ANALYST_SKILL_VERSION, buildAnalystSkillSummary } from './analystSkill.js';
import {
  analyzePredictionsWithAgent,
  answerInteractiveQuestion,
  summarizeDailyAlertWithOpenAI
} from './llm.js';
import { formatPredictions, getFinalGameResults, getMlbPredictions } from './mlb.js';
import { Storage } from './storage.js';
import { TelegramBot } from './telegram.js';
import { dateInTimezone, isValidDateYmd, timeInTimezone } from './utils.js';

const config = loadConfig();
const storage = new Storage();
let postGameCheckRunning = false;

function helpText() {
  return [
    'MLB Alert Bot siap.',
    '',
    'Command:',
    '/today - alert hari ini',
    '/deep - alert hari ini dengan advanced stats',
    '/date YYYY-MM-DD - alert tanggal tertentu',
    '/game TEAM - cek tim tertentu hari ini',
    '/ask pertanyaan - tanya Analyst Agent',
    'Atau kirim pertanyaan biasa tanpa slash.',
    '/agent - lihat status Analyst Agent',
    '/skill - lihat playbook analisa Agent',
    '/postgame YYYY-MM-DD - cek recap final dan update memory',
    '/memory - lihat performa memory model',
    '/subscribe - aktifkan auto-alert di chat ini',
    '/unsubscribe - matikan auto-alert',
    '/sendalert - kirim alert hari ini ke subscriber',
    '/chatid - lihat chat id'
  ].join('\n');
}

function isAllowed(chatId) {
  if (config.allowedChatIds.length === 0) return true;
  return config.allowedChatIds.includes(String(chatId));
}

async function buildAlert(dateYmd, options = {}) {
  const modelMemory = config.modelMemory ? storage.getMemory() : {};
  const predictions = await getMlbPredictions(dateYmd, modelMemory);
  const includeAdvanced = options.includeAdvanced ?? config.alertDetail === 'full';

  await attachAgentAnalyses(predictions);
  storage.savePredictions(dateYmd, predictions);

  if (!options.teamFilter && !includeAdvanced && !config.analystAgent.enabled) {
    const llmText = await summarizeDailyAlertWithOpenAI(config, predictions).catch(() => null);
    if (llmText) return llmText;
  }

  return formatPredictions(dateYmd, predictions, {
    maxGames: config.maxGamesPerMessage,
    teamFilter: options.teamFilter || '',
    includeAdvanced
  });
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

async function sendTextToAll(bot, text) {
  const chatIds = targetChatIds();
  for (const chatId of chatIds) {
    await bot.sendMessage(chatId, text).catch((error) => {
      console.error(`Gagal kirim ke ${chatId}:`, error.message);
    });
  }

  return chatIds.length;
}

async function sendAlert(bot, chatId, dateYmd, options = {}) {
  await bot.sendMessage(chatId, `Mengambil data MLB ${dateYmd}...`);
  const text = await buildAlert(dateYmd, options);
  await bot.sendMessage(chatId, text);
  console.log(`Alert ${dateYmd} sent to ${chatId}.`);
}

async function sendAlertToAll(bot, dateYmd) {
  const chatIds = targetChatIds();

  if (chatIds.length === 0) {
    return 0;
  }

  const text = await buildAlert(dateYmd);
  for (const chatId of chatIds) {
    await bot.sendMessage(chatId, text).catch((error) => {
      console.error(`Gagal kirim ke ${chatId}:`, error.message);
    });
  }

  return chatIds.length;
}

function formatMemorySummary() {
  const summary = storage.getMemorySummary();
  const confidenceLines = Object.entries(summary.byConfidence || {})
    .map(([key, value]) => {
      const accuracy = value.total > 0 ? Math.round((value.correct / value.total) * 100) : 0;
      return `${key}: ${value.correct}/${value.total} (${accuracy}%)`;
    })
    .join('\n');

  return [
    '🧠 MLB Model Memory',
    '',
    `Total pick: ${summary.totalPicks}`,
    `Benar: ${summary.correctPicks}`,
    `Salah: ${summary.wrongPicks}`,
    `Akurasi: ${summary.accuracy}%`,
    '',
    'Confidence:',
    confidenceLines || 'Belum ada data confidence.',
    '',
    'First Inning:',
    `Total: ${summary.firstInning.totalPicks}`,
    `Benar: ${summary.firstInning.correctPicks}`,
    `Salah: ${summary.firstInning.wrongPicks}`,
    `Akurasi: ${summary.firstInning.accuracy}%`,
    `YES: ${summary.firstInning.byPick.YES.correct}/${summary.firstInning.byPick.YES.total}`,
    `NO: ${summary.firstInning.byPick.NO.correct}/${summary.firstInning.byPick.NO.total}`,
    '',
    'Recent learning:',
    summary.recentLog.length
      ? summary.recentLog.map((item) => `${item.correct ? '✅' : '❌'} ${item.note}`).join('\n')
      : 'Belum ada post-game learning.'
  ].join('\n');
}

function formatAgentStatus() {
  const summary = storage.getMemorySummary();

  return [
    '🤖 MLB Analyst Agent',
    '',
    `Status: ${config.analystAgent.enabled ? 'aktif' : 'mati'}`,
    `Mode: ${config.analystAgent.mode}`,
    `Skill: ${ANALYST_SKILL_VERSION}`,
    `Model: ${config.openai.model}`,
    `Memory: ${config.modelMemory ? 'aktif' : 'mati'}`,
    `Interactive chat: ${config.interactiveAgent ? 'aktif' : 'mati'}`,
    `Post-game learning: ${config.postGameAlerts ? 'aktif' : 'mati'}`,
    '',
    `Memory sample: ${summary.totalPicks} pick, akurasi ${summary.accuracy}%`,
    '',
    config.analystAgent.enabled
      ? 'Agent membuat pick final dari stats, H2H, baseline model, dan memory.'
      : 'Agent mati, bot memakai baseline model statistik.'
  ].join('\n');
}

async function askAgent(bot, chatId, question, dateYmd = dateInTimezone(config.timezone)) {
  if (!question.trim()) {
    await bot.sendMessage(
      chatId,
      [
        'Format: /ask pertanyaan',
        '',
        'Contoh:',
        '/ask game mana yang edge-nya paling kuat hari ini?',
        '/ask kenapa Yankees dipilih?',
        '/ask upset risk terbesar hari ini?'
      ].join('\n')
    );
    return;
  }

  await bot.sendMessage(chatId, `🤖 Analyst Agent membaca slate MLB ${dateYmd}...`);
  const predictions = await getMlbPredictions(dateYmd, config.modelMemory ? storage.getMemory() : {});
  await attachAgentAnalyses(predictions);
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
      'Agent belum bisa menjawab sekarang. Coba cek /today dulu atau pastikan OPENAI_API_KEY dan ANALYST_AGENT aktif.'
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
      '🏁 MLB Post-game Recap',
      `📅 ${dateYmd}`,
      '',
      'Belum ada game final dengan pick pre-game yang tersimpan.',
      'Pastikan /today, /deep, atau auto-alert sudah jalan sebelum game dimulai.'
    ].join('\n');
  }

  const correctCount = evaluations.filter((item) => item.correct).length;
  const separator = '━━━━━━━━━━━━━━━━━━━━';
  const lines = [
    '🏁 MLB Post-game Recap',
    `📅 ${dateYmd}`,
    `🎯 Akurasi pick: ${correctCount}/${evaluations.length}`,
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
        ? 'Memory: pick benar, confidence pattern diperkuat kecil.'
        : `Memory: pick salah disimpan; bias ${prediction.pick.abbreviation || prediction.pick.name} turun, ${result.winner.abbreviation || result.winner.name} naik.`
      : 'Memory: game ini sudah pernah diproses.';

    lines.push(
      [
        `🏟️ ${prediction.matchup}`,
        `📍 Final: ${scoreLine}`,
        `🏆 Winner: ${result.winner.name}`,
        `🎯 Pick: ${prediction.pick.name} (${prediction.pick.winProbability}%)`,
        `${correct ? '✅ Benar' : '❌ Salah'}`,
        prediction.firstInning
          ? `🏁 1st inning: pick ${prediction.firstInning.pick} (${prediction.firstInning.probability}%), actual ${firstInningActual}${firstInningCorrect === null ? '' : firstInningCorrect ? ' ✅' : ' ❌'}`
          : null,
        `🧠 ${memoryLine}`
      ].filter(Boolean).join('\n')
    );
    lines.push(separator);
  }

  lines.push('⚠️ Memory adalah adjustment kecil, bukan jaminan hasil berikutnya.');
  return lines.join('\n\n');
}

async function handleMessage(bot, message) {
  const chat = message.chat;
  const chatId = chat.id;
  const text = message.text?.trim() || '';
  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand?.replace(/@.+$/, '').toLowerCase();

  if (command === '/chatid') {
    await bot.sendMessage(chatId, `Chat ID: ${chatId}`);
    return;
  }

  if (!isAllowed(chatId)) {
    await bot.sendMessage(chatId, 'Chat ini belum diizinkan. Tambahkan ID ini ke ALLOWED_CHAT_IDS.');
    return;
  }

  if (command === '/start' || command === '/help') {
    await bot.sendMessage(chatId, helpText());
    return;
  }

  if (command === '/subscribe') {
    storage.addSubscriber(chat);
    await bot.sendMessage(chatId, 'Auto-alert aktif untuk chat ini.');
    return;
  }

  if (command === '/unsubscribe') {
    storage.removeSubscriber(chatId);
    await bot.sendMessage(chatId, 'Auto-alert dimatikan untuk chat ini.');
    return;
  }

  if (command === '/today') {
    const maybeDate = args[0];
    const dateYmd = isValidDateYmd(maybeDate) ? maybeDate : dateInTimezone(config.timezone);
    await sendAlert(bot, chatId, dateYmd);
    return;
  }

  if (command === '/deep') {
    const maybeDate = args[0];
    const dateYmd = isValidDateYmd(maybeDate) ? maybeDate : dateInTimezone(config.timezone);
    await sendAlert(bot, chatId, dateYmd, { includeAdvanced: true });
    return;
  }

  if (command === '/date') {
    const dateYmd = args[0];
    if (!isValidDateYmd(dateYmd)) {
      await bot.sendMessage(chatId, 'Format: /date YYYY-MM-DD');
      return;
    }

    await sendAlert(bot, chatId, dateYmd);
    return;
  }

  if (command === '/game') {
    const teamFilter = args.join(' ').trim();
    if (!teamFilter) {
      await bot.sendMessage(chatId, 'Format: /game Yankees atau /game LAD');
      return;
    }

    await sendAlert(bot, chatId, dateInTimezone(config.timezone), { teamFilter });
    return;
  }

  if (command === '/ask') {
    await askAgent(bot, chatId, args.join(' '));
    return;
  }

  if (command === '/sendalert') {
    const dateYmd = dateInTimezone(config.timezone);
    const sent = await sendAlertToAll(bot, dateYmd);
    await bot.sendMessage(chatId, sent > 0 ? `Alert terkirim ke ${sent} chat.` : 'Belum ada subscriber/chat id target.');
    return;
  }

  if (command === '/postgame') {
    const maybeDate = args[0];
    const dateYmd = isValidDateYmd(maybeDate) ? maybeDate : dateInTimezone(config.timezone);
    await bot.sendMessage(chatId, `Mengecek final game MLB ${dateYmd}...`);
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

async function poll(bot) {
  let offset = storage.getLastUpdateId() ? storage.getLastUpdateId() + 1 : undefined;
  console.log('Telegram bot polling aktif.');

  while (true) {
    try {
      const updates = await bot.getUpdates({ offset, timeout: 30 });
      for (const update of updates) {
        offset = update.update_id + 1;
        storage.setLastUpdateId(update.update_id);

        if (update.message) {
          await handleMessage(bot, update.message).catch(async (error) => {
            console.error(error);
            await bot.sendMessage(update.message.chat.id, `Error: ${error.message}`).catch(() => {});
          });
        }
      }
    } catch (error) {
      console.error('Polling error:', error.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
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

function startScheduler(bot) {
  if (config.autoAlerts) {
    setInterval(async () => {
      const today = dateInTimezone(config.timezone);
      const now = timeInTimezone(config.timezone);

      if (now >= config.dailyAlertTime && storage.getLastAutoAlertDate() !== today) {
        const sent = await sendAlertToAll(bot, today);
        if (sent > 0) {
          storage.setLastAutoAlertDate(today);
          console.log(`Auto-alert ${today} terkirim ke ${sent} chat.`);
        }
      }
    }, 60_000);
  }

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

  const bot = new TelegramBot(config.telegramToken);
  startScheduler(bot);
  await poll(bot);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
