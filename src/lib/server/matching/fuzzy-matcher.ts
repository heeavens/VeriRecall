import { ratio, token_set_ratio } from 'fuzzball';

import type { FuzzyMatcher } from '../../types/domain';

export class LocalFuzzyMatcher implements FuzzyMatcher {
  ratio(left: string, right: string): number {
    if (!left || !right) return 0;
    return ratio(left, right, { full_process: false });
  }

  tokenSetRatio(left: string, right: string): number {
    if (!left || !right) return 0;
    return token_set_ratio(left, right, { full_process: false });
  }
}
