import { useCallback, useEffect, useState } from 'react';

export const DASHBOARD_TOKEN_KEY = 'mlb_dashboard_api_token';

function getSessionStorage() {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function getSessionToken() {
  return getSessionStorage()?.getItem(DASHBOARD_TOKEN_KEY)?.trim() || '';
}

export function saveSessionToken(token) {
  const storage = getSessionStorage();
  const nextToken = token.trim();
  if (!storage || !nextToken) return '';
  storage.setItem(DASHBOARD_TOKEN_KEY, nextToken);
  return nextToken;
}

export function clearSessionToken() {
  getSessionStorage()?.removeItem(DASHBOARD_TOKEN_KEY);
}

export function useAuth() {
  const [token, setToken] = useState(() => getSessionToken());

  const login = useCallback((nextToken) => {
    setToken(saveSessionToken(nextToken));
  }, []);

  const logout = useCallback(() => {
    clearSessionToken();
    setToken('');
  }, []);

  useEffect(() => {
    function syncToken() {
      setToken(getSessionToken());
    }

    window.addEventListener('storage', syncToken);
    return () => window.removeEventListener('storage', syncToken);
  }, []);

  return {
    token,
    isAuthenticated: Boolean(token),
    login,
    logout,
  };
}
