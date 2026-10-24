type Child = Node | string | number | null | undefined | false
type Props = Record<string, unknown> & { class?: string }

/** Tiny element factory: `on*` props become listeners, the rest DOM properties. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue
    if (key === 'class') element.className = String(value)
    else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    } else if (key in element) (element as unknown as Record<string, unknown>)[key] = value
    else element.setAttribute(key, String(value))
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    element.append(child instanceof Node ? child : String(child))
  }
  return element
}
