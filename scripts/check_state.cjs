const Database = require('better-sqlite3');
const db = new Database('data/state.sqlite');
const row = db.prepare('SELECT learning_log FROM memory_summary WHERE id=1').get();
const log = JSON.parse(row.learning_log || '[]');
console.log('learning_log entries:', log.length);
log.slice(0, 3).forEach((e, i) => console.log(i, JSON.stringify({ gamePk: e.gamePk, score: e.score })));

// Also check state.json
const fs = require('fs');
const state = JSON.parse(fs.readFileSync('data/state.json', 'utf8'));
console.log('\nstate.json predictions:', Object.keys(state.predictions || {}).length);
const ll = (state.memory && state.memory.learningLog) || [];
console.log('state.json learningLog:', ll.length);
ll.slice(0, 3).forEach((e, i) => console.log(i, JSON.stringify({ gamePk: e.gamePk, score: e.score })));
db.close();