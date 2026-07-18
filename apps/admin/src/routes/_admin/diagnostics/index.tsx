import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { FormEvent } from 'react'
import { z } from 'zod'

import {
  AdminEmpty,
  AdminPage,
  AdminSection,
  AdminSectionHeader,
} from '#/components/layout/page'
import { Loader2Icon } from '#/components/icons'
import { Button } from '#/components/ui/button'
import { fetchAdminDiagnosticReports } from '#/features/api/admin-api'
import { useAuth } from '#/features/auth/auth-context'
import { queryKeys } from '#/lib/api/query-keys'

const filtersSchema = z.object({
  user_id: z.string().optional(),
  status: z.enum(['new', 'investigating', 'resolved']).optional(),
  area: z.string().optional(),
  release_channel: z.string().optional(),
  before: z.string().optional(),
})

export const Route = createFileRoute('/_admin/diagnostics/')({
  validateSearch: filtersSchema,
  component: DiagnosticsPage,
})

function DiagnosticsPage() {
  const auth = useAuth()
  const token = auth.session?.token
  const filters = Route.useSearch()
  const navigate = useNavigate({ from: '/diagnostics' })
  const reports = useQuery({
    queryKey: queryKeys.admin.diagnostics(filters),
    queryFn: () => fetchAdminDiagnosticReports(token!, { ...filters, limit: '100' }),
    enabled: Boolean(token),
  })

  return (
    <AdminPage title="Диагностика">
      <form
        className="mb-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_10rem_10rem_auto]"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          const value = (key: string) => String(data.get(key) ?? '').trim() || undefined
          void navigate({
            search: {
              user_id: value('user_id'),
              area: value('area'),
              status: value('status') as 'new' | 'investigating' | 'resolved' | undefined,
              release_channel: value('release_channel'),
              before: undefined,
            },
          })
        }}
      >
        <input
          name="user_id"
          defaultValue={filters.user_id}
          placeholder="ID пользователя"
          className="h-9 rounded-md border border-input bg-background px-3 text-[13px]"
        />
        <input
          name="area"
          defaultValue={filters.area}
          placeholder="Область"
          className="h-9 rounded-md border border-input bg-background px-3 text-[13px]"
        />
        <select
          name="status"
          defaultValue={filters.status ?? ''}
          className="h-9 rounded-md border border-input bg-background px-3 text-[13px]"
        >
          <option value="">Все статусы</option>
          <option value="new">Новые</option>
          <option value="investigating">В работе</option>
          <option value="resolved">Решённые</option>
        </select>
        <select
          name="release_channel"
          defaultValue={filters.release_channel ?? ''}
          className="h-9 rounded-md border border-input bg-background px-3 text-[13px]"
        >
          <option value="">Все каналы</option>
          <option value="stable">Stable</option>
          <option value="nightly">Nightly</option>
          <option value="development">Development</option>
        </select>
        <Button type="submit" size="sm">Фильтр</Button>
      </form>
      <AdminSection>
        <AdminSectionHeader>
          Отчёты · {reports.data?.length ?? 0}
        </AdminSectionHeader>
        {reports.isLoading ? (
          <div className="flex h-24 items-center justify-center text-[13px] text-muted-foreground">
            <Loader2Icon className="mr-2 size-4 animate-spin" aria-hidden />
            Загрузка
          </div>
        ) : reports.isError ? (
          <AdminEmpty>Не удалось загрузить диагностические отчёты</AdminEmpty>
        ) : reports.data?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-left text-[12px]">
              <thead className="border-b border-border/60 text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Время</th>
                  <th className="px-4 py-2 font-medium">Событие</th>
                  <th className="px-4 py-2 font-medium">Клиент</th>
                  <th className="px-4 py-2 font-medium">Пользователь</th>
                  <th className="px-4 py-2 font-medium">Статус</th>
                </tr>
              </thead>
              <tbody>
                {reports.data.map((report) => (
                  <tr key={report.id} className="border-b border-border/50 last:border-0">
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                      {new Date(report.created_at * 1_000).toLocaleString('ru-RU')}
                    </td>
                    <td className="px-4 py-2.5">
                      <Link
                        to="/diagnostics/$reportId"
                        params={{ reportId: report.id }}
                        className="font-mono text-primary hover:underline"
                      >
                        {report.trigger_code}
                      </Link>
                      <div className="mt-0.5 text-muted-foreground">{report.area}</div>
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {report.source} · {report.release_channel} · {report.app_version}
                    </td>
                    <td className="max-w-48 truncate px-4 py-2.5 font-mono text-muted-foreground">
                      {report.user_id}
                    </td>
                    <td className="px-4 py-2.5">{statusLabel(report.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <AdminEmpty>Диагностических отчётов пока нет</AdminEmpty>
        )}
      </AdminSection>
      {reports.data?.length === 100 ? (
        <div className="mt-4 flex justify-center">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              void navigate({
                search: { ...filters, before: reports.data.at(-1)?.id },
              })
            }
          >
            Более ранние
          </Button>
        </div>
      ) : null}
    </AdminPage>
  )
}

function statusLabel(status: 'new' | 'investigating' | 'resolved') {
  if (status === 'new') return 'Новый'
  if (status === 'investigating') return 'В работе'
  return 'Решён'
}
