import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Option, Schema } from 'effect'
import type { FormEvent } from 'react'
import { useLocale, useTranslations } from '@syrnike13/ui/i18n'

import {
  AdminEmpty,
  AdminPage,
  AdminSection,
  AdminSectionHeader,
} from '#/components/layout/page'
import { Loader2Icon } from '#/components/icons'
import { Button } from '@syrnike13/ui/primitives/button'
import { fetchAdminDiagnosticReports } from '#/features/api/admin-api'
import { useAuth } from '#/features/auth/auth-context'
import { queryKeys } from '#/lib/api/query-keys'

const filtersSchema = Schema.toStandardSchemaV1(
  Schema.Struct({
    user_id: Schema.optionalKey(Schema.String),
    status: Schema.optionalKey(ApiSchema.DiagnosticReportStatus),
    area: Schema.optionalKey(Schema.String),
    release_channel: Schema.optionalKey(Schema.String),
    before: Schema.optionalKey(Schema.String),
  }),
)

export const Route = createFileRoute('/_admin/diagnostics/')({
  validateSearch: filtersSchema,
  component: DiagnosticsPage,
})

function DiagnosticsPage() {
  const t = useTranslations('diagnostics.list')
  const tStatus = useTranslations('diagnostics.status')
  const { locale } = useLocale()
  const auth = useAuth()
  const token = auth.session?.token
  const filters = Route.useSearch()
  const navigate = useNavigate({ from: '/diagnostics/' })
  const reports = useQuery({
    queryKey: queryKeys.admin.diagnostics(filters),
    queryFn: ({ signal }) =>
      fetchAdminDiagnosticReports(token!, { ...filters, limit: '100' }, signal),
    enabled: Boolean(token),
  })
  const nextBefore =
    reports.data?.length === 100 ? reports.data.at(-1)?.id : undefined

  return (
    <AdminPage title={t('title')}>
      <form
        key={diagnosticFiltersKey(filters)}
        className="mb-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_10rem_10rem_auto]"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          const value = (key: string) => String(data.get(key) ?? '').trim() || undefined
          const status = Schema.decodeUnknownOption(
            ApiSchema.DiagnosticReportStatus,
          )(value('status'))
          void navigate({
            search: {
              user_id: value('user_id'),
              area: value('area'),
              status: Option.getOrUndefined(status),
              release_channel: value('release_channel'),
              before: undefined,
            },
          })
        }}
      >
        <input
          name="user_id"
          defaultValue={filters.user_id}
          placeholder={t('userPlaceholder')}
          className="h-9 rounded-md border border-input bg-background px-3 text-[0.8125rem]"
        />
        <input
          name="area"
          defaultValue={filters.area}
          placeholder={t('areaPlaceholder')}
          className="h-9 rounded-md border border-input bg-background px-3 text-[0.8125rem]"
        />
        <select
          name="status"
          defaultValue={filters.status ?? ''}
          className="h-9 rounded-md border border-input bg-background px-3 text-[0.8125rem]"
        >
          <option value="">{t('allStatuses')}</option>
          <option value="new">{t('statusNewPlural')}</option>
          <option value="investigating">{tStatus('investigating')}</option>
          <option value="resolved">{t('statusResolvedPlural')}</option>
        </select>
        <select
          name="release_channel"
          defaultValue={filters.release_channel ?? ''}
          className="h-9 rounded-md border border-input bg-background px-3 text-[0.8125rem]"
        >
          <option value="">{t('allChannels')}</option>
          <option value="stable">Stable</option>
          <option value="nightly">Nightly</option>
          <option value="development">Development</option>
        </select>
        <Button type="submit" size="sm">{t('filter')}</Button>
      </form>
      <AdminSection>
        <AdminSectionHeader>
          {t('reports', { count: reports.data?.length ?? 0 })}
        </AdminSectionHeader>
        {reports.isLoading ? (
          <div className="flex h-24 items-center justify-center text-[0.8125rem] text-muted-foreground">
            <Loader2Icon className="mr-2 size-4 animate-spin" aria-hidden />
            {t('loading')}
          </div>
        ) : reports.isError ? (
          <AdminEmpty>{t('loadError')}</AdminEmpty>
        ) : reports.data?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-left text-xs">
              <thead className="border-b border-border/60 text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">{t('columnTime')}</th>
                  <th className="px-4 py-2 font-medium">{t('columnEvent')}</th>
                  <th className="px-4 py-2 font-medium">{t('columnClient')}</th>
                  <th className="px-4 py-2 font-medium">{t('columnUser')}</th>
                  <th className="px-4 py-2 font-medium">{t('columnStatus')}</th>
                </tr>
              </thead>
              <tbody>
                {reports.data.map((report) => (
                  <tr key={report.id} className="border-b border-border/50 last:border-0">
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">
                      {new Date(report.created_at * 1_000).toLocaleString(locale)}
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
                    <td className="px-4 py-2.5">{tStatus(report.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <AdminEmpty>{t('empty')}</AdminEmpty>
        )}
      </AdminSection>
      {nextBefore ? (
        <div className="mt-4 flex justify-center">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              void navigate({
                search: { ...filters, before: nextBefore },
              })
            }
          >
            {t('earlier')}
          </Button>
        </div>
      ) : null}
    </AdminPage>
  )
}

function diagnosticFiltersKey(filters: {
  user_id?: string
  area?: string
  status?: string
  release_channel?: string
}) {
  return [
    filters.user_id ?? '',
    filters.area ?? '',
    filters.status ?? '',
    filters.release_channel ?? '',
  ].join('\u0000')
}
