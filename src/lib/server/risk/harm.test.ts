import { describe, expect, it } from 'vitest';

import { assessHarm, harmScoreForLevel } from './harm';

describe('official alert harm priority', () => {
  it('ranks potentially life-threatening harm above other source warnings', () => {
    expect(
      assessHarm({
        risk: 'Choking and injuries',
        description: 'Swallowed magnets can cause intestinal blockage or perforation.'
      })
    ).toMatchObject({ level: 'critical', score: 100 });
    expect(assessHarm({ risk: 'Choking' })).toMatchObject({ level: 'high', score: 75 });
    expect(assessHarm({ risk: 'Skin irritation' })).toMatchObject({ level: 'medium', score: 50 });
    expect(assessHarm({ risk: 'Unclassified source warning' })).toMatchObject({
      level: 'low',
      score: 25
    });
  });

  it('keeps persisted case levels sortable', () => {
    expect(['low', 'critical', 'medium', 'high'].sort((left, right) =>
      harmScoreForLevel(right) - harmScoreForLevel(left)
    )).toEqual(['critical', 'high', 'medium', 'low']);
  });
});
