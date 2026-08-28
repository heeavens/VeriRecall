import 'dotenv/config';

import { createDatabaseConnection } from './client';

const configuredDatabaseUrl = process.env.DATABASE_URL?.trim() || './data/recallops.db';
const connection = createDatabaseConnection(configuredDatabaseUrl);

export const { databasePath, sqlite, db } = connection;
