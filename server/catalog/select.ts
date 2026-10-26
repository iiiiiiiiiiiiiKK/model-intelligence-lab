/**
 * Curated catalog selection.
 *
 * Turns the OpenRouter model dump (467 entries) into a browsable list of roughly
 * 120 mainstream chat models. The rules are deliberately conservative:
 *
 *   - only models whose output includes text (this is a chat/reasoning lab);
 *   - drop deployment variants (`:batch`, `:free`, `:thinking`, `:online`, …),
 *     which are the same weights billed differently and would triple the list;
 *   - keep a fixed allow-list of vendors, each with a per-vendor cap, so the list
 *     reflects what people actually choose between instead of vendor noise;
 *   - inside a vendor, prefer models that a third party has actually scored
 *     (Arena Elo or an Artificial Analysis index), then newer ones.
 *
 * The selection is pure and deterministic given the same input, so it can be
 * unit-tested and diffed.
 */

export interface CatalogEntry {
  /** OpenRouter model id, e.g. `anthropic/claude-sonnet-5.5`. */
  id: string;
  /** Human name from the catalog. */
  name: string;
  /** Vendor slug from the id prefix. */
  vendor: string;
  contextLength: number | null;
  /** USD per 1M input tokens, or null when the catalog omits pricing. */
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  createdAt: string | null;
  /** Reference scores, if a third party published them. */
  arenaElo: number | null;
  arenaCategories: Array<{ category: string; elo: number; rank: number | null }>;
  aaIntelligenceIndex: number | null;
  aaCodingIndex: number | null;
  aaAgenticIndex: number | null;
  /** Input modalities, e.g. `["text", "image"]`. */
  inputModalities: string[];
  description: string;
  huggingFaceId: string | null;
}

/**
 * Vendors worth showing, with a cap on how many models each contributes.
 * Ordered by how often they appear in real selection decisions.
 */
export const VENDOR_CAPS: Array<{ vendor: string; cap: number }> = [
  { vendor: 'openai', cap: 12 },
  { vendor: 'anthropic', cap: 10 },
  { vendor: 'google', cap: 12 },
  { vendor: 'deepseek', cap: 8 },
  { vendor: 'qwen', cap: 10 },
  { vendor: 'moonshotai', cap: 6 },
  { vendor: 'z-ai', cap: 6 },
  { vendor: 'x-ai', cap: 6 },
  { vendor: 'mistralai', cap: 8 },
  { vendor: 'meta-llama', cap: 6 },
  { vendor: 'minimax', cap: 5 },
  { vendor: 'nvidia', cap: 4 },
  { vendor: 'bytedance-seed', cap: 4 },
  { vendor: 'tencent', cap: 4 },
  { vendor: 'amazon', cap: 4 },
  { vendor: 'cohere', cap: 3 },
  { vendor: 'ai21', cap: 3 },
  { vendor: 'perplexity', cap: 3 },
  { vendor: 'microsoft', cap: 3 },
  { vendor: 'ibm-granite', cap: 3 },
  { vendor: 'stepfun', cap: 3 },
  { vendor: 'upstage', cap: 3 },
  { vendor: 'sakana', cap: 2 },
  { vendor: 'inclusionai', cap: 3 },
  { vendor: 'xiaomi', cap: 3 },
];

const VARIANT_SUFFIX = /:(batch|free|extended|thinking|online|nitro|floor|auto)$/;

/** Vendor prefixes that only mirror another vendor's model. */
const MIRROR_PREFIXES = new Set(['~openai', '~anthropic', '~google', '~deepseek', '~z-ai', '~x-ai', '~moonshotai', '~unbiased']);

export function isChatModel(entry: {
  architecture?: { output_modalities?: string[] };
}): boolean {
  const outputs = entry.architecture?.output_modalities;
  return Array.isArray(outputs) ? outputs.includes('text') : true;
}

export function isVariant(id: string): boolean {
  return VARIANT_SUFFIX.test(id);
}

export function vendorOf(id: string): string {
  return id.includes('/') ? id.split('/')[0] : 'other';
}

function pricePerMillion(value: string | undefined): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  // OpenRouter publishes USD per single token.
  return Number((parsed * 1_000_000).toFixed(6));
}

interface RawModel {
  id?: string;
  name?: string;
  created?: number;
  description?: string;
  hugging_face_id?: string | null;
  context_length?: number | null;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: { prompt?: string; completion?: string };
  benchmarks?: {
    design_arena?: Array<{ arena?: string; category?: string; elo?: number; rank?: number }>;
    artificial_analysis?: {
      intelligence_index?: number | null;
      coding_index?: number | null;
      agentic_index?: number | null;
    };
  };
}

/** Normalizes one raw catalog row into the shape the importer stores. */
export function toCatalogEntry(raw: RawModel): CatalogEntry | null {
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;

  const arena = Array.isArray(raw.benchmarks?.design_arena) ? raw.benchmarks!.design_arena : [];
  const arenaCategories = arena
    .filter((entry) => typeof entry.elo === 'number' && Number.isFinite(entry.elo))
    .map((entry) => ({
      category: String(entry.category ?? entry.arena ?? 'overall'),
      elo: Number(entry.elo),
      rank: typeof entry.rank === 'number' ? entry.rank : null,
    }));
  // `models`/`overall` is the general text arena; fall back to the best category.
  const general = arena.find((entry) => entry.arena === 'models' && entry.category === 'overall')
    ?? arena.find((entry) => entry.category === 'overall' && entry.arena === 'models');
  const arenaElo =
    typeof general?.elo === 'number'
      ? general.elo
      : arenaCategories.length > 0
        ? Math.max(...arenaCategories.map((entry) => entry.elo))
        : null;

  const aa = raw.benchmarks?.artificial_analysis;

  return {
    id,
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : id,
    vendor: vendorOf(id),
    contextLength: typeof raw.context_length === 'number' ? raw.context_length : null,
    inputPerMillion: pricePerMillion(raw.pricing?.prompt),
    outputPerMillion: pricePerMillion(raw.pricing?.completion),
    createdAt:
      typeof raw.created === 'number' ? new Date(raw.created * 1000).toISOString() : null,
    arenaElo,
    arenaCategories,
    aaIntelligenceIndex:
      typeof aa?.intelligence_index === 'number' ? aa.intelligence_index : null,
    aaCodingIndex: typeof aa?.coding_index === 'number' ? aa.coding_index : null,
    aaAgenticIndex: typeof aa?.agentic_index === 'number' ? aa.agentic_index : null,
    inputModalities: Array.isArray(raw.architecture?.input_modalities)
      ? raw.architecture!.input_modalities!
      : ['text'],
    description: typeof raw.description === 'string' ? raw.description.slice(0, 600) : '',
    huggingFaceId: raw.hugging_face_id ?? null,
  };
}

/**
 * Scores an entry for ranking inside its vendor. Higher is better.
 * Third-party evidence dominates; recency only breaks ties.
 */
export function rankScore(entry: CatalogEntry): number {
  const aa = entry.aaIntelligenceIndex ?? 0;
  const elo = entry.arenaElo !== null ? (entry.arenaElo - 1000) / 10 : 0;
  const recency = entry.createdAt
    ? new Date(entry.createdAt).getTime() / (1000 * 60 * 60 * 24 * 365) // years since epoch
    : 0;
  return aa * 2 + elo + recency * 0.05;
}

/** Selects the curated list from a raw OpenRouter payload. */
export function selectCatalog(payload: {
  data?: RawModel[];
}): { selected: CatalogEntry[]; skipped: { variants: number; nonChat: number; mirror: number } } {
  const rows = Array.isArray(payload.data) ? payload.data : [];

  let nonChat = 0;
  let variants = 0;
  let mirror = 0;

  const byVendor = new Map<string, CatalogEntry[]>();

  for (const raw of rows) {
    if (!isChatModel(raw)) {
      nonChat += 1;
      continue;
    }
    const id = String(raw.id ?? '');
    if (isVariant(id)) {
      variants += 1;
      continue;
    }
    const vendor = vendorOf(id);
    if (MIRROR_PREFIXES.has(vendor)) {
      mirror += 1;
      continue;
    }
    const cap = VENDOR_CAPS.find((entry) => entry.vendor === vendor);
    if (!cap) continue;

    const entry = toCatalogEntry(raw);
    if (!entry) continue;
    const list = byVendor.get(vendor) ?? [];
    list.push(entry);
    byVendor.set(vendor, list);
  }

  const selected: CatalogEntry[] = [];
  for (const { vendor, cap } of VENDOR_CAPS) {
    const list = byVendor.get(vendor) ?? [];
    list.sort((a, b) => rankScore(b) - rankScore(a));
    selected.push(...list.slice(0, cap));
  }

  // Stable, readable ordering: vendor block order, then rank.
  selected.sort((a, b) => {
    const ai = VENDOR_CAPS.findIndex((entry) => entry.vendor === a.vendor);
    const bi = VENDOR_CAPS.findIndex((entry) => entry.vendor === b.vendor);
    if (ai !== bi) return ai - bi;
    return rankScore(b) - rankScore(a);
  });

  return { selected, skipped: { variants, nonChat, mirror } };
}
