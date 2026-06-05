const SCROLLABLE_SELECTOR = [
  '[data-slot="scroll-area-viewport"]',
  '.scrollbar-minimal',
  '.scrollbar-overlay',
  '.overflow-y-auto',
  '.overflow-auto',
  '.overflow-x-auto',
  '.overflow-scroll',
].join(', ')

const HIDE_DELAY_MS = 900

const hideTimers = new WeakMap<HTMLElement, number>()

function onScroll(event: Event) {
  const target = event.target
  if (!(target instanceof HTMLElement)) return
  if (!target.matches(SCROLLABLE_SELECTOR)) return

  target.dataset.scrolling = 'true'

  const previous = hideTimers.get(target)
  if (previous !== undefined) {
    window.clearTimeout(previous)
  }

  hideTimers.set(
    target,
    window.setTimeout(() => {
      delete target.dataset.scrolling
      hideTimers.delete(target)
    }, HIDE_DELAY_MS),
  )
}

export function setupNativeOverlayScrollbars(): () => void {
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  return () => document.removeEventListener('scroll', onScroll, { capture: true })
}
