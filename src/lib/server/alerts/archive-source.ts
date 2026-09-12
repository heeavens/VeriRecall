import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { AlertSource, AlertSourceRecord, NormalizedAlert } from '../../types/domain';
import { normalizeAlert } from './normalization';

export function alertReferenceKey(alert: Pick<NormalizedAlert, 'source' | 'sourceReference'>): string {
  return `${alert.source}:${alert.sourceReference}`;
}

export class ArchiveAlertSource implements AlertSource {
  constructor(private readonly fixtureDirectory = resolve('data/alerts')) {}

  async readAlerts(): Promise<AlertSourceRecord[]> {
    const fileNames = (await readdir(this.fixtureDirectory))
      .filter((fileName) => fileName.endsWith('.json'))
      .sort();

    const observations = await Promise.all(
      fileNames.map(async (fileName) => {
        const contents = await readFile(resolve(this.fixtureDirectory, fileName), 'utf8');
        return {
          alert: normalizeAlert(JSON.parse(contents) as unknown),
          provider: 'demo_archive',
          payloadFormat: 'application/json' as const,
          rawPayload: contents,
          observedAt: new Date().toISOString(),
          demo: true
        };
      })
    );

    return observations
      .sort((left, right) =>
        left.alert.publishedAt.localeCompare(right.alert.publishedAt) ||
        left.alert.sourceReference.localeCompare(right.alert.sourceReference)
      );
  }
}
