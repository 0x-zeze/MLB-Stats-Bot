export function isFiniteNum(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return false;
  return Number.isFinite(Number(value));
}

export function number(value, digits = 1, fallback = '-') {
  if (!isFiniteNum(value)) return fallback;
  return Number(value).toFixed(digits);
}

export function percent(value, digits = 1) {
  if (!isFiniteNum(value)) return '-';
  return `${Number(value).toFixed(digits)}%`;
}

export function signed(value, suffix = '', digits = 1) {
  if (!isFiniteNum(value)) return '-';
  const parsed = Number(value);
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
