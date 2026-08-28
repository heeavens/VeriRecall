import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { AlertSource, NormalizedAlert } from '../../types/domain';
import { normalizeAlert } from './normalization';

export function alertReferenceKey(alert: Pick<NormalizedAlert, 'source' | 'sourceReference'>): string {
  return `${alert.source}:${alert.sourceReference}`;
}

export class ArchiveAlertSource implements AlertSource {
  constructor(private readonly fixtureDirectory = resolve('data/alerts')) {}

  async getNewAlerts(existingReferences: Set<string>): Promise<NormalizedAlert[]> {
    const fileNames = (await readdir(this.fixtureDirectory))
      .filter((fileName) => fileName.endsWith('.json'))
      .sort();

    const alerts = await Promise.all(
      fileNames.map(async (fileName) => {
        const contents = await readFile(resolve(this.fixtureDirectory, fileName), 'utf8');
        return normalizeAlert(JSON.parse(contents) as unknown);
      })
    );

    return alerts
      .filter(
        (alert) =>
          !existingReferences.has(alert.sourceReference) &&
          !existingReferences.has(alertReferenceKey(alert))
      )
      .sort((left, right) =>
        left.publishedAt.localeCompare(right.publishedAt) ||
        left.sourceReference.localeCompare(right.sourceReference)
      );
  }
}
