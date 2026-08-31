import { describe, expect, it } from 'vitest';

import type { EvaluationExpectation, EvaluationPrediction } from './matching-evaluation';
import { evaluateMatching } from './matching-evaluation';

const expectations: EvaluationExpectation[] = [
  { source: 'safety_gate', sourceReference: 'A', expectedSku: 'SKU-A' },
  { source: 'safety_gate', sourceReference: 'B', expectedSku: 'SKU-B' },
  { source: 'rasff', sourceReference: 'C', expectedSku: null }
];

function prediction(
  sourceReference: string,
  predictedSku: string | null,
  relevant: boolean,
  source: EvaluationPrediction['source'] = 'safety_gate'
): EvaluationPrediction {
  return { source, sourceReference, predictedSku, relevant };
}

describe('labeled demo matching evaluation', () => {
  it('calculates precision and recall from expected top catalogue matches', () => {
    expect(
      evaluateMatching(
        [
          prediction('A', 'SKU-A', true),
          prediction('B', 'SKU-B', true),
          prediction('C', 'UNRELATED', false, 'rasff')
        ],
        expectations
      )
    ).toEqual({
      sampleSize: 3,
      labeledRelevant: 2,
      predictedRelevant: 2,
      truePositives: 2,
      falsePositives: 0,
      falseNegatives: 0,
      precision: 100,
      recall: 100
    });
  });

  it('counts a wrong relevant candidate as both a false positive and false negative', () => {
    const result = evaluateMatching(
      [prediction('A', 'WRONG', true), prediction('B', null, false)],
      expectations
    );

    expect(result).toMatchObject({
      sampleSize: 2,
      truePositives: 0,
      falsePositives: 1,
      falseNegatives: 2,
      precision: 0,
      recall: 0
    });
  });
});
