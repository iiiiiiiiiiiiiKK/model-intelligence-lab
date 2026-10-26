/**
 * Catalog API: browse the imported model catalog, import/refresh it, and
 * register a catalog entry as a callable model on a provider.
 *
 * Two rules this surface enforces:
 *   1. External reference scores are read-only and always carry their source and
 *      observation date. They are never blended into this project's scores.
 *   2. Importing requires an outbound request to a public host, so the same SSRF
 *      guard and an explicit user action are required. No silent background
 *      refresh.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../errors';
import { getProvider } from '../db/mappers';
import { importCatalog, listCatalog, registerCatalogModel, SOURCE_URL, ensureCatalogSchema } from '../catalog/import';

export const catalogRouter = Router();

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

catalogRouter.get('/catalog', (req: Request, res: Response, next: NextFunction) => {
  try {
    const vendor = typeof req.query.vendor === 'string' ? req.query.vendor : undefined;
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;

    const { models, vendors, lastImport } = listCatalog({ vendor, search, limit });

    res.json({
      models,
      vendors,
      lastImport,
      source: {
        id: 'openrouter',
        url: SOURCE_URL,
        // Said plainly, because it is the single most important caveat here.
        disclaimer:
          'Arena Elo and Artificial Analysis indices are published by third parties using their own harness. They are not reproducible from this repository and are never merged into this project’s own evaluation scores, rankings or regression detection.',
      },
      total: models.length,
    });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// import / refresh
// ---------------------------------------------------------------------------

catalogRouter.post('/catalog/import', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    ensureCatalogSchema();
    const result = await importCatalog();
    res.status(result.ok ? 200 : 502).json({ result });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// register a catalog model as a callable model
// ---------------------------------------------------------------------------

const registerSchema = z.object({
  providerId: z.string().min(1),
});

catalogRouter.post('/catalog/:catalogId/register', (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_FAILED', 'providerId is required', parsed.error.flatten());
    }
    const provider = getProvider(parsed.data.providerId);
    if (!provider) throw new ApiError('NOT_FOUND', 'Provider not found');

    const catalogId = decodeURIComponent(req.params.catalogId);
    const { created, modelId } = registerCatalogModel(catalogId, provider.id);
    if (!modelId) {
      throw new ApiError('NOT_FOUND', 'Catalog entry not found. Import the catalog first.');
    }

    res.status(created ? 201 : 200).json({ created, modelId });
  } catch (error) {
    next(error);
  }
});
