// Design-system lint rules. Goal: screens are assembled from
// @syrnike13/ui primitives and never restyle them; a different look is a
// variant or size in packages/ui. Policy: packages/ui/AGENTS.md.

import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { collectClasses, isFreeGeometryClass, isPlacementClass, splitClasses } from './classes.mjs'
import { loadSurfacedPrimitives } from './primitives.mjs'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const DEFAULT_PRIMITIVES_DIR = join(ROOT, 'packages', 'ui', 'src', 'primitives')
const MERGE_FUNCTIONS = ['cn', 'clsx', 'cx']
const POLICY = 'packages/ui/AGENTS.md'

const primitiveCache = new Map()
function surfacedPrimitives(dir) {
  if (!primitiveCache.has(dir)) primitiveCache.set(dir, loadSurfacedPrimitives(dir))
  return primitiveCache.get(dir)
}

function elementName(name) {
  if (name.type === 'JSXIdentifier') return name.name
  if (name.type === 'JSXMemberExpression') return elementName(name.property)
  return null
}

function attribute(opening, name) {
  return opening.attributes.find(
    (attr) => attr.type === 'JSXAttribute' && attr.name.name === name,
  )
}

/** Classes on `className` that go beyond placement, plus whether a `*Variants()` recipe is used. */
function restylingClasses(opening, primitive) {
  const classAttr = attribute(opening, 'className')
  if (!classAttr?.value) return { classes: [], variants: false }
  const { strings, variants } = collectClasses(classAttr.value, MERGE_FUNCTIONS)
  const classes = strings
    .flatMap(({ value }) => splitClasses(value))
    .filter((token) => !isPlacementClass(token))
    .filter((token) => !primitive || !isFreeGeometryClass(primitive, token))
  return { classes: [...new Set(classes)], variants }
}

const noRestyle = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow call-site styling of primitives that own their surface' },
    schema: [
      {
        type: 'object',
        properties: { primitivesDir: { type: 'string' } },
        additionalProperties: false,
      },
    ],
    messages: {
      primitive:
        '<{{name}}> owns its look; "{{classes}}" restyles it. Add or use a variant/size in packages/ui/src/primitives/{{folder}}. className may only place the component (margin, width, flex/grid/position) or set a text colour token. Policy: ' +
        POLICY,
      recipe:
        '"{{classes}}" restyles a *Variants() recipe. Use one of its variants/sizes or add one in packages/ui. Policy: ' +
        POLICY,
    },
  },
  create(context) {
    const dir = context.options[0]?.primitivesDir ?? DEFAULT_PRIMITIVES_DIR
    const modules = surfacedPrimitives(dir)
    /** local JSX name → { name, folder } */
    const imported = new Map()

    function checkPrimitive(opening, primitive) {
      const { classes } = restylingClasses(opening, primitive.name)
      if (classes.length > 0) {
        context.report({
          node: opening,
          messageId: 'primitive',
          data: { name: primitive.name, classes: classes.join(' '), folder: primitive.folder },
        })
      }
      // `render={<a className="…" />}` merges its classes into the primitive.
      const render = attribute(opening, 'render')
      const rendered = render?.value?.expression
      if (rendered?.type === 'JSXElement') {
        const inner = restylingClasses(rendered.openingElement)
        if (inner.classes.length > 0 && !inner.variants) {
          context.report({
            node: rendered.openingElement,
            messageId: 'primitive',
            data: { name: primitive.name, classes: inner.classes.join(' '), folder: primitive.folder },
          })
        }
      }
    }

    return {
      ImportDeclaration(node) {
        const surfaced = modules.get(node.source.value)
        if (!surfaced) return
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier') continue
          const name = specifier.imported.name
          const folder = surfaced.get(name)
          if (folder) imported.set(specifier.local.name, { name, folder })
        }
      },
      JSXOpeningElement(opening) {
        const name = elementName(opening.name)
        const primitive = name ? imported.get(name) : undefined
        if (primitive) {
          checkPrimitive(opening, primitive)
          return
        }
        const { classes, variants } = restylingClasses(opening)
        if (variants && classes.length > 0) {
          context.report({ node: opening, messageId: 'recipe', data: { classes: classes.join(' ') } })
        }
      },
    }
  },
}

const INTERACTIVE_HANDLERS = ['onClick', 'onKeyDown', 'onKeyUp', 'onPointerDown', 'onMouseDown']
const INPUT_PRIMITIVE = {
  checkbox: 'Checkbox',
  radio: 'RadioGroup',
  range: 'PresetSlider (settings) or Slider',
}

function isRenderProp(node) {
  // `render={<a />}`, also behind `cond ? <a /> : undefined` or `cond && <a />`.
  let parent = node.parent?.parent
  while (parent?.type === 'ConditionalExpression' || parent?.type === 'LogicalExpression') {
    parent = parent.parent
  }
  return (
    parent?.type === 'JSXExpressionContainer' &&
    parent.parent?.type === 'JSXAttribute' &&
    parent.parent.name.name === 'render'
  )
}

function literalAttribute(opening, name) {
  const value = attribute(opening, name)?.value
  return value?.type === 'Literal' ? value.value : undefined
}

const noLookalike = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow hand-built copies of primitives' },
    schema: [],
    messages: {
      element:
        'Raw <{{tag}}>: use {{primitive}} from @syrnike13/ui/primitives (for links and triggers pass the element through `render`). Policy: ' +
        POLICY,
      interactive:
        '<{{tag}}> with {{handler}} is a hand-built control: use Button (or the matching primitive) so focus, hover and keyboard come from the design system. Policy: ' +
        POLICY,
      link:
        'Styled <a> ("{{classes}}"): style links with buttonVariants(...) or render them through a primitive. Policy: ' +
        POLICY,
    },
  },
  create(context) {
    return {
      JSXOpeningElement(opening) {
        if (opening.name.type !== 'JSXIdentifier') return
        const tag = opening.name.name
        if (!/^[a-z]/.test(tag)) return
        // `render={<button />}` hands a bare element to a primitive, which owns its look;
        // a styled one is a hand-built control dressed up as that primitive.
        if (isRenderProp(opening) && restylingClasses(opening).classes.length === 0) return

        if (tag === 'button') {
          context.report({ node: opening, messageId: 'element', data: { tag, primitive: 'Button' } })
          return
        }
        if (tag === 'input') {
          const type = literalAttribute(opening, 'type') ?? 'text'
          if (type === 'hidden' || type === 'file') return
          const primitive = INPUT_PRIMITIVE[type] ?? 'Input'
          context.report({ node: opening, messageId: 'element', data: { tag, primitive } })
          return
        }
        if (tag === 'textarea') {
          context.report({ node: opening, messageId: 'element', data: { tag, primitive: 'Textarea' } })
          return
        }
        if (tag === 'select') {
          context.report({ node: opening, messageId: 'element', data: { tag, primitive: 'Select or NativeSelect' } })
          return
        }
        if (tag === 'a') {
          if (isRenderProp(opening)) return
          const { classes, variants } = restylingClasses(opening)
          if (!variants && classes.length > 0) {
            context.report({ node: opening, messageId: 'link', data: { classes: classes.join(' ') } })
          }
          return
        }
        const handler = INTERACTIVE_HANDLERS.find((name) => attribute(opening, name))
        if (handler && !isRenderProp(opening)) {
          context.report({ node: opening, messageId: 'interactive', data: { tag, handler } })
        }
      },
    }
  },
}

const TEXT_ATTRIBUTES = new Set(['aria-label', 'aria-description', 'title', 'placeholder', 'alt', 'label'])
const LETTER = /\p{L}/u

const noHardcodedText = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow interface text outside the i18n catalogs' },
    schema: [
      {
        type: 'object',
        properties: { allow: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
    messages: {
      text:
        'Interface text "{{text}}" must come from useTranslations (@syrnike13/ui/i18n) with keys in apps/*/src/messages/{en,ru}.json.',
    },
  },
  create(context) {
    const allow = new Set(context.options[0]?.allow ?? [])
    function check(node, raw) {
      const text = raw.replace(/\s+/g, ' ').trim()
      if (!text || !LETTER.test(text) || allow.has(text)) return
      context.report({ node, messageId: 'text', data: { text: text.slice(0, 60) } })
    }
    return {
      JSXText(node) {
        check(node, node.value)
      },
      JSXExpressionContainer(node) {
        if (node.parent.type !== 'JSXElement' && node.parent.type !== 'JSXFragment') return
        const expression = node.expression
        if (expression.type === 'Literal' && typeof expression.value === 'string') check(node, expression.value)
        if (expression.type === 'TemplateLiteral' && expression.expressions.length === 0) {
          check(node, expression.quasis[0].value.cooked ?? '')
        }
      },
      JSXAttribute(node) {
        if (!TEXT_ATTRIBUTES.has(node.name.name)) return
        const value = node.value
        if (value?.type === 'Literal' && typeof value.value === 'string') check(value, value.value)
        if (value?.type === 'JSXExpressionContainer' && value.expression.type === 'Literal') {
          check(value, String(value.expression.value))
        }
      },
    }
  },
}

const DISABLE_DIRECTIVE = /^\s*eslint-disable(-next-line|-line)?(?:\s+([^]*?))?(?:\s+--\s*([^]*))?\s*$/

const requireDisableReason = {
  meta: {
    type: 'problem',
    docs: { description: 'Design-rule exceptions are per line and carry a reason' },
    schema: [],
    messages: {
      fileWide:
        'Design rules cannot be disabled for a whole file or block; disable the single line with `eslint-disable-next-line <rule> -- <reason>`.',
      reason: 'Explain the exception: `eslint-disable-next-line {{rules}} -- <reason>`.',
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const match = comment.value.match(DISABLE_DIRECTIVE)
          if (!match) continue
          const [, scope, ruleList = '', reason] = match
          const rules = ruleList.split(',').map((rule) => rule.trim()).filter(Boolean)
          const designRules = rules.filter((rule) => /^(?:design|design-css|shadcn)\//.test(rule))
          const coversDesign = rules.length === 0 || designRules.length > 0
          if (!coversDesign) continue
          if (!scope) {
            context.report({ loc: comment.loc, messageId: 'fileWide' })
          } else if (!reason?.trim()) {
            context.report({
              loc: comment.loc,
              messageId: 'reason',
              data: { rules: designRules.join(', ') || '<rule>' },
            })
          }
        }
      },
    }
  },
}

const COLOR_FUNCTION = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/

const cssNoPrimitiveSelectors = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow global CSS that targets primitive parts' },
    schema: [],
    messages: {
      selector:
        'CSS on [data-slot] restyles a primitive from outside. Change the primitive or add a variant in packages/ui. Policy: ' +
        POLICY,
    },
  },
  create(context) {
    return {
      AttributeSelector(node) {
        if (node.name?.name === 'data-slot') context.report({ node, messageId: 'selector' })
      },
    }
  },
}

const cssNoRawColors = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow literal colours outside custom properties' },
    schema: [],
    messages: {
      color: 'Literal colour in CSS: use a Prism token via var(--…). Define new colours only as Prism tokens.',
    },
  },
  create(context) {
    return {
      Declaration(node) {
        if (node.property.startsWith('--')) return
        if (COLOR_FUNCTION.test(context.sourceCode.getText(node.value))) {
          context.report({ node, messageId: 'color' })
        }
      },
    }
  },
}

export const designPlugin = {
  meta: { name: 'design' },
  rules: {
    'no-restyle': noRestyle,
    'no-lookalike': noLookalike,
    'no-hardcoded-text': noHardcodedText,
    'require-disable-reason': requireDisableReason,
  },
}

export const designCssPlugin = {
  meta: { name: 'design-css' },
  rules: {
    'no-primitive-selectors': cssNoPrimitiveSelectors,
    'no-raw-colors': cssNoRawColors,
  },
}
