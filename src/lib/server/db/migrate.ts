import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { db, databasePath, sqlite } from './connection';

try {
  migrate(db, { migrationsFolder: './drizzle' });
  console.log(`Database migrated at ${databasePath}`);
} finally {
  sqlite.close();
}
