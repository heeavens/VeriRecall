import { databasePath, db, sqlite } from './connection';
import { loadDemoFixtures } from './demo-fixtures';
import { getDemoStateSummary, seedDemoData } from './repositories';

try {
  seedDemoData(db, loadDemoFixtures());
  const summary = getDemoStateSummary(db);

  console.log(
    `Demo data ready at ${databasePath}: ${summary.products} products, ${summary.customers} customers, ${summary.purchases} purchases, ${summary.alerts} alerts and ${summary.cases} case.`
  );
} finally {
  sqlite.close();
}
