export {};

const isConfirmed = process.argv.includes('--confirm');
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction) {
  process.exitCode = 1;
  console.error('Demo reset is disabled when NODE_ENV=production.');
} else if (!isConfirmed) {
  process.exitCode = 1;
  console.error('Demo reset requires confirmation. Run npm run db:reset -- --confirm.');
} else {
  const [{ databasePath, db, sqlite }, { loadDemoFixtures }, repositories] = await Promise.all([
    import('./connection'),
    import('./demo-fixtures'),
    import('./repositories')
  ]);

  try {
    repositories.clearDemoData(db);
    repositories.seedDemoData(db, loadDemoFixtures());
    const summary = repositories.getDemoStateSummary(db);

    console.log(
      `Demo data reset at ${databasePath}: ${summary.products} products and ${summary.alerts} alerts restored.`
    );
  } finally {
    sqlite.close();
  }
}
