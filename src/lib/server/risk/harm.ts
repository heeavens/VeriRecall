export const harmLevels = ['critical', 'high', 'medium', 'low'] as const;
export type HarmLevel = (typeof harmLevels)[number];

export interface HarmAssessment {
  level: HarmLevel;
  score: number;
  reason: string;
}

interface HarmRule {
  level: HarmLevel;
  score: number;
  reason: string;
  signals: readonly string[];
}

const rules: readonly HarmRule[] = [
  {
    level: 'critical',
    score: 100,
    reason: 'The source alert describes a potentially life-threatening or severe systemic harm.',
    signals: [
      'fatal',
      'death',
      'life threatening',
      'listeria',
      'botul',
      'intestinal blockage',
      'perforation',
      'serious microbiological'
    ]
  },
  {
    level: 'high',
    score: 75,
    reason: 'The source alert describes choking, injury, burn, shock or another serious harm.',
    signals: [
      'choking',
      'injur',
      'burn',
      'electric shock',
      'microbiological',
      'salmonella',
      'chemical risk',
      'small magnet'
    ]
  },
  {
    level: 'medium',
    score: 50,
    reason: 'The source alert describes a material harm that should be reviewed promptly.',
    signals: ['allerg', 'irrit', 'cut', 'suffocation', 'damage to sight']
  }
];

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function assessHarm(input: { risk: string; description?: string }): HarmAssessment {
  const sourceText = normalize(`${input.risk} ${input.description ?? ''}`);
  const matchedRule = rules.find((rule) =>
    rule.signals.some((signal) => sourceText.includes(normalize(signal)))
  );

  return matchedRule ?? {
    level: 'low',
    score: 25,
    reason: 'The source alert does not contain a recognised high-harm signal in the demo rules.'
  };
}

export function harmScoreForLevel(level: string): number {
  if (level === 'critical') return 100;
  if (level === 'high') return 75;
  if (level === 'medium') return 50;
  return 25;
}
