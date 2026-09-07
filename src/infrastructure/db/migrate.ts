import { config } from '../../config/index.js';
import { openDb } from './connection.js';

const db = openDb(config.db.path);
console.log(`Migrated ${config.db.path}`);
db.close();
