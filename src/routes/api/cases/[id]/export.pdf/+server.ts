import { error } from '@sveltejs/kit';
import { z } from 'zod';

import { CaseReportError, CaseReportExporter } from '$lib/server/exports/case-report';
import { db } from '$lib/server/db/connection';

import type { RequestHandler } from './$types';

const caseIdSchema = z.string().uuid();

export const GET: RequestHandler = async ({ params }) => {
  const caseId = caseIdSchema.safeParse(params.id);
  if (!caseId.success) error(404, 'Recall case not found');

  try {
    const bytes = await new CaseReportExporter(db).exportCase(caseId.data, 'pdf');
    return new Response(new Uint8Array(bytes).buffer, {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="recall-case-${caseId.data}.pdf"`,
        'cache-control': 'no-store'
      }
    });
  } catch (reportError) {
    if (reportError instanceof CaseReportError) error(404, reportError.message);
    error(500, 'The PDF report could not be generated. Please retry.');
  }
};
