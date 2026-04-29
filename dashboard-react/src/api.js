const API_BASE = import.meta.env.VITE_API_BASE_URL || '';

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }
  return response.json();
}

export const api = {
  today: (params) => request(`/api/today?${new URLSearchParams(params)}`),
  history: () => request('/api/history'),
  performance: () => request('/api/performance'),
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

export function exportUrl(kind, params = {}) {
  const query = new URLSearchParams(params).toString();
  return `${API_BASE}/api/export/${kind}${query ? `?${query}` : ''}`;
}
