// Same rule as private.normalize_name() in the SQL migration:
// NFKC, lower case, no whitespace, katakana -> hiragana.
export function normalizeName(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[ァ-ヴ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
}

export function isSimilarName(a: string, b: string): boolean {
  const x = normalizeName(a)
  const y = normalizeName(b)
  if (!x || !y) return false
  if (x === y) return true
  return (x.length >= 2 && y.includes(x)) || (y.length >= 2 && x.includes(y))
}
