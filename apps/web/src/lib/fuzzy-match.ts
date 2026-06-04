export function matchScore(haystack: string, needle: string): number {
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase().trim()
  if (!n) return 1
  if (h === n) return 200
  if (h.startsWith(n)) return 150
  const index = h.indexOf(n)
  if (index >= 0) return 120 - index
  for (const word of h.split(/\s+/)) {
    if (word.startsWith(n)) return 90
  }
  return 0
}

export function matchesQuery(haystack: string, needle: string): boolean {
  return matchScore(haystack, needle) > 0
}
