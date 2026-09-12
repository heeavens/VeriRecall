import { z } from 'zod';

import { alertSourceNames, type NormalizedAlert } from '../../types/domain';
import { normalizeGtin } from './gtin';

const archivedAlertSchema = z.object({
  source: z.enum(alertSourceNames),
  sourceReference: z.string().trim().min(1),
  sourceUrl: z.url(),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  risk: z.string().trim().min(1),
  productName: z.string().trim().min(1),
  brand: z.string().trim().nullable().optional(),
  ean: z.string().trim().nullable().optional(),
  batch: z.string().trim().nullable().optional(),
  category: z.string().trim().nullable().optional(),
  publishedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'publishedAt must be a valid date'
  })
});

function optionalText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeAlert(input: unknown): NormalizedAlert {
  const parsed = archivedAlertSchema.parse(input);

  return {
    source: parsed.source,
    sourceReference: parsed.sourceReference,
    sourceUrl: parsed.sourceUrl,
    title: parsed.title,
    description: parsed.description,
    risk: parsed.risk,
    productName: parsed.productName,
    brand: optionalText(parsed.brand),
    ean: optionalText(parsed.ean),
    batch: optionalText(parsed.batch),
    category: optionalText(parsed.category),
    publishedAt: parsed.publishedAt
  };
}

export function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeBatch(value: string | null | undefined): string {
  return normalizeText(value).replace(/[^\p{L}\p{N}]/gu, '');
}

export function normalizeEan(value: string | null | undefined): string {
  return normalizeGtin(value);
}
