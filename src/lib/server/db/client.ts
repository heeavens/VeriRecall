import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema';

export interface DatabaseConnection {
  databasePath: string;
  sqlite: Database.Database;
  db: ReturnType<typeof drizzle<typeof schema>>;
}

export function createDatabaseConnection(databaseUrl: string): DatabaseConnection {
  const databasePath = resolve(databaseUrl);

  mkdirSync(dirname(databasePath), { recursive: true });

  const sqlite = new Database(databasePath);
  sqlite.pragma('foreign_keys = ON');

  return {
    databasePath,
    sqlite,
    db: drizzle(sqlite, { schema })
  };
}
