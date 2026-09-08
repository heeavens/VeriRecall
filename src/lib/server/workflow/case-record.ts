import { count } from 'drizzle-orm';

import type { RecallDatabase } from '../db/repositories';
import { cases } from '../db/schema';
import { assessHarm } from '../risk/harm';

export function nextCaseNumber(database: RecallDatabase): string {
  const caseCount = database.select({ value: count() }).from(cases).get()?.value ?? 0;
  return `CASE-${String(caseCount + 1).padStart(4, '0')}`;
}

export function severityForRisk(risk: string, description = ''): string {
  return assessHarm({ risk, description }).level;
}
