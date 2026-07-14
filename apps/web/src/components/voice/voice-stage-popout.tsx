import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { PortalContainerProvider } from '#/components/ui/portal-container'

type VoiceStagePopoutProps = {
  childWindow: Window
  title: string
  children: ReactNode
  onClose: () => void
}

const POPOUT_ROOT_ID = 'stage-popout-root'
const POPOUT_STYLE_MARKER = 'data-syrnike13-popout-style'

export function syncPopoutDocumentAppearance(
  source: Document,
  target: Document,
) {
  const sourceHtml = source.documentElement
  const targetHtml = target.documentElement
  targetHtml.className = sourceHtml.className
  targetHtml.lang = sourceHtml.lang

  if (sourceHtml.dataset.theme) {
    targetHtml.dataset.theme = sourceHtml.dataset.theme
  } else {
    delete targetHtml.dataset.theme
  }

  if (sourceHtml.dataset.themeGradient) {
    targetHtml.dataset.themeGradient = sourceHtml.dataset.themeGradient
  } else {
    delete targetHtml.dataset.themeGradient
  }

  targetHtml.style.cssText = sourceHtml.style.cssText

  let base = target.head.querySelector(
    `base[${POPOUT_STYLE_MARKER}]`,
  ) as HTMLBaseElement | null
  if (!base) {
    base = target.createElement('base')
    base.setAttribute(POPOUT_STYLE_MARKER, '')
    target.head.prepend(base)
  }
  base.href = source.baseURI
}

export function syncPopoutDocumentStyles(
  source: Document,
  target: Document,
) {
  target.head
    .querySelectorAll(
      `link[${POPOUT_STYLE_MARKER}], style[${POPOUT_STYLE_MARKER}]`,
    )
    .forEach((node) => node.remove())

  for (const node of source.head.querySelectorAll(
    'link[rel="stylesheet"], style',
  )) {
    const clone = node.cloneNode(true) as HTMLElement
    clone.setAttribute(POPOUT_STYLE_MARKER, '')
    target.head.appendChild(clone)
  }
}

function ensurePopoutDocument(childWindow: Window) {
  let root = childWindow.document.getElementById(POPOUT_ROOT_ID)
  if (root) return root

  syncPopoutDocumentAppearance(window.document, childWindow.document)
  syncPopoutDocumentStyles(window.document, childWindow.document)

  childWindow.document.head.insertAdjacentHTML(
    'beforeend',
    `
    <style ${POPOUT_STYLE_MARKER}>
      html, body, #${POPOUT_ROOT_ID} {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: #000;
      }
      html, body {
        display: flex;
        flex-direction: column;
      }
      #${POPOUT_ROOT_ID} {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        min-height: 0;
        min-width: 0;
      }
    </style>
  `,
  )
  childWindow.document.body.replaceChildren()
  root = childWindow.document.createElement('div')
  root.id = POPOUT_ROOT_ID
  root.className = 'flex min-h-0 min-w-0 flex-1 flex-col'
  childWindow.document.body.appendChild(root)
  return root
}

export function VoiceStagePopout({
  childWindow,
  title,
  children,
  onClose,
}: VoiceStagePopoutProps) {
  const onCloseRef = useRef(onClose)
  const [container, setContainer] = useState<HTMLElement | null>(null)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (childWindow.closed) return
    childWindow.document.title = title
  }, [childWindow, title])

  useEffect(() => {
    const root = ensurePopoutDocument(childWindow)
    setContainer(root)

    const appearanceObserver = new MutationObserver(() => {
      syncPopoutDocumentAppearance(window.document, childWindow.document)
    })
    appearanceObserver.observe(window.document.documentElement, {
      attributes: true,
      attributeFilter: [
        'class',
        'style',
        'lang',
        'data-theme',
        'data-theme-gradient',
      ],
    })

    const closePoll = window.setInterval(() => {
      if (childWindow.closed) {
        onCloseRef.current()
      }
    }, 500)

    return () => {
      appearanceObserver.disconnect()
      window.clearInterval(closePoll)
      setContainer(null)
    }
  }, [childWindow])

  return container
    ? createPortal(
        <PortalContainerProvider container={childWindow.document.body}>
          {children}
        </PortalContainerProvider>,
        container,
      )
    : null
}
