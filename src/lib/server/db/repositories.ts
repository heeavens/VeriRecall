import { count, eq, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema';
import type { DemoFixtures } from './demo-fixtures';
import { resolveAlertFactsInTransaction } from '../alerts/alert-provenance';
import { recordAlertMatchBasisInTransaction } from '../matching/match-basis';

export type RecallDatabase = BetterSQLite3Database<typeof schema>;

export interface DemoStateSummary {
  settings: number;
  products: number;
  customers: number;
  purchases: number;
  alerts: number;
  matches: number;
  cases: number;
  scenarios: {
    highConfidence: number;
    uncertain: number;
    notRelevant: number;
  };
}

export function seedDemoData(database: RecallDatabase, fixtures: DemoFixtures): void {
  database.transaction((transaction) => {
    const hasAlertProvenance = Boolean(transaction.get<{ name: string }>(
      sql`select name from sqlite_master where type = 'table' and name = 'alert_match_bases'`
    ));
    transaction.insert(schema.settings).values(fixtures.settings).onConflictDoNothing().run();
    transaction.insert(schema.products).values(fixtures.products).onConflictDoNothing().run();
    transaction.insert(schema.customers).values(fixtures.customers).onConflictDoNothing().run();
    transaction.insert(schema.purchases).values(fixtures.purchases).onConflictDoNothing().run();
    transaction.insert(schema.alerts).values(fixtures.alerts).onConflictDoNothing().run();
    if (hasAlertProvenance) {
      transaction.insert(schema.alertSourceObservations).values(fixtures.alertSourceObservations).onConflictDoNothing().run();
      transaction.insert(schema.alertFieldAssertions).values(fixtures.alertFieldAssertions).onConflictDoNothing().run();
    }
    transaction.insert(schema.matches).values(fixtures.matches).onConflictDoNothing().run();
    for (const match of hasAlertProvenance ? fixtures.matches : []) {
      const observation = fixtures.alertSourceObservations.find((item) => item.alertId === match.alertId);
      const product = transaction
        .select()
        .from(schema.products)
        .where(eq(schema.products.id, match.productId))
        .get();
      if (!observation || !product) throw new Error(`Demo match ${match.id} has incomplete provenance.`);
      const facts = resolveAlertFactsInTransaction(transaction, {
        alertId: match.alertId,
        sourceObservationRef: observation.observationRef,
        purpose: 'DISCOVERY'
      });
      recordAlertMatchBasisInTransaction(transaction, {
        matchId: match.id,
        alertId: match.alertId,
        sourceObservationRef: observation.observationRef,
        catalogueProduct: product,
        discoveryAssertionRefs: facts.discovery.assertionRefs,
        authoritativeIdentityAssertionRefs: facts.authoritative.identityAssertionRefs,
        authoritativeScopeAssertionRefs: facts.authoritative.scopeAssertionRefs,
        explanation: {
          text: match.explanation,
          origin: 'DETERMINISTIC',
          generatorIdentifier: 'verirecall-demo-match-explainer',
          generatorVersion: 'v1',
          modelIdentifier: null
        },
        createdAt: match.createdAt,
        demo: true
      });
    }
    if (fixtures.cases.length) {
      transaction.insert(schema.cases).values(fixtures.cases).onConflictDoNothing().run();
    }
    if (fixtures.caseItems.length) {
      transaction.insert(schema.caseItems).values(fixtures.caseItems).onConflictDoNothing().run();
    }
    if (fixtures.caseTasks.length) {
      transaction.insert(schema.caseTasks).values(fixtures.caseTasks).onConflictDoNothing().run();
    }
    if (fixtures.actionDrafts.length) {
      transaction.insert(schema.actionDrafts).values(fixtures.actionDrafts).onConflictDoNothing().run();
    }
    if (fixtures.auditEvents.length) {
      transaction.insert(schema.auditEvents).values(fixtures.auditEvents).onConflictDoNothing().run();
    }
  });
}

export function getDemoStateSummary(database: RecallDatabase): DemoStateSummary {
  const statusCounts = database
    .select({ status: schema.alerts.status, value: count() })
    .from(schema.alerts)
    .groupBy(schema.alerts.status)
    .all();

  const statusCount = (status: (typeof schema.alerts.$inferSelect)['status']): number =>
    statusCounts.find((row) => row.status === status)?.value ?? 0;
  const threshold = database.select().from(schema.settings).get()?.confidenceThreshold ?? 85;
  const reviewMatches = database
    .select({ alertId: schema.matches.alertId, match: schema.matches })
    .from(schema.matches)
    .innerJoin(schema.alerts, eq(schema.alerts.id, schema.matches.alertId))
    .where(eq(schema.alerts.status, 'needs_review'))
    .all();
  const bestReviewMatches = new Map<string, typeof schema.matches.$inferSelect>();
  for (const row of reviewMatches) {
    const current = bestReviewMatches.get(row.alertId);
    if (!current || row.match.totalScore > current.totalScore) {
      bestReviewMatches.set(row.alertId, row.match);
    }
  }
  const highConfidence = [...bestReviewMatches.values()].filter(
    (match) => match.totalScore >= threshold && !match.hasHardConflict
  ).length;

  return {
    settings: database.select({ value: count() }).from(schema.settings).get()?.value ?? 0,
    products: database.select({ value: count() }).from(schema.products).get()?.value ?? 0,
    customers: database.select({ value: count() }).from(schema.customers).get()?.value ?? 0,
    purchases: database.select({ value: count() }).from(schema.purchases).get()?.value ?? 0,
    alerts: database.select({ value: count() }).from(schema.alerts).get()?.value ?? 0,
    matches: database.select({ value: count() }).from(schema.matches).get()?.value ?? 0,
    cases: database.select({ value: count() }).from(schema.cases).get()?.value ?? 0,
    scenarios: {
      highConfidence,
      uncertain: statusCount('needs_review') - highConfidence,
      notRelevant: statusCount('not_relevant')
    }
  };
}

export function clearDemoData(database: RecallDatabase): void {
  database.transaction((transaction) => {
    transaction.delete(schema.investigationInvestigatorRecommendationEvents).run();
    transaction.delete(schema.investigationInvestigatorRecommendations).run();
    transaction.delete(schema.investigationChallengeBatchApplications).run();
    transaction.delete(schema.investigationEstablishedBatchApplications).run();
    transaction.delete(schema.investigationChallengeConflictApplications).run();
    transaction.delete(schema.investigationChallengeEstablishments).run();
    transaction.delete(schema.investigationChallengeAssessments).run();
    transaction.delete(schema.investigationChallengeClaims).run();
    transaction.delete(schema.investigationChallengeRequests).run();
    transaction.delete(schema.investigationChallenges).run();
    transaction.delete(schema.investigationEstablishments).run();
    transaction.delete(schema.investigationAssessments).run();
    transaction.delete(schema.investigationClaims).run();
    transaction.delete(schema.investigationEvidence).run();
    transaction.delete(schema.auditEvents).run();
    transaction.delete(schema.actionDrafts).run();
    transaction.delete(schema.evidenceRequests).run();
    transaction.delete(schema.investigationQuestions).run();
    transaction.delete(schema.caseTasks).run();
    transaction.delete(schema.caseItems).run();
    transaction.delete(schema.cases).run();
    transaction.delete(schema.alertMatchBases).run();
    transaction.delete(schema.matches).run();
    transaction.delete(schema.alertFieldAssertions).run();
    transaction.delete(schema.alertSourceObservations).run();
    transaction.delete(schema.alerts).run();
    transaction.delete(schema.purchases).run();
    transaction.delete(schema.customers).run();
    transaction.delete(schema.products).run();
    transaction.delete(schema.settings).run();
  });
}

export function replaceWithDemoData(database: RecallDatabase, fixtures: DemoFixtures): void {
  database.transaction((transaction) => {
    transaction.delete(schema.investigationInvestigatorRecommendationEvents).run();
    transaction.delete(schema.investigationInvestigatorRecommendations).run();
    transaction.delete(schema.investigationChallengeBatchApplications).run();
    transaction.delete(schema.investigationEstablishedBatchApplications).run();
    transaction.delete(schema.investigationChallengeConflictApplications).run();
    transaction.delete(schema.investigationChallengeEstablishments).run();
    transaction.delete(schema.investigationChallengeAssessments).run();
    transaction.delete(schema.investigationChallengeClaims).run();
    transaction.delete(schema.investigationChallengeRequests).run();
    transaction.delete(schema.investigationChallenges).run();
    transaction.delete(schema.investigationEstablishments).run();
    transaction.delete(schema.investigationAssessments).run();
    transaction.delete(schema.investigationClaims).run();
    transaction.delete(schema.investigationEvidence).run();
    transaction.delete(schema.auditEvents).run();
    transaction.delete(schema.actionDrafts).run();
    transaction.delete(schema.evidenceRequests).run();
    transaction.delete(schema.investigationQuestions).run();
    transaction.delete(schema.caseTasks).run();
    transaction.delete(schema.caseItems).run();
    transaction.delete(schema.cases).run();
    transaction.delete(schema.alertMatchBases).run();
    transaction.delete(schema.matches).run();
    transaction.delete(schema.alertFieldAssertions).run();
    transaction.delete(schema.alertSourceObservations).run();
    transaction.delete(schema.alerts).run();
    transaction.delete(schema.purchases).run();
    transaction.delete(schema.customers).run();
    transaction.delete(schema.products).run();
    transaction.delete(schema.settings).run();

    transaction.insert(schema.settings).values(fixtures.settings).run();
    transaction.insert(schema.products).values(fixtures.products).run();
    transaction.insert(schema.customers).values(fixtures.customers).run();
    transaction.insert(schema.purchases).values(fixtures.purchases).run();
    transaction.insert(schema.alerts).values(fixtures.alerts).run();
    transaction.insert(schema.alertSourceObservations).values(fixtures.alertSourceObservations).run();
    transaction.insert(schema.alertFieldAssertions).values(fixtures.alertFieldAssertions).run();
    transaction.insert(schema.matches).values(fixtures.matches).run();
    for (const match of fixtures.matches) {
      const observation = fixtures.alertSourceObservations.find((item) => item.alertId === match.alertId);
      const product = transaction
        .select()
        .from(schema.products)
        .where(eq(schema.products.id, match.productId))
        .get();
      if (!observation || !product) throw new Error(`Demo match ${match.id} has incomplete provenance.`);
      const facts = resolveAlertFactsInTransaction(transaction, {
        alertId: match.alertId,
        sourceObservationRef: observation.observationRef,
        purpose: 'DISCOVERY'
      });
      recordAlertMatchBasisInTransaction(transaction, {
        matchId: match.id,
        alertId: match.alertId,
        sourceObservationRef: observation.observationRef,
        catalogueProduct: product,
        discoveryAssertionRefs: facts.discovery.assertionRefs,
        authoritativeIdentityAssertionRefs: facts.authoritative.identityAssertionRefs,
        authoritativeScopeAssertionRefs: facts.authoritative.scopeAssertionRefs,
        explanation: {
          text: match.explanation,
          origin: 'DETERMINISTIC',
          generatorIdentifier: 'verirecall-demo-match-explainer',
          generatorVersion: 'v1',
          modelIdentifier: null
        },
        createdAt: match.createdAt,
        demo: true
      });
    }
    if (fixtures.cases.length) transaction.insert(schema.cases).values(fixtures.cases).run();
    if (fixtures.caseItems.length) {
      transaction.insert(schema.caseItems).values(fixtures.caseItems).run();
    }
    if (fixtures.caseTasks.length) {
      transaction.insert(schema.caseTasks).values(fixtures.caseTasks).run();
    }
    if (fixtures.actionDrafts.length) {
      transaction.insert(schema.actionDrafts).values(fixtures.actionDrafts).run();
    }
    if (fixtures.auditEvents.length) {
      transaction.insert(schema.auditEvents).values(fixtures.auditEvents).run();
    }
  });
}
