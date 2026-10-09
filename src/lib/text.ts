/** Normalise un texte pour la recherche : minuscules, sans accents, espaces réduits. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function matchesSearch(haystack: string, query: string): boolean {
  const q = normalizeText(query);
  if (q === '') return true;
  return normalizeText(haystack).includes(q);
}
