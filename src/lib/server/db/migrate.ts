import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { db, databasePath, sqlite } from './connection';
import { reconcileExistingInvestigationQuestions } from '../investigation/questions';

try {
  migrate(db, { migrationsFolder: './drizzle' });
  const reconciliation = reconcileExistingInvestigationQuestions(db);
  console.log(`Database migrated at ${databasePath}`);
  if (reconciliation.registered.length || reconciliation.conflicts.length || reconciliation.unverified.length) {
    console.log(
      `Investigation question reconciliation: ${reconciliation.registered.length} registered, ` +
      `${reconciliation.unverified.length} unverified, ${reconciliation.conflicts.length} conflicted.`
    );
  }
} finally {
  sqlite.close();
}
