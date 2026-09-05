/** Requirements apply to the lab's animated fixtures, not arbitrary user screens. */
export function videoContentChanged(previous: readonly number[], current: readonly number[]): boolean {
  if (previous.length !== 64 || current.length !== 64) return false
  // Small codec reconstruction differences are not proof of moving content.
  return current.filter((value, index) => Math.abs(value - previous[index]!) >= 16).length >= 2
}

export function screenEvidenceAccepted(
  contentChanges: number,
  resolutionTransitions: number,
  minimumContentChanges: number,
  minimumResolutionTransitions: number,
): boolean {
  return contentChanges >= minimumContentChanges &&
    resolutionTransitions >= minimumResolutionTransitions
}
