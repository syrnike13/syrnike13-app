import { createContext, useContext, type ReactNode } from 'react'

import type { MessageFormatContext } from '#/lib/message-format/types'

const MessageFormatCtx = createContext<MessageFormatContext>({})

export function MessageFormatProvider({
  value,
  children,
}: {
  value: MessageFormatContext
  children: ReactNode
}) {
  return (
    <MessageFormatCtx.Provider value={value}>{children}</MessageFormatCtx.Provider>
  )
}

export function useMessageFormatContext() {
  return useContext(MessageFormatCtx)
}
