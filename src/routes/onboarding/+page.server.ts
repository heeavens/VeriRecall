import { fail, redirect } from '@sveltejs/kit';
import { count } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '$lib/server/db/connection';
import { products } from '$lib/server/db/schema';
import { importCatalogue, importPurchases } from '$lib/server/imports/importer';
import { completeSetup, getSetupState, useDemoData } from '$lib/server/imports/setup';

import type { Actions, PageServerLoad } from './$types';

const thresholdSchema = z.coerce.number().int().min(70).max(95);

function uploadedFile(formData: FormData): File | null {
  const value = formData.get('file');
  return value instanceof File && value.name.trim().length > 0 ? value : null;
}

export const load: PageServerLoad = () => getSetupState(db);

export const actions: Actions = {
  uploadCatalog: async ({ request }) => {
    const file = uploadedFile(await request.formData());
    if (!file) {
      return fail(400, {
        kind: 'catalogue' as const,
        success: false,
        message: 'Choose a CSV or XLSX product catalogue.'
      });
    }

    try {
      const result = await importCatalogue(db, file);
      if (!result.success) {
        return fail(400, { kind: 'catalogue' as const, ...result });
      }

      return { kind: 'catalogue' as const, ...result };
    } catch {
      return fail(500, {
        kind: 'catalogue' as const,
        success: false,
        message: 'The catalogue could not be saved. No rows were imported; please try again.'
      });
    }
  },

  uploadCustomers: async ({ request }) => {
    const file = uploadedFile(await request.formData());
    if (!file) {
      return fail(400, {
        kind: 'purchases' as const,
        success: false,
        message: 'Choose a CSV or XLSX customer purchase file.'
      });
    }

    try {
      const result = await importPurchases(db, file);
      if (!result.success) {
        return fail(400, { kind: 'purchases' as const, ...result });
      }

      return { kind: 'purchases' as const, ...result };
    } catch {
      return fail(500, {
        kind: 'purchases' as const,
        success: false,
        message: 'The purchases could not be saved. No rows were imported; please try again.'
      });
    }
  },

  complete: async ({ request }) => {
    const formData = await request.formData();
    const threshold = thresholdSchema.safeParse(formData.get('confidenceThreshold'));
    if (!threshold.success) {
      return fail(400, {
        kind: 'complete' as const,
        success: false,
        message: 'Confidence threshold must be a whole number from 70 to 95.'
      });
    }

    const productCount = db.select({ value: count() }).from(products).get()?.value ?? 0;
    if (productCount === 0) {
      return fail(400, {
        kind: 'complete' as const,
        success: false,
        message: 'Import a product catalogue or use demo data before completing setup.'
      });
    }

    try {
      completeSetup(db, threshold.data);
    } catch {
      return fail(500, {
        kind: 'complete' as const,
        success: false,
        message: 'Setup could not be saved. Please try again.'
      });
    }
    redirect(303, '/dashboard');
  },

  useDemoData: () => {
    try {
      useDemoData(db);
    } catch {
      return fail(500, {
        kind: 'catalogue' as const,
        success: false,
        message: 'Demo data could not be prepared. Your existing data was not changed.'
      });
    }
    redirect(303, '/dashboard');
  }
};
