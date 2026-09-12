export const challengeBatchApplicationBasisFormatVersion =
  'challenge-batch-application-basis/v1' as const;

export const inheritedChallengeBatchApplicationBasisFormatVersion =
  'challenge-batch-application-basis/v2' as const;

export const conflictContinuationChallengeBatchApplicationBasisFormatVersion =
  'challenge-batch-application-basis/v3' as const;

export const challengeBatchApplicationPolicy = {
  identifier: 'demo-challenge-batch-human-application-policy',
  version: 'v1'
} as const;

export type ChallengeBatchApplicationBasisFormatVersion =
  | typeof challengeBatchApplicationBasisFormatVersion
  | typeof inheritedChallengeBatchApplicationBasisFormatVersion
  | typeof conflictContinuationChallengeBatchApplicationBasisFormatVersion;
