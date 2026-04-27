export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

export function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const normalized = String(value).replace('%', '').trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function safeFixed(value, digits = 2, fallback = '-') {
  const parsed = toNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : fallback;
}

export function percent(value) {
  return `${Math.round(value)}%`;
}

export function splitIntoTelegramMessages(text, limit = 3900) {
  if (text.length <= limit) return [text];

  const chunks = [];
  let current = '';

  for (const block of text.split('\n\n')) {
    const next = current ? `${current}\n\n${block}` : block;
    if (next.length > limit) {
      if (current) chunks.push(current);
      current = block;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

export function isValidDateYmd(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function dateInTimezone(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

export function timeInTimezone(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);

  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.hour}:${byType.minute}`;
}

export function formatGameTime(dateTime) {
  if (!dateTime) return 'TBD';

  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: '2-digit',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    }).format(new Date(dateTime));
  } catch {
    return dateTime;
  }
}
