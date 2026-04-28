import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { getMlbPredictions } from './mlb.js';
import { Storage } from './storage.js';
import { dateInTimezone } from './utils.js';

const config = loadConfig();
const storage = new Storage();
const port = Number.parseInt(process.env.DASHBOARD_PORT || '3008', 10);
const rootDir = resolve(process.cwd(), 'dashboard');
const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, statusCode, message, detail = '') {
  sendJson(response, statusCode, { error: message, detail });
}

function safeBoolean(value) {
  return Boolean(value && String(value).trim());
}

function parseBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 1024 * 128) {
        rejectBody(new Error('Request body too large'));
      }
    });
    request.on('end', () => {
      if (!body) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(body));
      } catch (error) {
        rejectBody(error);
      }
    });
  });
}

function runPython(args, { timeoutMs = 45000 } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(config.pythonExecutable, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PYTHONDONTWRITEBYTECODE: '1',
      },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      rejectRun(new Error('Python command timeout'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectRun(new Error((stderr || stdout || `Python exited with ${code}`).trim()));
        return;
      }
      resolveRun(stdout.trim());
    });
  });
}

async function runPythonJson(code, args = []) {
  const stdout = await runPython(['-c', code, ...args]);
  return JSON.parse(stdout || '{}');
}

async function sampleGames() {
  return runPythonJson(
    [
      'import json',
      'from src.agent_tools import get_today_games',
      'print(json.dumps({"games": get_today_games(use_live=False)}, default=str))',
    ].join('\n')
  );
}

async function sampleAnalysis(gameId) {
  return runPythonJson(
    [
      'import json, sys',
      'from src.agent_tools import get_game_context, predict_moneyline, predict_total_runs, explain_prediction',
      'gid = sys.argv[1]',
      'payload = {',
      '  "context": get_game_context(gid),',
      '  "moneyline": predict_moneyline(gid),',
      '  "totals": predict_total_runs(gid),',
      '  "full_text": explain_prediction(gid),',
      '}',
      'print(json.dumps(payload, default=str))',
    ].join('\n'),
    [String(gameId)]
  );
}

async function knowledgeAnswer(question) {
  return runPythonJson(
    [
      'import json, sys',
      'from src.knowledge.baseball_knowledge import answer_baseball_question',
      'question = " ".join(sys.argv[1:])',
      'print(json.dumps(answer_baseball_question(question), default=str))',
    ].join('\n'),
    [question]
  );
}

async function evaluationReport() {
  return runPythonJson(
    [
      'import json',
      'from src.evaluate import load_prediction_log, calculate_metrics, build_report, performance_by_confidence, performance_by_market_total',
      'rows = load_prediction_log()',
      'payload = {',
      '  "rows": rows,',
      '  "metrics": calculate_metrics(rows),',
      '  "by_confidence": performance_by_confidence(rows),',
      '  "by_market_total": performance_by_market_total(rows),',
      '  "report": build_report(rows),',
      '}',
      'print(json.dumps(payload, default=str))',
    ].join('\n')
  );
}

async function runBacktest(body) {
  const market = ['moneyline', 'totals'].includes(body.market) ? body.market : 'totals';
  const season = Number.isFinite(Number(body.season)) ? String(Number(body.season)) : '2025';
  const output = await runPython(['-m', 'src.backtest', '--season', season, '--market', market], {
    timeoutMs: 60000,
  });
  const evaluation = await evaluationReport();
  return { output, evaluation };
}

function liveQuality(prediction) {
  let score = 0;
  const awayStarter = prediction.away?.starterLine || '';
  const homeStarter = prediction.home?.starterLine || '';
  const awayLineup = prediction.lineups?.away;
  const homeLineup = prediction.lineups?.home;

  if (awayStarter && homeStarter && !awayStarter.includes('TBD') && !homeStarter.includes('TBD')) {
    score += 20;
  }
  if (awayLineup?.confirmed && homeLineup?.confirmed) {
    score += 15;
  } else if (awayLineup || homeLineup) {
    score += 7;
  }
  if (prediction.totalRuns?.detail && prediction.totalRuns.detail.weather !== undefined) score += 10;
  if (prediction.bullpen?.away && prediction.bullpen?.home) score += 15;
  if (prediction.totalRuns?.detail?.park) score += 10;
  if (prediction.totalRuns?.marketLine) score += 10;
  if (prediction.injuryDetailLines?.length || prediction.injuryLine) score += 5;

  return Math.min(100, score);
}

function summarizeLivePrediction(prediction) {
  const totalRuns = prediction.totalRuns || null;
  const pick = prediction.winner || prediction.home;
  const awayProbability = Math.round(prediction.away?.winProbability || 0);
  const homeProbability = Math.round(prediction.home?.winProbability || 0);

  return {
    game_id: String(prediction.gamePk),
    status: prediction.status,
    start: prediction.start,
    venue: prediction.venue,
    away_team: prediction.away?.name,
    home_team: prediction.home?.name,
    matchup: `${prediction.away?.name} @ ${prediction.home?.name}`,
    probabilities: {
      away: awayProbability,
      home: homeProbability,
    },
    pick: {
      name: pick?.name,
      probability: Math.max(awayProbability, homeProbability),
      confidence: prediction.agentAnalysis?.confidence || 'model',
    },
    starters: {
      away: prediction.away?.starterLine || 'TBD',
      home: prediction.home?.starterLine || 'TBD',
    },
    totalRuns: totalRuns
      ? {
          projectedTotal: totalRuns.projectedTotal,
          marketLine: totalRuns.marketLine,
          bestLean: totalRuns.bestLean,
          confidence: totalRuns.confidence,
          over: totalRuns.over,
          under: totalRuns.under,
          factors: totalRuns.factors || [],
        }
      : null,
    firstInning: prediction.firstInning
      ? {
          pick: prediction.firstInning.agent?.pick || prediction.firstInning.baselinePick,
          probability: Math.round(
            prediction.firstInning.agent?.probability ?? prediction.firstInning.baselineProbability ?? 0
          ),
        }
      : null,
    quality: {
      score: liveQuality(prediction),
      note: 'Live score uses available MLB context. Market odds freshness is only available through optional odds API.',
    },
    reasons: prediction.agentAnalysis?.reasons || prediction.reasons || [],
    risk: prediction.agentAnalysis?.risk || '',
  };
}

async function livePredictions(dateYmd) {
  const predictions = await getMlbPredictions(dateYmd, storage.getMemory());
  return {
    date: dateYmd,
    games: predictions.map(summarizeLivePrediction),
  };
}

function statusPayload() {
  const memory = storage.getMemorySummary();
  const state = storage.state;
  return {
    app: {
      name: packageJson.name,
      version: packageJson.version,
      dashboardPort: port,
      cwd: process.cwd(),
    },
    config: {
      timezone: config.timezone,
      telegramConfigured: safeBoolean(config.telegramToken),
      telegramChatConfigured: safeBoolean(config.telegramChatId),
      openaiConfigured: safeBoolean(config.openai.apiKey),
      openaiModel: config.openai.model,
      analystAgentEnabled: config.analystAgent.enabled,
      analystAgentMode: config.analystAgent.mode,
      autoAlerts: config.autoAlerts,
      dailyAlertTime: config.dailyAlertTime,
      postGameAlerts: config.postGameAlerts,
      modelMemory: config.modelMemory,
      pythonExecutable: config.pythonExecutable,
    },
    state: {
      subscriberCount: Object.keys(state.subscribers || {}).length,
      savedPredictionCount: Object.keys(state.predictions || {}).length,
      pendingPredictionDates: storage.listPendingPredictionDates(),
      lastAutoAlertDate: state.lastAutoAlertDate || '',
    },
    memory,
  };
}

async function routeApi(request, response, url) {
  try {
    if (url.pathname === '/api/status') {
      sendJson(response, 200, statusPayload());
      return true;
    }

    if (url.pathname === '/api/sample/games') {
      sendJson(response, 200, await sampleGames());
      return true;
    }

    if (url.pathname === '/api/sample/analysis') {
      const gameId = url.searchParams.get('id') || '0';
      sendJson(response, 200, await sampleAnalysis(gameId));
      return true;
    }

    if (url.pathname === '/api/live/predictions') {
      const dateYmd = url.searchParams.get('date') || dateInTimezone(config.timezone);
      sendJson(response, 200, await livePredictions(dateYmd));
      return true;
    }

    if (url.pathname === '/api/evaluation') {
      sendJson(response, 200, await evaluationReport());
      return true;
    }

    if (url.pathname === '/api/backtest' && request.method === 'POST') {
      sendJson(response, 200, await runBacktest(await parseBody(request)));
      return true;
    }

    if (url.pathname === '/api/knowledge') {
      const question = url.searchParams.get('q') || 'Why does FIP matter more than ERA for pitcher prediction?';
      sendJson(response, 200, await knowledgeAnswer(question));
      return true;
    }
  } catch (error) {
    sendError(response, 500, 'Dashboard API failed', error.message);
    return true;
  }

  return false;
}

function serveStatic(request, response, url) {
  const pathname = decodeURIComponent(url.pathname);
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = resolve(join(rootDir, relativePath));

  if (!filePath.startsWith(rootDir) || !existsSync(filePath)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const extension = extname(filePath);
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
  });
  createReadStream(filePath).pipe(response);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    const handled = await routeApi(request, response, url);
    if (!handled) sendError(response, 404, 'Unknown API route');
    return;
  }

  serveStatic(request, response, url);
});

server.listen(port, () => {
  const entry = fileURLToPath(import.meta.url);
  console.log(`MLB dashboard running at http://localhost:${port}`);
  console.log(`Server: ${entry}`);
});
