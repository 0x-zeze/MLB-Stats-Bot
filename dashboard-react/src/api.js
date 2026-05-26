import { getSessionToken } from './useAuth.js';

const API_BASE = import.meta.env?.VITE_API_BASE_URL || '';

function queryString(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, value);
    }
  });
  const text = query.toString();
  return text ? `?${text}` : '';
}

async function errorMessage(response, fallback) {
  const text = await response.text();
  if (!text) return fallback;
  try {
    const payload = JSON.parse(text);
    return payload.detail || fallback;
  } catch {
    return text;
  }
}

export function buildRequestHeaders(extraHeaders = {}) {
  const token = getSessionToken();
  const headers = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function request(path, options = {}) {
  const headers = buildRequestHeaders(options.headers || {});
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response, `Request failed: ${response.status}`));
  }
  return response.json();
}

export const api = {
  today: (params) => request(`/api/today${queryString(params)}`),
  history: () => request('/api/history'),
  performance: () => request('/api/performance'),
  evolution: () => request('/api/evolution'),
  settings: () => request('/api/settings'),
  saveSettings: (payload) =>
    request('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  backtest: (payload) =>
    request('/api/backtest', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};

export async function downloadExport(kind, params = {}) {
  const response = await fetch(`${API_BASE}/api/export/${kind}${queryString(params)}`, {
    headers: buildRequestHeaders({ 'Content-Type': 'text/csv' }),
  });
  if (!response.ok) {
    throw new Error(await errorMessage(response, `Export failed: ${response.status}`));
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const disposition = response.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/i);
  link.download = match?.[1] || `${kind}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
