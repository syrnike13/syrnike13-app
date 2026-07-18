import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import {
  AdminEmpty,
  AdminPage,
  AdminSection,
  AdminStickyFooter,
} from '#/components/layout/page'
import { DownloadIcon, Loader2Icon } from '#/components/icons'
import { Button } from '#/components/ui/button'
import { Textarea } from '#/components/ui/textarea'
import {
  downloadAdminDiagnosticReport,
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
  const { reportId } = Route.useParams()
  const auth = useAuth()
  const token = auth.session?.token
  const queryClient = useQueryClient()
  const report = useQuery({
    queryKey: queryKeys.admin.diagnostic(reportId),
    queryFn: () => fetchAdminDiagnosticReport(token!, reportId),
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
      toast.success('Отчёт обновлён')
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : 'Ошибка'),
  })

  const download = async () => {
    if (!token) return
    setDownloading(true)
    try {
      const blob = await downloadAdminDiagnosticReport(token, reportId)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `syrnike13-diagnostic-${reportId}.jsonl.gz`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось скачать отчёт')
    } finally {
      setDownloading(false)
    }
  }

  if (report.isLoading) {
    return <AdminPage title="Диагностический отчёт"><AdminEmpty><Loader2Icon className="mr-2 inline size-4 animate-spin" />Загрузка</AdminEmpty></AdminPage>
  }
  if (report.isError) {
    const notFound = report.error instanceof ApiError && report.error.status === 404
    return (
      <AdminPage title="Диагностический отчёт">
        <AdminEmpty>
          {notFound ? 'Отчёт не найден' : 'Не удалось загрузить диагностический отчёт'}
        </AdminEmpty>
      </AdminPage>
    )
  }
  if (!report.data) {
    return <AdminPage title="Диагностический отчёт"><AdminEmpty>Отчёт не найден</AdminEmpty></AdminPage>
  }

  const value = report.data
  const dirty = status !== value.status || notes !== value.notes
  return (
    <AdminPage
      title={value.trigger_code}
      back={{ to: '/diagnostics', label: 'Диагностика' }}
      actions={
        <Button type="button" size="sm" variant="outline" disabled={downloading} onClick={() => void download()}>
          <DownloadIcon className="size-4" aria-hidden />
          {downloading ? 'Скачивание…' : 'Скачать'}
        </Button>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <AdminSection className="p-4">
          <dl className="grid gap-x-6 gap-y-3 text-[12px] sm:grid-cols-2">
            <Field label="ID" value={value.id} mono />
            <Field label="Пользователь" value={value.user_id} mono />
            <Field label="Создан" value={new Date(value.created_at * 1_000).toLocaleString('ru-RU')} />
            <Field label="Удаление" value={new Date(value.expires_at * 1_000).toLocaleString('ru-RU')} />
            <Field label="Область" value={value.area} />
            <Field label="Серьёзность" value={value.severity} />
            <Field label="Клиент" value={`${value.source} · ${value.platform}`} />
            <Field label="Версия" value={`${value.release_channel} · ${value.app_version}`} />
            <Field label="Размер" value={`${Math.ceil(value.size_bytes / 1024)} КБ`} />
            <Field label="SHA-256" value={value.sha256} mono />
          </dl>
          {value.description ? <p className="mt-4 border-t border-border/60 pt-4 text-[13px]">{value.description}</p> : null}
        </AdminSection>

        <AdminSection className="space-y-3 p-4">
          <label className="block text-[12px] text-muted-foreground" htmlFor="diagnostic-status">Статус</label>
          <select
            id="diagnostic-status"
            value={status}
            onChange={(event) => setStatus(event.target.value as DiagnosticReportStatus)}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-[13px]"
          >
            <option value="new">Новый</option>
            <option value="investigating">В работе</option>
            <option value="resolved">Решён</option>
          </select>
          <label className="block text-[12px] text-muted-foreground" htmlFor="diagnostic-notes">Заметки</label>
          <Textarea id="diagnostic-notes" value={notes} maxLength={4000} onChange={(event) => setNotes(event.target.value)} rows={8} />
        </AdminSection>
      </div>
      <AdminStickyFooter visible={dirty}>
        <span className="text-[12px] text-muted-foreground">Есть несохранённые изменения</span>
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
            Сбросить
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={update.isPending}
            onClick={() => update.mutate()}
          >
            {update.isPending ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </div>
      </AdminStickyFooter>
    </AdminPage>
  )
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className={mono ? 'mt-0.5 break-all font-mono text-[11px]' : 'mt-0.5 break-words'}>{value}</dd></div>
}
