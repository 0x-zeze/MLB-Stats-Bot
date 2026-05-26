import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRequestHeaders } from '../dashboard-react/src/api.js';
import { DASHBOARD_TOKEN_KEY } from '../dashboard-react/src/useAuth.js';

test('dashboard API client sends bearer token from session storage', () => {
  global.window = {
    sessionStorage: {
      getItem(key) {
        assert.equal(key, DASHBOARD_TOKEN_KEY);
        return ' secret-token ';
      },
    },
  };

  const headers = buildRequestHeaders();

  assert.equal(headers.Authorization, 'Bearer secret-token');
  delete global.window;
});
