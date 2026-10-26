import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { db, newId, nowIso, getRow } from '../db';
import { getRun, listResults, listReports, mapReport } from '../db/mappers';
import { ApiError } from '../errors';
import { randomBytes } from 'node:crypto';

export const reportsRouter = Router();

const createSchema = z.object({
  runId: z.string().min(1),
  visibility: z.enum(['public', 'private']).default('private'),
  title: z.string().min(1).max(200),
  summary: z.string().max(4000).default(''),
  language: z.enum(['zh-CN', 'en']).default('zh-CN'),
});

function publicId(): string {
  return `rpt_${randomBytes(9).toString('base64url')}`;
}

/**
 * Reports only expose data that already lives in the run record. They never
 * contain request headers, API keys, base URLs with credentials, or private
 * benchmark items the caller does not own — the mapper simply has no access to
 * those fields.
 */
reportsRouter.post('/reports', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'Invalid report payload', parsed.error.flatten());
    }
    const run = getRun(parsed.data.runId);
    if (!run) throw new ApiError('NOT_FOUND', 'Evaluation run not found');
    if (run.isDemo) {
      throw new ApiError(
        'FORBIDDEN',
        'Reports cannot be created from demo runs. Run a real evaluation first.',
      );
    }
    if (!['completed', 'partial-failure', 'failed', 'cancelled'].includes(run.status)) {
      throw new ApiError('CONFLICT', `Run is still ${run.status}; wait for it to finish before creating a report.`);
    }

    const existing = getRow<{ id: string; public_id: string }>(
      'SELECT id, public_id FROM reports WHERE run_id = ? ORDER BY created_at DESC LIMIT 1',
      run.id,
    );
    if (existing) {
      res.status(200).json({ report: mapReportFromId(existing.id), reused: true });
      return;
    }

    const id = newId();
    const now = nowIso();
    const pid = publicId();
    db.prepare(
      `INSERT INTO reports (id, public_id, run_id, visibility, title, summary, language, access_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      pid,
      run.id,
      parsed.data.visibility,
      parsed.data.title,
      parsed.data.summary,
      parsed.data.language,
      randomBytes(24).toString('base64url'),
      now,
    );

    res.status(201).json({ report: mapReportFromId(id), reused: false });
  } catch (err) {
    next(err);
  }
});

function mapReportFromId(id: string) {
  const row = getRow<{
    id: string;
    public_id: string;
    run_id: string;
    visibility: string;
    title: string;
    summary: string;
    language: string;
    access_token: string;
    created_at: string;
  }>('SELECT * FROM reports WHERE id = ?', id);
  if (!row) return null;
  return mapReport(row, true);
}

reportsRouter.get('/reports', (_req: Request, res: Response) => {
  const reports = listReports(100);
  res.json({ reports, total: reports.length });
});

/**
 * Public report fetch. Private reports require the `?token=` value issued at
 * creation time; the token is never listed in any collection endpoint.
 */
reportsRouter.get('/reports/:publicId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = getRow<{
      id: string;
      public_id: string;
      run_id: string;
      visibility: string;
      title: string;
      summary: string;
      language: string;
      access_token: string;
      created_at: string;
    }>('SELECT * FROM reports WHERE public_id = ?', req.params.publicId);
    if (!row) throw new ApiError('NOT_FOUND', 'Report not found');

    if (row.visibility === 'private') {
      const token = typeof req.query.token === 'string' ? req.query.token : null;
      const headerToken = req.header('x-report-token');
      const provided = token ?? headerToken;
      if (!provided || provided !== row.access_token) {
        throw new ApiError('FORBIDDEN', 'This report is private. A valid access link is required.');
      }
    }

    const run = getRun(row.run_id);
    const results = run ? listResults(run.id) : [];
    res.json({
      report: mapReport(row, true),
      results,
      shareToken: row.visibility === 'private' ? row.access_token : null,
    });
  } catch (err) {
    next(err);
  }
});

const patchSchema = z.object({
  visibility: z.enum(['public', 'private']).optional(),
  title: z.string().min(1).max(200).optional(),
  summary: z.string().max(4000).optional(),
});

reportsRouter.patch('/reports/:publicId', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'Invalid report update', parsed.error.flatten());
    }
    const row = getRow<{ id: string; visibility: string; access_token: string }>(
      'SELECT id, visibility, access_token FROM reports WHERE public_id = ?',
      req.params.publicId,
    );
    if (!row) throw new ApiError('NOT_FOUND', 'Report not found');

    // Private reports are token-protected; only a holder of the token may edit.
    const provided = (typeof req.query.token === 'string' ? req.query.token : null) ?? req.header('x-report-token');
    if (row.visibility === 'private' && provided !== row.access_token) {
      throw new ApiError('FORBIDDEN', 'A valid access token is required to modify this report.');
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    if (parsed.data.visibility) {
      updates.push('visibility = ?');
      values.push(parsed.data.visibility);
    }
    if (parsed.data.title) {
      updates.push('title = ?');
      values.push(parsed.data.title);
    }
    if (parsed.data.summary !== undefined) {
      updates.push('summary = ?');
      values.push(parsed.data.summary);
    }
    if (updates.length === 0) throw new ApiError('BAD_REQUEST', 'No fields to update');

    values.push(row.id);
    db.prepare(`UPDATE reports SET ${updates.join(', ')} WHERE id = ?`).run(...(values as never[]));

    res.json({ report: mapReportFromId(row.id) });
  } catch (err) {
    next(err);
  }
});

/**
 * Machine-readable export. JSON is the honest default: a PDF/DOCX renderer
 * would imply a fidelity we have not verified. The client formats the JSON
 * into a printable page instead.
 */
reportsRouter.get('/reports/:publicId/export', (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = getRow<{
      id: string;
      public_id: string;
      run_id: string;
      visibility: string;
      title: string;
      summary: string;
      language: string;
      access_token: string;
      created_at: string;
    }>('SELECT * FROM reports WHERE public_id = ?', req.params.publicId);
    if (!row) throw new ApiError('NOT_FOUND', 'Report not found');

    if (row.visibility === 'private') {
      const provided = (typeof req.query.token === 'string' ? req.query.token : null) ?? req.header('x-report-token');
      if (provided !== row.access_token) {
        throw new ApiError('FORBIDDEN', 'A valid access token is required to export this report.');
      }
    }

    const run = getRun(row.run_id);
    const results = run ? listResults(run.id) : [];

    const payload = {
      exportedAt: nowIso(),
      format: 'model-lab.report.v1',
      report: mapReport(row, false),
      run,
      results: results.map((r) => ({
        externalKey: r.externalKey,
        dimension: r.dimension,
        question: r.question,
        reference: r.reference,
        response: r.rawResponse,
        score: r.score,
        status: r.status,
        latencyMs: r.latencyMs,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        errorMessage: r.errorMessage,
      })),
      disclaimer:
        'Auto-generated by Model Intelligence Lab. Scores are observations under the recorded conditions; they are not proof of vendor intent or of capability change beyond the sampled items.',
    };

    res.setHeader('content-disposition', `attachment; filename="${row.public_id}.json"`);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.send(JSON.stringify(payload, null, 2));
  } catch (err) {
    next(err);
  }
});
