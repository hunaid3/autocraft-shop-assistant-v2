/**
 * Item name matching, ported from Code.gs matchItemIn_.
 * Order: exact name/alias → all query words present → unique contains → best token overlap.
 * normKey matches app.norm_key() in SQL (letters and digits of any script, lower-cased).
 */

export interface MatchableItem {
  id: string;
  name: string;
  aliases?: string[];
}

export interface MatchResult<T extends MatchableItem> {
  match: T | null;
  candidates: T[];
}

// Letters, digits, and the Indian-script blocks whole (keeps vowel signs and virama).
// Must stay identical to app.norm_key() in supabase/migrations/..._foundation.sql.
const NOT_KEY_CHAR = /[^\p{L}\p{N}ऀ-෿]+/gu;
const DANDA = /[।॥]/g;

export function normKey(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().replace(NOT_KEY_CHAR, '').replace(DANDA, '');
}

export function tokens(s: string | null | undefined): string[] {
  return String(s ?? '').toLowerCase().replace(DANDA, ' ').split(NOT_KEY_CHAR).filter((t) => t.length > 0);
}

function keysOf(it: MatchableItem): string[] {
  return [it.name, ...(it.aliases ?? [])].map(normKey).filter(Boolean);
}

export function matchItem<T extends MatchableItem>(query: string, items: readonly T[]): MatchResult<T> {
  const q = normKey(query);
  if (!q) return { match: null, candidates: [] };

  const exact = items.filter((it) => keysOf(it).includes(q));
  if (exact.length === 1) return { match: exact[0]!, candidates: [] };

  const qWords = tokens(query);
  const allWords = items.filter((it) => {
    const t = tokens([it.name, ...(it.aliases ?? [])].join(' '));
    return qWords.every((w) => t.includes(w));
  });
  if (allWords.length === 1) return { match: allWords[0]!, candidates: [] };

  const contains = items.filter((it) => keysOf(it).some((k) => k.includes(q) || q.includes(k)));
  if (contains.length === 1) return { match: contains[0]!, candidates: [] };

  const scored = items
    .map((it) => {
      const best = [it.name, ...(it.aliases ?? [])].reduce((b, k) => {
        const t = tokens(k);
        if (!t.length) return b;
        const hit = qWords.filter((x) =>
          t.some((y) => y === x || (x.length > 2 && y.startsWith(x)) || (y.length > 2 && x.startsWith(y)))
        ).length;
        return Math.max(b, hit / Math.max(qWords.length, t.length));
      }, 0);
      return { it, score: best };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const second = scored[1];
  if (top && top.score >= 0.5 && (!second || top.score - second.score >= 0.2)) return { match: top.it, candidates: [] };

  const pool = (contains.length > 1 ? contains : scored.map((s) => s.it)).slice(0, 5);
  return { match: null, candidates: pool };
}
