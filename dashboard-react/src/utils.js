export function number(value, digits = 1, fallback = '-') {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : fallback;
}

export function percent(value, digits = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed.toFixed(digits)}%` : '-';
}

export function signed(value, suffix = '', digits = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '-';
  return `${parsed >= 0 ? '+' : ''}${parsed.toFixed(digits)}${suffix}`;
}

export function relativeTime(value) {
  if (!value) return 'Not updated';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diff = Date.now() - date.getTime();
  const minutes = Math.max(0, Math.round(diff / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];
}

export function lower(value) {
  return String(value || '').toLowerCase();
}
