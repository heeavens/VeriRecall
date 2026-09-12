import { z } from 'zod';

export const extractedAlertSchema = z.object({
  productName: z.string().trim().min(1).max(500),
  brand: z.string().trim().min(1).max(300).nullable(),
  ean: z.string().trim().min(1).max(64).nullable(),
  batch: z.string().trim().min(1).max(200).nullable(),
  category: z.string().trim().min(1).max(300).nullable()
}).strict();

export const matchExplanationSchema = z.object({
  explanation: z.string().trim().min(1).max(1_000)
}).strict();

export const actionDraftSchema = z.object({
  body: z.string().trim().min(1).max(5_000)
}).strict();
