import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

import { alertSourceNames } from '../../types/domain';

const expectationSchema = z.object({
  source: z.enum(alertSourceNames),
  sourceReference: z.string().min(1),
  expectedSku: z.string().min(1).nullable()
});

const expectationsSchema = z.array(expectationSchema);

export type EvaluationExpectation = z.infer<typeof expectationSchema>;

export interface EvaluationPrediction {
  source: EvaluationExpectation['source'];
  sourceReference: string;
  predictedSku: string | null;
  relevant: boolean;
}

export interface MatchingEvaluation {
  sampleSize: number;
  labeledRelevant: number;
  predictedRelevant: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number | null;
}

export function loadEvaluationExpectations(
  fixturePath = resolve('data/evaluation/expected-matches.json')
): EvaluationExpectation[] {
  return expectationsSchema.parse(JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown);
}

function referenceKey(value: Pick<EvaluationExpectation, 'source' | 'sourceReference'>): string {
  return `${value.source}:${value.sourceReference}`;
}

function percentage(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 10_000) / 100;
}

export function evaluateMatching(
  predictions: EvaluationPrediction[],
  expectations: EvaluationExpectation[] = loadEvaluationExpectations()
): MatchingEvaluation {
  const predictionsByReference = new Map(
    predictions.map((prediction) => [referenceKey(prediction), prediction])
  );
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let predictedRelevant = 0;

  for (const expectation of expectations) {
    const prediction = predictionsByReference.get(referenceKey(expectation));
    if (!prediction) continue;
    if (prediction.relevant) predictedRelevant += 1;

    if (expectation.expectedSku === null) {
      if (prediction.relevant) falsePositives += 1;
      continue;
    }

    if (prediction.relevant && prediction.predictedSku === expectation.expectedSku) {
      truePositives += 1;
    } else {
      falseNegatives += 1;
      if (prediction.relevant) falsePositives += 1;
    }
  }

  const importedExpectations = expectations.filter((expectation) =>
    predictionsByReference.has(referenceKey(expectation))
  );

  return {
    sampleSize: importedExpectations.length,
    labeledRelevant: importedExpectations.filter((item) => item.expectedSku !== null).length,
    predictedRelevant,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: percentage(truePositives, truePositives + falsePositives),
    recall: percentage(truePositives, truePositives + falseNegatives)
  };
}
