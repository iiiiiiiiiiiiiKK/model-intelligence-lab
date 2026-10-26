import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { db, newId, nowIso, getRow, getRows } from '../db';
import { ApiError } from '../errors';
import type { CommunitySubmission } from '../../shared/types';

export const communityRouter = Router();

/**
 * The first version of the community page is deliberately lightweight: public
 * reports are listed, and item suggestions are queued for review. Nothing
 * submitted by a user ever enters the official benchmark without going through
 * `status = 'approved'`, so a spam submission cannot pollute scores.
 */
communityRouter.get('/community', (_req: Request, res: Response, next: NextFunction) => {
  try {
    const submissions = getRows<{
      id: string;
      kind: string;
      title: string;
      body: string;
      dimension: string | null;
      reference: string | null;
      author: string;
      status: string;
      review_note: string | null;
      created_at: string;
      reviewed_at: string | null;
    }>('SELECT * FROM community_submissions ORDER BY created_at DESC LIMIT 100').map(mapSubmission);

    const publicReports = getRows<{
      id: string;
      public_id: string;
      run_id: string;
      title: string;
      summary: string;
      language: string;
      created_at: string;
    }>("SELECT * FROM reports WHERE visibility = 'public' ORDER BY created_at DESC LIMIT 50").map((row) => ({
      publicId: row.public_id,
      runId: row.run_id,
      title: row.title,
      summary: row.summary,
      language: row.language,
      createdAt: row.created_at,
    }));

    res.json({ submissions, publicReports });
  } catch (err) {
    next(err);
  }
});

const submissionSchema = z.object({
  kind: z.enum(['item', 'report', 'note']).default('item'),
  title: z.string().min(3).max(200),
  body: z.string().min(3).max(8000),
  dimension: z
    .enum(['reasoning', 'coding', 'instruction-following', 'factuality', 'stability', 'behavior'])
    .nullable()
    .optional(),
  reference: z.string().max(4000).nullable().optional(),
  author: z.string().max(80).optional(),
});

communityRouter.post('/community/submissions', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = submissionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'Invalid submission', parsed.error.flatten());
    }
    const id = newId();
    const now = nowIso();
    db.prepare(
      `INSERT INTO community_submissions (id, kind, title, body, dimension, reference, author, status, review_note, created_at, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
    ).run(
      id,
      parsed.data.kind,
      parsed.data.title,
      parsed.data.body,
      parsed.data.dimension ?? null,
      parsed.data.reference ?? null,
      parsed.data.author?.trim() || 'anonymous',
      now,
    );

    res.status(201).json({
      submission: mapSubmission(
        getRow<{
          id: string;
          kind: string;
          title: string;
          body: string;
          dimension: string | null;
          reference: string | null;
          author: string;
          status: string;
          review_note: string | null;
          created_at: string;
          reviewed_at: string | null;
        }>('SELECT * FROM community_submissions WHERE id = ?', id)!,
      ),
      note: 'Submission received and queued for review. It is not part of any benchmark until approved.',
    });
  } catch (err) {
    next(err);
  }
});

const reviewSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  reviewNote: z.string().max(1000).optional(),
});

/**
 * Review action. There is no user account system in this build, so review is
 * gated by a shared admin token that must match `X-Admin-Token`; without the
 * token the endpoint refuses. This is intentionally simple but real: it is not
 * a pretend permission check.
 */
communityRouter.post('/community/submissions/:id/review', (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken) {
      throw new ApiError(
        'FORBIDDEN',
        'Review is disabled: no ADMIN_TOKEN is configured on the server. Set ADMIN_TOKEN to enable moderation.',
      );
    }
    if (req.header('x-admin-token') !== adminToken) {
      throw new ApiError('FORBIDDEN', 'A valid admin token is required to review submissions.');
    }

    const parsed = reviewSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'Invalid review payload', parsed.error.flatten());
    }
    const row = getRow<{ id: string }>('SELECT id FROM community_submissions WHERE id = ?', req.params.id);
    if (!row) throw new ApiError('NOT_FOUND', 'Submission not found');

    db.prepare(
      'UPDATE community_submissions SET status = ?, review_note = ?, reviewed_at = ? WHERE id = ?',
    ).run(parsed.data.status, parsed.data.reviewNote ?? null, nowIso(), row.id);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

function mapSubmission(row: {
  id: string;
  kind: string;
  title: string;
  body: string;
  dimension: string | null;
  reference: string | null;
  author: string;
  status: string;
  review_note: string | null;
  created_at: string;
  reviewed_at: string | null;
}): CommunitySubmission {
  return {
    id: row.id,
    kind: row.kind as CommunitySubmission['kind'],
    title: row.title,
    body: row.body,
    dimension: (row.dimension as CommunitySubmission['dimension']) ?? null,
    reference: row.reference,
    author: row.author,
    status: row.status as CommunitySubmission['status'],
    reviewNote: row.review_note,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
  };
}
