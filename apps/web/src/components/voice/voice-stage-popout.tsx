import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type VoiceStagePopoutProps = {
  childWindow: Window
  title: string
  children: ReactNode
  onClose: () => void
}

export function VoiceStagePopout({
  childWindow,
  title,
  children,
  onClose,
}: VoiceStagePopoutProps) {
  const windowRef = useRef<Window | null>(null)
  const onCloseRef = useRef(onClose)
  const [container, setContainer] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    childWindow.document.title = title
  }, [childWindow, title])

  useEffect(() => {
    windowRef.current = childWindow
    childWindow.document.body.innerHTML = ''
    childWindow.document.head.innerHTML = `
      <style>
        html, body, #stage-popout-root {
          width: 100%;
          height: 100%;
          margin: 0;
          background: #000;
          overflow: hidden;
          font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        * { box-sizing: border-box; }
      </style>
    `

    const root = childWindow.document.createElement('div')
    root.id = 'stage-popout-root'
    childWindow.document.body.appendChild(root)
    setContainer(root)

    const handleClose = (reason: string) => {
      void reason
      onCloseRef.current()
    }
    const closePoll = window.setInterval(() => {
      if (childWindow.closed) handleClose('poll-closed')
    }, 500)
    const handleBeforeUnload = () => handleClose('beforeunload')

    childWindow.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.clearInterval(closePoll)
      childWindow.removeEventListener('beforeunload', handleBeforeUnload)
      if (!childWindow.closed) {
        childWindow.close()
      }
      setContainer(null)
      windowRef.current = null
    }
  }, [childWindow])

  return container ? createPortal(children, container) : null
}
