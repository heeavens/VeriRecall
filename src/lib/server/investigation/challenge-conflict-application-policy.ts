export const challengeConflictApplicationBasisFormatVersion =
  'challenge-conflict-application-basis/v1' as const;

export const challengeConflictApplicationPolicy = {
  identifier: 'demo-challenge-conflict-application-policy',
  version: 'v1'
} as const;

export const inheritedChallengeConflictApplicationBasisFormatVersion =
  'challenge-conflict-application-basis/v2' as const;

export const inheritedChallengeConflictApplicationPolicy = {
  identifier: challengeConflictApplicationPolicy.identifier,
  version: 'v2'
} as const;

export type ChallengeConflictApplicationBasisFormatVersion =
  | typeof challengeConflictApplicationBasisFormatVersion
  | typeof inheritedChallengeConflictApplicationBasisFormatVersion;
