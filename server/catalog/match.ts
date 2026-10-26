/**
 * Matching a locally registered model to its row in the external catalog.
 *
 * Provider slugs differ (`deepseek-chat` vs `deepseek/deepseek-v4.1-flash`), and
 * catalog names carry vendor prefixes ("Anthropic: Claude Sonnet 5.5"). A wrong
 * match would show a user someone else's score for the model they are looking at,
 * which is worse than showing nothing — so the matcher is deliberately strict and
 * returns null when it is not confident.
 */

export interface CatalogIndexEntry {
  modelRef: string;
  vendor: string;
  name: string;
}

/** Lowercases and strips vendor prefixes, provider-decoration and separators. */
export function normalizeModelName(value: string): string {
  let out = value.toLowerCase().trim();
  // Drop a leading "vendor: " label ("Anthropic: Claude Sonnet 5.5").
  out = out.replace(/^[a-z0-9 ._-]+:\s+/, '');
  // Drop a leading "vendor/" slug prefix.
  if (out.includes('/')) out = out.split('/').slice(1).join('/');
  // Drop common version decorations that make otherwise identical names differ.
  out = out.replace(/[:@].*$/, '');
  out = out.replace(/\b(latest|preview|beta|alpha|rc\d*)\b/g, '');
  out = out.replace(/[^a-z0-9]+/g, '');
  return out;
}

/**
 * Finds the catalog entry for a locally registered model id.
 *
 * Strategy, strictest first:
 *   1. exact `vendor/model-id` reference,
 *   2. exact suffix match (`claude-sonnet-5-5` == `claude-sonnet-5.5`),
 *   3. exact normalized match ignoring prefixes and punctuation.
 *
 * Steps 2 and 3 must be unambiguous: if two catalog rows match equally well,
 * nothing is returned. Guessing there would show a user the wrong model's score.
 */
export function matchCatalogEntry(
  localModelId: string,
  index: CatalogIndexEntry[],
): CatalogIndexEntry | null {
  const trimmed = localModelId.trim().toLowerCase();
  if (!trimmed) return null;

  const exact = index.filter((entry) => entry.modelRef.toLowerCase() === trimmed);
  if (exact.length === 1) return exact[0];
  // A duplicated exact reference is itself ambiguous.
  if (exact.length > 1) return null;

  const suffixMatches = index.filter((entry) => {
    const slug = entry.modelRef.toLowerCase();
    const bare = slug.split('/').slice(1).join('/');
    if (!bare) return false;
    return bare === trimmed || slug.endsWith(`/${trimmed}`);
  });
  if (suffixMatches.length === 1) return suffixMatches[0];
  if (suffixMatches.length > 1) return null;

  const target = normalizeModelName(localModelId);
  if (target.length < 4) return null;

  const normalized = index.filter(
    (entry) => normalizeModelName(entry.modelRef.split('/').slice(1).join('/')) === target,
  );

  // More than one equally good match is ambiguous: show nothing.
  if (normalized.length === 1) return normalized[0];
  return null;
}
