console.warn('DEPRECATED: npm run dashboard:legacy will be removed in a future cleanup. Use npm run dashboard for the React/FastAPI dashboard.');

const { startDashboard } = await import('../src/dashboard.js');

await startDashboard({ enabled: true });
