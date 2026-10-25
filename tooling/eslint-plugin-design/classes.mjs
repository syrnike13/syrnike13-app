// Tailwind class parsing shared by the design rules.

/** Utilities a call site may put on a primitive: placement, flow and a text colour token. */
const PLACEMENT = [
  /^-?(?:m|mx|my|mt|mr|mb|ml|ms|me)-/,
  /^(?:w|min-w|max-w|max-h)-/,
  /^(?:h|min-h|size)-(?:full|auto|fit|min|max|screen|svh|dvh|lvh|0)$/,
  /^(?:flex-(?:1|auto|initial|none)|grow|grow-0|shrink|shrink-0)$/,
  /^(?:basis|self|justify-self|place-self|order|col|row|grid-cols|grid-rows|grid-flow)-/,
  /^(?:static|relative|absolute|fixed|sticky|isolate|isolation-auto)$/,
  /^-?(?:inset|inset-x|inset-y|top|right|bottom|left|start|end|z|translate-x|translate-y)-/,
  /^(?:hidden|block|inline|inline-block|inline-flex|flex|grid|inline-grid|contents|flow-root)$/,
  /^flex-(?:row|col|row-reverse|col-reverse|wrap|nowrap|wrap-reverse)$/,
  /^(?:items|justify|content|place-items|place-content)-/,
  /^(?:gap|gap-x|gap-y|space-x|space-y)-/,
  // Zero padding hands the spacing to the content (edge-to-edge lists, media).
  /^(?:p|px|py|pt|pb|pl|pr)-0$/,
  /^(?:sr-only|not-sr-only|invisible|visible)$/,
  /^(?:truncate|whitespace-.+|break-.+|line-clamp-.+|hyphens-.+)$/,
  /^text-(?:wrap|nowrap|balance|pretty|ellipsis|clip|left|center|right|justify|start|end)$/,
  /^(?:opacity|transition|duration|ease|delay|animate)(?:-|$)/,
  /^(?:pointer-events|cursor|select|touch|scroll|snap|overscroll|will-change|resize)-/,
  /^(?:overflow|overflow-x|overflow-y|object|origin|aspect|contain)-/,
  /^(?:group|peer)(?:\/[\w-]+)?$/,
  /^(?:underline|no-underline)$/,
  /^underline-offset-/,
  // Monospace marks the content (codes, IDs, paths), not the component look.
  /^font-mono$/,
  // Electron window-drag regions are behaviour, not look.
  /^shell-title-bar-(?:no-)?drag$/,
]

/**
 * Primitives whose geometry is the call site's choice: a spinner is sized like
 * an icon and a skeleton takes the shape of the content it stands in for.
 */
const FREE_GEOMETRY = {
  Spinner: [/^size-/],
  // How tall a multi-line field starts depends on the text it expects.
  Textarea: [/^min-h-/],
  // A divider or a vertical slider is as long as the row it sits in.
  Separator: [/^(?:h|w)-/],
  Slider: [/^(?:h|w)-/],
  // Overlays are as tall as the content they hold.
  DialogContent: [/^(?:h|min-h)-/],
  PopoverContent: [/^(?:h|min-h)-/],
  DrawerContent: [/^(?:h|min-h)-/],
  Skeleton: [/^(?:h|size)-/, /^rounded(?:-|$)/],
}

/** True when `primitive` lets call sites set this class. */
export function isFreeGeometryClass(primitive, token) {
  const utility = utilityOf(token)
  return (FREE_GEOMETRY[primitive] ?? []).some((pattern) => pattern.test(utility))
}

const TEXT_SIZE = /^text-(?:\d*x[sl]|sm|base|lg|\[)/

/** `text-<token>` that names a colour, not a size or alignment. */
function isTextColor(utility) {
  // `text-(--author-color)` reads an API-provided colour through a CSS variable.
  if (/^text-\(--[\w-]+\)$/.test(utility)) return true
  return /^text-[a-z]/.test(utility) && !TEXT_SIZE.test(utility)
}

/** Splits `md:hover:bg-x/50!` into its utility `bg-x/50`, ignoring `:` inside brackets. */
export function utilityOf(token) {
  let depth = 0
  let start = 0
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index]
    if (char === '[' || char === '(') depth += 1
    else if (char === ']' || char === ')') depth -= 1
    else if (char === ':' && depth === 0) start = index + 1
  }
  return token.slice(start).replace(/^!/, '').replace(/!$/, '')
}

/** True when the class only places the element or sets a text colour. */
export function isPlacementClass(token) {
  const utility = utilityOf(token)
  return isTextColor(utility) || PLACEMENT.some((pattern) => pattern.test(utility))
}

export function splitClasses(value) {
  return value.split(/\s+/).filter(Boolean)
}

/**
 * Static class strings inside a className-like expression. `variants` reports
 * whether a `*Variants(...)` call (cva output) is part of the expression.
 */
export function collectClasses(node, mergeFunctions, result = { strings: [], variants: false }) {
  if (!node) return result
  switch (node.type) {
    case 'Literal':
      if (typeof node.value === 'string') result.strings.push({ value: node.value, node })
      break
    case 'TemplateLiteral':
      for (const quasi of node.quasis) result.strings.push({ value: quasi.value.cooked ?? '', node })
      for (const expression of node.expressions) collectClasses(expression, mergeFunctions, result)
      break
    case 'JSXExpressionContainer':
      collectClasses(node.expression, mergeFunctions, result)
      break
    case 'ConditionalExpression':
      collectClasses(node.consequent, mergeFunctions, result)
      collectClasses(node.alternate, mergeFunctions, result)
      break
    case 'LogicalExpression':
      collectClasses(node.left, mergeFunctions, result)
      collectClasses(node.right, mergeFunctions, result)
      break
    case 'ArrayExpression':
      for (const element of node.elements) collectClasses(element, mergeFunctions, result)
      break
    case 'ObjectExpression':
      for (const property of node.properties) {
        if (property.type !== 'Property') continue
        if (property.key.type === 'Literal') collectClasses(property.key, mergeFunctions, result)
      }
      break
    case 'CallExpression': {
      const callee = node.callee.type === 'Identifier' ? node.callee.name : null
      if (callee && /Variants$/.test(callee)) {
        result.variants = true
        // `buttonVariants({ variant, className: '…' })` still carries call-site classes.
        for (const argument of node.arguments) {
          if (argument.type !== 'ObjectExpression') continue
          for (const property of argument.properties) {
            if (property.type === 'Property' && property.key.name === 'className') {
              collectClasses(property.value, mergeFunctions, result)
            }
          }
        }
      } else if (callee && mergeFunctions.includes(callee)) {
        for (const argument of node.arguments) collectClasses(argument, mergeFunctions, result)
      }
      break
    }
    default:
      break
  }
  return result
}
