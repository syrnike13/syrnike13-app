import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'

import { Button } from '#/components/ui/button'
import { config } from '#/lib/config'
import { fetchApiRoot } from '#/lib/api/client'
import { queryKeys } from '#/lib/api/query-keys'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  const apiHealth = useQuery({
    queryKey: queryKeys.api.root,
    queryFn: fetchApiRoot,
    retry: 1,
  })

  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-6 py-4">
        <span className="text-lg font-semibold tracking-tight">
          {config.appTitle}
        </span>
        <nav className="flex gap-2">
          <Button variant="ghost" asChild>
            <Link to="/login">Войти</Link>
          </Button>
          <Button asChild>
            <Link to="/app">Приложение</Link>
          </Button>
        </nav>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-8 px-6 py-16">
        <div className="flex flex-col gap-4">
          <p className="text-sm font-medium text-muted-foreground">
            Новый клиент · React · TanStack Start
          </p>
          <h1 className="text-4xl font-bold tracking-tight">
            Переписываем фронтенд с нуля
          </h1>
          <p className="text-lg text-muted-foreground">
            Этот проект —{' '}
            <code className="rounded bg-muted px-1.5 py-0.5 text-sm">
              apps/web
            </code>
            , подключён к продакшен API.
          </p>
        </div>

        <section className="rounded-xl border bg-card p-6 text-card-foreground">
          <h2 className="font-semibold">Бэкенд</h2>
          <dl className="mt-4 flex flex-col gap-2 text-sm">
            <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
              <dt className="text-muted-foreground sm:w-28">API</dt>
              <dd className="font-mono break-all">{config.apiUrl}</dd>
            </div>
            <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
              <dt className="text-muted-foreground sm:w-28">WebSocket</dt>
              <dd className="font-mono break-all">{config.wsUrl}</dd>
            </div>
          </dl>

          <p className="mt-4 text-sm text-muted-foreground">
            {apiHealth.isPending && 'Проверяем связь с API…'}
            {apiHealth.isSuccess && 'API отвечает.'}
            {apiHealth.isError &&
              `API недоступен: ${apiHealth.error.message} (часто CORS с localhost — настройте origin на сервере).`}
          </p>
        </section>
      </main>
    </div>
  )
}
