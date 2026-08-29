import { z } from 'zod';

import { alertSourceNames } from '../../types/domain';

export const extractedAlertSchema = z.object({
  source: z.enum(alertSourceNames),
  sourceReference: z.string().trim().min(1),
  sourceUrl: z.url(),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  risk: z.string().trim().min(1),
  productName: z.string().trim().min(1),
  brand: z.string().trim().nullable(),
  ean: z.string().trim().nullable(),
  batch: z.string().trim().nullable(),
  category: z.string().trim().nullable(),
  publishedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)))
});

export const matchExplanationSchema = z.object({
  explanation: z.string().trim().min(1).max(1_000)
});

export const actionDraftSchema = z.object({
  body: z.string().trim().min(1).max(5_000)
});
