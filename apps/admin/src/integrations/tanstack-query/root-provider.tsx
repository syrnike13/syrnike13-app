import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

let queryClient: QueryClient | undefined

export function getContext() {
  queryClient ??= new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })

  return { queryClient }
}

export default function TanstackQueryProvider({
  client,
  children,
}: {
  client: QueryClient
  children: ReactNode
}) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
