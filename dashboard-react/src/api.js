import { clearSessionToken, getSessionToken } from './useAuth.js';

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
let unauthorizedHandler = null;

export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = typeof handler === 'function' ? handler : null;
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null;
  };
}

function authHeaders() {
  const token = getSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

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

function handleUnauthorized(response) {
  if (response.status !== 401) return;
  clearSessionToken();
  if (unauthorizedHandler) unauthorizedHandler();
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

async function request(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...authHeaders(),
    ...(options.headers || {}),
  };
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });
  handleUnauthorized(response);
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

function exportFilename(kind, response) {
  const disposition = response.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/i);
  return match?.[1] || `${kind}.csv`;
}

export async function downloadExport(kind, params = {}) {
  const response = await fetch(`${API_BASE}/api/export/${kind}${queryString(params)}`, {
    headers: authHeaders(),
  });
  handleUnauthorized(response);
  if (!response.ok) {
    throw new Error(await errorMessage(response, `Export failed: ${response.status}`));
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = exportFilename(kind, response);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
