import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

import { parseUtcMs, toUtcIso } from './temporal_contract.js';

const NEWS_SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_STALE_IF_ERROR_MS = 12 * 60 * 60 * 1000;
const DEFAULT_MAX_ITEMS = 25;
const DEFAULT_MAX_ARTICLES_PER_GAME = 5;
const DEFAULT_MAX_TITLE_CHARS = 240;
const DEFAULT_MAX_SUMMARY_CHARS = 600;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_MAX_AGE_HOURS = 48;
const CLOCK_SKEW_MS = 2 * 60 * 1000;

let testFetch = null;

const XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: false,
  htmlEntities: false,
  isArray: (name) => ['item', 'entry', 'link', 'category', 'author'].includes(name)
};

function textValue(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value === 'object') return String(value['#text'] ?? value.text ?? value.value ?? '');
  return '';
}

function stripMarkup(value) {
  return textValue(value)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cap(value, maxChars) {
  return stripMarkup(value).slice(0, Math.max(0, Number(maxChars) || 0));
}

function canonicalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return '';
  }
}

function articleId(url, title, publishedAt) {
  const basis = canonicalUrl(url) || `${String(title || '').toLowerCase()}|${String(publishedAt || '')}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 24);
}

function feedItems(parsed) {
  const rssItems = parsed?.rss?.channel?.item;
  const atomItems = parsed?.feed?.entry;
  const items = rssItems || atomItems || [];
  return Array.isArray(items) ? items : items ? [items] : [];
}

function atomLink(item) {
  const links = Array.isArray(item?.link) ? item.link : item?.link ? [item.link] : [];
  const alternate = links.find((link) => !link?.['@_rel'] || link['@_rel'] === 'alternate');
  return alternate?.['@_href'] || textValue(alternate);
}

function categoryText(item) {
  const values = Array.isArray(item?.category) ? item.category : item?.category ? [item.category] : [];
  return values
    .map((value) => value?.['@_term'] || textValue(value))
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function contentTypeFor(item, source) {
  const hint = `${categoryText(item)} ${String(source?.contentType || '')}`.toLowerCase();
  if (/opinion/.test(hint)) return 'opinion';
  if (/analysis|analyst/.test(hint)) return 'analysis';
  return 'news';
}

function parseFeedXml(xml, source, options = {}) {
  const rawXml = String(xml || '');
  if (/<!DOCTYPE|<!ENTITY/i.test(rawXml)) throw new Error('feed document declarations not allowed');
  if (!/<(?:rss|feed)\b/i.test(rawXml)) throw new Error('unsupported feed document');
  const parser = new XMLParser(XML_OPTIONS);
  let parsed;
  try {
    parsed = parser.parse(rawXml);
  } catch (error) {
    throw new Error(`feed XML parse failed: ${error.message}`);
  }

  const maxItems = Number(options.maxItems || DEFAULT_MAX_ITEMS);
  return feedItems(parsed).slice(0, maxItems).map((item) => {
    const title = cap(item?.title, options.maxTitleChars || DEFAULT_MAX_TITLE_CHARS);
    const summary = cap(
      item?.description ?? item?.summary ?? item?.content,
      options.maxSummaryChars || DEFAULT_MAX_SUMMARY_CHARS
    );
    const linkValue = Array.isArray(item?.link) ? atomLink(item) : item?.link;
    const linkHref = linkValue?.['@_href'] || linkValue;
    const url = canonicalUrl(
      item?.link?.['@_href'] || linkHref || item?.guid?.['#text'] || item?.guid
    );
    const publishedAt = toUtcIso(
      item?.pubDate || item?.published || item?.updated || item?.['dc:date'] || item?.date
    );
    const availableAt = toUtcIso(item?.availableAt || item?.['dc:available'] || item?.['news:availableAt']);
    const author = cap(item?.author?.name ?? item?.author ?? item?.['dc:creator'], 120) || null;
    return {
      id: articleId(url, title, publishedAt),
      source: String(source?.source || 'unknown'),
      sourceName: String(source?.name || source?.source || 'Unknown'),
      contentType: contentTypeFor(item, source),
      title,
      summary,
      url,
      author,
      publishedAt,
      availableAt,
      categories: categoryText(item)
    };
  }).filter((item) => item.title && item.url);
}

function normalizedAllowedHosts(source = {}) {
  const sourceName = String(source.source || '').toLowerCase();
  const defaults = sourceName === 'mlb'
    ? ['mlb.com', 'mlbstatic.com']
    : sourceName === 'espn'
      ? ['espn.com']
      : sourceName === 'yahoo'
        ? ['yahoo.com', 'yahoo.net']
        : [];
  const configured = Array.isArray(source.allowedHosts) ? source.allowedHosts : [];
  return [...new Set([...defaults, ...configured].map((host) => String(host).toLowerCase().trim()).filter(Boolean))];
}

function hostAllowed(url, source = {}) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return normalizedAllowedHosts(source).some(
      (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`)
    );
  } catch {
    return false;
  }
}

function teamTokens(team) {
  const name = String(team?.name || '').toLowerCase().trim();
  const abbreviation = String(team?.abbreviation || '').toLowerCase().trim();
  const words = name.split(/\s+/).filter(Boolean);
  const nickname = words.at(-1) || '';
  const compoundNickname = nickname.length <= 3 ? words.slice(-2).join(' ') : '';
  return [...new Set([name, nickname, compoundNickname, abbreviation].filter(Boolean))];
}

function containsToken(text, token) {
  if (token.length > 3 && token.includes(' ')) return text.includes(token);
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, 'i').test(text);
}

function playerTokens(prediction) {
  const players = [prediction?.away?.starter, prediction?.home?.starter];
  const lineups = [prediction?.lineups?.away, prediction?.lineups?.home];
  for (const lineup of lineups) {
    for (const player of lineup?.players || lineup?.batters || []) players.push(player);
  }
  return players.flatMap((player) => {
    const name = String(player?.fullName || player?.name || '').toLowerCase().trim();
    return name ? [name] : [];
  });
}

function matchArticle(article, prediction) {
  const haystack = `${article.title} ${article.summary}`.toLowerCase();
  const awayTokens = teamTokens(prediction?.away);
  const homeTokens = teamTokens(prediction?.home);
  const awayMatch = awayTokens.some((token) => containsToken(haystack, token));
  const homeMatch = homeTokens.some((token) => containsToken(haystack, token));
  const players = playerTokens(prediction);
  const playerMatches = players.filter((token) => containsToken(haystack, token));
  if (!awayMatch && !homeMatch && playerMatches.length === 0) return null;
  return {
    teams: [awayMatch ? prediction.away.name : null, homeMatch ? prediction.home.name : null].filter(Boolean),
    players: playerMatches.slice(0, 5),
    matchReason: awayMatch || homeMatch ? 'team_alias' : 'player_name'
  };
}

function normalizeSourceArticle(article, source, prediction, now = new Date().toISOString(), options = {}) {
  const predictionTimestampUtc = predictionTimestampFor(prediction);
  const publishedMs = parseUtcMs(article.publishedAt);
  const availableMs = parseUtcMs(article.availableAt);
  const cutoffMs = parseUtcMs(predictionTimestampUtc);
  const firstPitchMs = parseUtcMs(prediction?.startTime);
  const effectiveMs = availableMs ?? publishedMs;
  if (effectiveMs != null && cutoffMs != null && effectiveMs - cutoffMs > CLOCK_SKEW_MS) return null;
  if (effectiveMs != null && firstPitchMs != null && effectiveMs - firstPitchMs > CLOCK_SKEW_MS) return null;
  const maxAgeHours = Number(options.maxAgeHours || DEFAULT_MAX_AGE_HOURS);
  if (publishedMs != null && cutoffMs != null && cutoffMs - publishedMs > maxAgeHours * 60 * 60 * 1000) return null;

  const match = matchArticle(article, prediction);
  if (!match) return null;
  const fetchedAt = toUtcIso(article.fetchedAt) || toUtcIso(now) || now;
  const observedAt = article.publishedAt || null;
  const availableAt = article.availableAt ? toUtcIso(article.availableAt) : null;
  const sourceStatus = String(source?.status || 'ok');
  return {
    id: article.id,
    source: article.source || source.source,
    sourceName: article.sourceName || source.name || source.source,
    contentType: article.contentType || 'news',
    title: cap(article.title, options.maxTitleChars || DEFAULT_MAX_TITLE_CHARS),
    summary: cap(article.summary, options.maxSummaryChars || DEFAULT_MAX_SUMMARY_CHARS),
    url: canonicalUrl(article.url),
    author: article.author || null,
    publishedAt: toUtcIso(article.publishedAt),
    observedAt,
    availableAt,
    fetchedAt,
    matchedEntities: match,
    quality: sourceStatus === 'stale' ? 'stale-feed' : 'feed-reported',
    stale: sourceStatus === 'stale',
    historicalValidity: availableAt && sourceStatus !== 'stale' ? 'verified' : 'historical_unverified',
    firstPitchUtc: toUtcIso(prediction?.startTime)
  };
}

function predictionTimestampFor(prediction) {
  return prediction?.predictionTimestampUtc || prediction?.asOfUtc || new Date().toISOString();
}

function parseFeedsConfig(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item === 'object' && item.url && item.source);
  } catch {
    return [];
  }
}

async function readResponseBody(response, maxBytes) {
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('feed response exceeds byte limit');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('feed response exceeds byte limit');
  return text;
}

async function fetchFeed(source, config, storage, nowMs = Date.now()) {
  const url = canonicalUrl(source.url);
  if (!url || !hostAllowed(url, source)) return { source: source.source, status: 'unavailable', error: 'feed host not allowed', articles: [] };

  const cached = storage?.getNewsFeedCache?.(url) || null;
  const cachedFetchedMs = parseUtcMs(cached?.fetchedAt);
  const ttlMs = Number(config.news?.cacheTtlMs || DEFAULT_CACHE_TTL_MS);
  if (cached?.payload && cachedFetchedMs != null && nowMs - cachedFetchedMs <= ttlMs) {
    return { source: source.source, sourceName: source.name || source.source, status: 'ok', articles: cached.payload, fetchedAt: cached.fetchedAt, cached: true };
  }

  const timeoutMs = Number(config.news?.timeoutMs || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetcher = testFetch || globalThis.fetch;
    const response = await fetcher(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', 'User-Agent': 'mlb-stats-bot/news' }
    });
    if (response?.status >= 300 && response?.status < 400) {
      const redirectUrl = response.headers?.get?.('location');
      if (!redirectUrl || !hostAllowed(new URL(redirectUrl, url).toString(), source)) {
        throw new Error('feed redirect host not allowed');
      }
      throw new Error('feed redirect requires explicit configured URL');
    }
    if (!response?.ok) throw new Error(`HTTP ${response?.status || 'error'}`);
    const responseType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    // Some valid feeds return text/html despite serving XML. Root-document
    // validation below remains authoritative; keep byte and parser limits.
    if (responseType && !/(xml|rss|atom|html|text\/plain)/.test(responseType)) {
      throw new Error(`unsupported feed content type: ${responseType}`);
    }
    const xml = await readResponseBody(response, Number(config.news?.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES));
    const articles = parseFeedXml(xml, source, config.news);
    const fetchedAt = new Date(nowMs).toISOString();
    for (const article of articles) article.fetchedAt = fetchedAt;
    storage?.setNewsFeedCache?.(url, articles, { source: source.source, fetchedAt, expiresAt: new Date(nowMs + ttlMs).toISOString(), lastError: null });
    return { source: source.source, sourceName: source.name || source.source, status: 'ok', articles, fetchedAt };
  } catch (error) {
    const staleMs = Number(config.news?.staleIfErrorMs || DEFAULT_STALE_IF_ERROR_MS);
    const age = cachedFetchedMs == null ? Infinity : nowMs - cachedFetchedMs;
    if (cached?.payload && age <= staleMs) {
      return { source: source.source, sourceName: source.name || source.source, status: 'stale', articles: cached.payload, fetchedAt: cached.fetchedAt, error: error.message };
    }
    storage?.setNewsFeedCache?.(url, cached?.payload || [], { source: source.source, fetchedAt: cached?.fetchedAt || null, expiresAt: null, lastError: error.message });
    return { source: source.source, sourceName: source.name || source.source, status: 'unavailable', articles: [], error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

function statusFromSources(sourceStatus, articleCount) {
  if (articleCount > 0 && sourceStatus.some((item) => item.status === 'stale' || item.status === 'unavailable')) return 'partial';
  if (articleCount > 0) return 'ok';
  if (sourceStatus.some((item) => item.status === 'stale')) return 'stale';
  return 'unavailable';
}

function provenanceForArticle(article) {
  return {
    value: {
      id: article.id,
      title: article.title,
      summary: article.summary,
      url: article.url,
      contentType: article.contentType,
      matchedEntities: article.matchedEntities
    },
    source: article.source,
    observedAt: article.observedAt,
    availableAt: article.availableAt,
    fetchedAt: article.fetchedAt,
    inferred: false,
    quality: article.quality,
    historicalValidity: article.historicalValidity
  };
}

export function persistNewsFeatureSnapshots(predictions, storage, dateYmd = '') {
  for (const prediction of predictions || []) {
    const pendingNews = prediction.pendingNewsFeatureSnapshot;
    if (!pendingNews || typeof pendingNews !== 'object') continue;
    storage?.setFeatureSnapshot?.(prediction.gamePk, 'news', dateYmd, pendingNews, {
      overwrite: false,
      timestamp: prediction.predictionTimestampUtc || new Date().toISOString()
    });
    const stored = storage?.getFeatureSnapshot?.(prediction.gamePk, 'news')?.payload || pendingNews;
    const existingDecisionSnapshot = storage?.getFeatureSnapshot?.(
      prediction.gamePk,
      'prediction_decision_snapshot'
    );
    if (existingDecisionSnapshot?.payload?.features) {
      prediction.featureSnapshot = existingDecisionSnapshot.payload.features;
    } else if (!existingDecisionSnapshot) {
      prediction.featureSnapshot = {
        ...(prediction.featureSnapshot || {}),
        news: stored
      };
    } else {
      delete prediction.featureSnapshot;
    }
    delete prediction.pendingNewsFeatureSnapshot;
  }
  return predictions || [];
}

// Keyword risk flags for pregame veto only (never change model probability).
// Matches against title+summary of articles already scoped to the game.
const NEWS_RISK_PATTERNS = [
  {
    flag: 'sp_scratch',
    severity: 'critical',
    re: /\b(scratch(?:ed|es|ing)?|won'?t start|will not start|out of the start|removed from the start|late scratch|not starting|sidelined from start)\b/i
  },
  {
    flag: 'opener_bulk',
    severity: 'high',
    re: /\b(opener|bulk pitcher|piggyback|bullpen game|bullpen day)\b/i
  },
  {
    flag: 'injury_il',
    severity: 'high',
    re: /\b(placed on (the )?il|injured list|10[- ]day il|15[- ]day il|60[- ]day il|season[- ]ending|out for the season|out indefinitely)\b/i
  },
  {
    flag: 'day_to_day',
    severity: 'medium',
    re: /\b(day[- ]to[- ]day|questionable|game[- ]time decision|doubtful)\b/i
  },
  {
    flag: 'lineup_uncertain',
    severity: 'medium',
    re: /\b(lineup (?:tbd|not announced|pending)|expected lineup|projected lineup)\b/i
  },
  {
    flag: 'postponed',
    severity: 'critical',
    re: /\b(postponed|rainout|suspended|makeup date|doubleheader forced)\b/i
  }
];

/**
 * Extract veto-only risk flags from game-matched news articles.
 * Does not change probability, edge, or calibration — host rules may NO BET.
 */
export function extractNewsRiskFlags(prediction, newsConfig = {}) {
  const articles = prediction?.newsContext?.articles || [];
  const flags = [];
  const seen = new Set();
  const lineupConfirmed = Boolean(
    prediction?.lineups?.away?.confirmed &&
      prediction?.lineups?.home?.confirmed &&
      (prediction?.lineups?.away?.count || 0) >= 9 &&
      (prediction?.lineups?.home?.count || 0) >= 9
  );

  for (const article of articles) {
    const text = `${article.title || ''} ${article.summary || ''}`;
    for (const pattern of NEWS_RISK_PATTERNS) {
      if (!pattern.re.test(text)) continue;
      // Medium risks only veto when lineup is not fully confirmed.
      if (pattern.severity === 'medium' && lineupConfirmed && pattern.flag !== 'postponed') {
        continue;
      }
      if (seen.has(pattern.flag)) continue;
      seen.add(pattern.flag);
      flags.push({
        flag: pattern.flag,
        severity: pattern.severity,
        source: article.sourceName || article.source || 'news',
        title: article.title || '',
        publishedAt: article.publishedAt || null,
        url: article.url || null
      });
    }
  }

  const vetoEnabled = newsConfig.riskVeto !== false;
  const vetoFlags = vetoEnabled
    ? flags.filter((f) => f.severity === 'critical' || f.severity === 'high' || f.severity === 'medium')
    : [];
  // Only critical+high always veto; medium only if still in list after lineup check.
  const shouldVeto = vetoFlags.some((f) => f.severity === 'critical' || f.severity === 'high' || f.severity === 'medium');

  return {
    flags,
    veto: shouldVeto && vetoFlags.length > 0,
    vetoReasons: vetoFlags.map((f) => {
      const labels = {
        sp_scratch: 'news: SP scratch / won\'t start',
        opener_bulk: 'news: opener/bulk/bullpen game risk',
        injury_il: 'news: IL / season injury report',
        day_to_day: 'news: day-to-day / game-time decision',
        lineup_uncertain: 'news: lineup still projected/TBD',
        postponed: 'news: postponed / rainout / suspended'
      };
      return labels[f.flag] || `news risk: ${f.flag}`;
    }),
    lineupConfirmed,
    probabilityImpact: 'none'
  };
}

export async function attachNewsContext(config, predictions, storage) {
  if (!Array.isArray(predictions) || predictions.length === 0) return predictions || [];
  const newsConfig = config?.news || {};
  if (!newsConfig.enabled) {
    for (const prediction of predictions) {
      prediction.newsContext = {
        schemaVersion: NEWS_SCHEMA_VERSION,
        gamePk: String(prediction.gamePk),
        status: 'disabled',
        sourceStatus: [],
        articles: [],
        newsRisk: { flags: [], veto: false, vetoReasons: [], probabilityImpact: 'none' },
        displayOnly: true,
        probabilityImpact: 'none'
      };
    }
    return predictions;
  }

  const sources = parseFeedsConfig(newsConfig.feeds);
  const sourceResults = await Promise.allSettled(sources.map((source) => fetchFeed(source, config, storage)));
  const sourceStatus = sourceResults.map((result, index) => result.status === 'fulfilled'
    ? result.value
    : {
        source: sources[index]?.source || 'unknown',
        sourceName: sources[index]?.name || sources[index]?.source || 'Unknown',
        status: 'unavailable',
        articles: [],
        error: result.reason?.message || String(result.reason || 'feed failed')
      });
  for (const prediction of predictions) {
    const predictionTimestampUtc = predictionTimestampFor(prediction);
    const articles = [];
    const seen = new Set();
    for (const result of sourceStatus) {
      for (const raw of result.articles || []) {
        const normalized = normalizeSourceArticle(raw, result, prediction, new Date().toISOString(), newsConfig);
        if (!normalized || seen.has(normalized.id)) continue;
        seen.add(normalized.id);
        articles.push(normalized);
      }
    }
    articles.sort((a, b) => (parseUtcMs(b.publishedAt) || 0) - (parseUtcMs(a.publishedAt) || 0));
    const limited = articles.slice(0, Number(newsConfig.maxArticlesPerGame || DEFAULT_MAX_ARTICLES_PER_GAME));
    const status = statusFromSources(sourceStatus, limited.length);
    prediction.newsContext = {
      schemaVersion: NEWS_SCHEMA_VERSION,
      gamePk: String(prediction.gamePk),
      asOfUtc: predictionTimestampUtc,
      firstPitchUtc: toUtcIso(prediction.startTime),
      status,
      sourceStatus: sourceStatus.map((item) => ({ source: item.source, sourceName: item.sourceName, status: item.status, error: item.error || null, cached: Boolean(item.cached) })),
      articles: limited,
      displayOnly: true,
      probabilityImpact: 'none'
    };
    prediction.newsContext.newsRisk = extractNewsRiskFlags(prediction, newsConfig);
    const newsFeatures = Object.fromEntries(limited.map((article) => [article.id, provenanceForArticle(article)]));
    prediction.pendingNewsFeatureSnapshot = newsFeatures;
  }
  return predictions;
}

export function formatNewsDigest(predictions, { maxGames = 5, maxArticles = 2 } = {}) {
  if (!Array.isArray(predictions) || predictions.length === 0) return 'Tidak ada data news eksternal.';
  const lines = ['📰 External News Context', ''];
  for (const prediction of predictions.slice(0, maxGames)) {
    const context = prediction.newsContext;
    lines.push(`${prediction.away?.abbreviation || prediction.away?.name || 'Away'} @ ${prediction.home?.abbreviation || prediction.home?.name || 'Home'}`);
    if (!context || context.status === 'disabled') {
      lines.push('• News eksternal nonaktif.');
    } else if (!context.articles?.length) {
      lines.push(`• Tidak ada artikel cocok (${context.status}).`);
    } else {
      for (const article of context.articles.slice(0, maxArticles)) {
        const when = article.publishedAt ? new Date(article.publishedAt).toISOString().slice(0, 16).replace('T', ' ') : 'waktu tidak tersedia';
        lines.push(`• [${article.sourceName}] ${article.title} (${when} UTC)`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

export const __newsTestInternals = {
  canonicalUrl,
  hostAllowed,
  parseFeedXml,
  parseFeedsConfig,
  matchArticle,
  normalizeSourceArticle,
  provenanceForArticle,
  extractNewsRiskFlags,
  setNewsFetchForTest(fetcher) { testFetch = fetcher; },
  resetNewsFetchForTest() { testFetch = null; }
};
