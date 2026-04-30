import { resolve } from 'node:path';
import { Storage } from '../src/storage.js';

const legacyPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const storage = legacyPath ? new Storage(legacyPath) : new Storage();
const state = storage.read();

console.log(`SQLite storage ready: ${storage.dbPath}`);
console.log(`Legacy state path: ${storage.filePath}`);
console.log(`Subscribers: ${Object.keys(state.subscribers || {}).length}`);
console.log(`Picks: ${Object.keys(state.predictions || {}).length}`);
console.log(`Memory picks: ${state.memory?.totalPicks || 0}`);

storage.close();
