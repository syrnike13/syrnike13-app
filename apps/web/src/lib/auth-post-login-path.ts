export function postLoginPath(needsOnboarding: boolean) {
  return needsOnboarding ? '/login/onboard' : '/app'
}
