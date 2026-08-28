import { databasePath, sqlite } from './connection';

try {
  console.log(`No seed data is defined for Stage 0 (${databasePath})`);
} finally {
  sqlite.close();
}
