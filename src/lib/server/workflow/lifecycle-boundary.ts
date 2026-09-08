import { eq } from 'drizzle-orm';
import type { RecallDatabase } from '../db/repositories';
import { caseLifecycle } from '../db/schema';

export function hasCaseLifecycle(database: RecallDatabase, caseId: string): boolean {
  return Boolean(database.select({ id: caseLifecycle.caseId }).from(caseLifecycle).where(eq(caseLifecycle.caseId, caseId)).get());
}
