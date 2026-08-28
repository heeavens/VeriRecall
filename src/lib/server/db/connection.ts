import 'dotenv/config';

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

const configuredDatabaseUrl = process.env.DATABASE_URL?.trim() || './data/recallops.db';

export const databasePath = resolve(configuredDatabaseUrl);

mkdirSync(dirname(databasePath), { recursive: true });

export const sqlite = new Database(databasePath);
export const db = drizzle(sqlite);
