import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Effect, Option, Schema } from 'effect'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useLocale, useTranslations } from '@syrnike13/ui/i18n'

import {
  AdminEmpty,
  AdminPage,
  AdminSection,
  AdminStickyFooter,
} from '#/components/layout/page'
import { DownloadIcon } from '#/components/icons'
import { Button } from '@syrnike13/ui/primitives/button'
import { Label } from '@syrnike13/ui/primitives/label'
import {
  NativeSelect,
  NativeSelectOption,
} from '@syrnike13/ui/primitives/native-select'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { Textarea } from '@syrnike13/ui/primitives/textarea'
import {
  downloadAdminDiagnosticReportEffect,
  fetchAdminDiagnosticReport,
  updateAdminDiagnosticReport,
  type DiagnosticReportStatus,
} from '#/features/api/admin-api'
import { useAuth } from '#/features/auth/auth-context'
import { ApiError } from '#/lib/api/client'
import { queryKeys } from '#/lib/api/query-keys'

export const Route = createFileRoute('/_admin/diagnostics/$reportId')({
  component: DiagnosticReportPage,
})

function DiagnosticReportPage() {
  const t = useTranslations('diagnostics.report')
  const tStatus = useTranslations('diagnostics.status')
  const tDownload = useTranslations('diagnostics.download')
  const { locale } = useLocale()
  const { reportId } = Route.useParams()
  const auth = useAuth()
  const token = auth.session?.token
  const queryClient = useQueryClient()
  const report = useQuery({
    queryKey: queryKeys.admin.diagnostic(reportId),
    queryFn: ({ signal }) =>
      fetchAdminDiagnosticReport(token!, reportId, signal),
    enabled: Boolean(token),
  })
  const [status, setStatus] = useState<DiagnosticReportStatus>('new')
  const [notes, setNotes] = useState('')
  const [downloading, setDownloading] = useState(false)
  const initializedReportIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!report.data || initializedReportIdRef.current === reportId) return
    initializedReportIdRef.current = reportId
    setStatus(report.data.status)
    setNotes(report.data.notes)
  }, [report.data, reportId])

  const update = useMutation({
    mutationFn: () => updateAdminDiagnosticReport(token!, reportId, { status, notes }),
    onSuccess: (value) => {
      queryClient.setQueryData(queryKeys.admin.diagnostic(reportId), value)
      toast.success(t('updated'))
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : t('updateError')),
  })

  const download = async () => {
    if (!token) return
    setDownloading(true)
    await Effect.runPromise(
      Effect.gen(function*() {
        const blob = yield* downloadAdminDiagnosticReportEffect(
          token,
          reportId,
          tDownload,
        )
        const url = yield* Effect.sync(() => URL.createObjectURL(blob))
        yield* Effect.sync(() => {
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = `syrnike13-diagnostic-${reportId}.jsonl.gz`
          anchor.click()
        }).pipe(
          Effect.ensuring(Effect.sync(() => URL.revokeObjectURL(url))),
        )
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            toast.error(
              error instanceof Error
                ? error.message
                : t('downloadError'),
            )
          }),
        ),
        Effect.ensuring(Effect.sync(() => setDownloading(false))),
      ),
    )
  }

  if (report.isLoading) {
    return (
      <AdminPage title={t('title')}>
        <AdminEmpty>
          <Spinner className="mr-2 inline size-4" aria-hidden />
          {t('loading')}
        </AdminEmpty>
      </AdminPage>
    )
  }
  if (report.isError) {
    const notFound = report.error instanceof ApiError && report.error.status === 404
    return (
      <AdminPage title={t('title')}>
        <AdminEmpty>
          {notFound ? t('notFound') : t('loadError')}
        </AdminEmpty>
      </AdminPage>
    )
  }
  if (!report.data) {
    return (
      <AdminPage title={t('title')}>
        <AdminEmpty>{t('notFound')}</AdminEmpty>
      </AdminPage>
    )
  }

  const value = report.data
  const dirty = status !== value.status || notes !== value.notes
  return (
    <AdminPage
      title={value.trigger_code}
      back={{ to: '/diagnostics', label: t('back') }}
      actions={
        <Button type="button" size="sm" variant="outline" disabled={downloading} onClick={() => void download()}>
          <DownloadIcon className="size-4" aria-hidden />
          {downloading ? t('downloading') : t('download')}
        </Button>
      }
    >
      <div className="grid gap-4 diagnostics-report-grid">
        <AdminSection className="p-4">
          <dl className="grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
            <Field label={t('fields.id')} value={value.id} mono />
            <Field label={t('fields.user')} value={value.user_id} mono />
            <Field
              label={t('fields.created')}
              value={new Date(value.created_at * 1_000).toLocaleString(locale)}
            />
            <Field
              label={t('fields.expires')}
              value={new Date(value.expires_at * 1_000).toLocaleString(locale)}
            />
            <Field label={t('fields.area')} value={value.area} />
            <Field label={t('fields.severity')} value={value.severity} />
            <Field
              label={t('fields.client')}
              value={`${value.source} · ${value.platform}`}
            />
            <Field
              label={t('fields.version')}
              value={`${value.release_channel} · ${value.app_version}`}
            />
            <Field
              label={t('fields.size')}
              value={t('sizeKb', {
                kb: Math.ceil(value.size_bytes / 1024),
              })}
            />
            <Field label={t('fields.sha256')} value={value.sha256} mono />
          </dl>
          {value.description ? <p className="mt-4 border-t border-border pt-4 text-sm">{value.description}</p> : null}
        </AdminSection>

        <AdminSection className="space-y-3 p-4">
          <Label
            className="text-muted-foreground"
            htmlFor="diagnostic-status"
          >
            {t('statusLabel')}
          </Label>
          <NativeSelect
            id="diagnostic-status"
            value={status}
            className="w-full"
            onChange={(event) => {
              const decoded = Schema.decodeUnknownOption(
                ApiSchema.DiagnosticReportStatus,
              )(event.target.value)
              if (Option.isSome(decoded)) setStatus(decoded.value)
            }}
          >
            <NativeSelectOption value="new">
              {tStatus('new')}
            </NativeSelectOption>
            <NativeSelectOption value="investigating">
              {tStatus('investigating')}
            </NativeSelectOption>
            <NativeSelectOption value="resolved">
              {tStatus('resolved')}
            </NativeSelectOption>
          </NativeSelect>
          <Label
            className="text-muted-foreground"
            htmlFor="diagnostic-notes"
          >
            {t('notes')}
          </Label>
          <Textarea id="diagnostic-notes" value={notes} maxLength={4000} onChange={(event) => setNotes(event.target.value)} rows={8} />
        </AdminSection>
      </div>
      <AdminStickyFooter visible={dirty}>
        <span className="text-xs text-muted-foreground">{t('unsaved')}</span>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={update.isPending}
            onClick={() => {
              setStatus(value.status)
              setNotes(value.notes)
            }}
          >
            {t('reset')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={update.isPending}
            onClick={() => update.mutate()}
          >
            {update.isPending ? t('saving') : t('save')}
          </Button>
        </div>
      </AdminStickyFooter>
    </AdminPage>
  )
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className={mono ? 'mt-0.5 break-all font-mono text-xs' : 'mt-0.5 break-words'}>{value}</dd></div>
}
