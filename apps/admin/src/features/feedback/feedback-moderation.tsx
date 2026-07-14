import type {
  FeedbackProductStatus,
  FeedbackSuggestion,
} from '@syrnike13/api-types'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import {
  AdminEmpty,
  AdminPage,
  AdminSection,
  AdminSectionHeader,
} from '#/components/layout/page'
import { CheckIcon, Loader2Icon, XIcon } from '#/components/icons'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { Textarea } from '#/components/ui/textarea'
import { useAuth } from '#/features/auth/auth-context'
import {
  approveFeedback,
  fetchPendingFeedback,
  fetchPublishedFeedback,
  hideFeedback,
  mergeFeedback,
  rejectFeedback,
  setFeedbackResponse,
  setFeedbackStatus,
} from '#/features/api/feedback-api'
import { queryKeys } from '#/lib/api/query-keys'
import { cn } from '#/lib/utils'

type Mode = 'pending' | 'published'
type ModerationDialog =
  | { type: 'reject'; suggestion: FeedbackSuggestion }
  | { type: 'merge'; suggestion: FeedbackSuggestion }
  | null

const STATUS_OPTIONS: { value: FeedbackProductStatus; label: string }[] = [
  { value: 'collecting', label: 'Собираем голоса' },
  { value: 'under_consideration', label: 'Рассматриваем' },
  { value: 'planned', label: 'Запланировано' },
  { value: 'in_progress', label: 'В работе' },
  { value: 'released', label: 'Выпущено' },
  { value: 'not_planned', label: 'Не планируется' },
]

export function FeedbackModerationPage() {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const token = auth.session?.token
  const [mode, setMode] = useState<Mode>('pending')
  const [dialog, setDialog] = useState<ModerationDialog>(null)
  const [reason, setReason] = useState('')
  const [targetId, setTargetId] = useState('')
  const [selected, setSelected] = useState<FeedbackSuggestion | null>(null)

  const pendingQuery = useQuery({
    queryKey: queryKeys.admin.feedbackPending,
    queryFn: () => fetchPendingFeedback(token!),
    enabled: Boolean(token) && mode === 'pending',
  })
  const publishedQuery = useQuery({
    queryKey: queryKeys.admin.feedbackPublished,
    queryFn: () => fetchPublishedFeedback(token!),
    enabled: Boolean(token) && mode === 'published',
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.admin.feedback })

  const approveMutation = useMutation({
    mutationFn: (id: string) => approveFeedback(token!, id),
    onSuccess: () => {
      toast.success('Идея опубликована')
      void invalidate()
    },
    onError: () => toast.error('Не удалось одобрить идею'),
  })
  const rejectMutation = useMutation({
    mutationFn: ({ id, rejectionReason }: { id: string; rejectionReason: string }) =>
      rejectFeedback(token!, id, { reason: rejectionReason }),
    onSuccess: () => {
      toast.success('Идея отклонена')
      closeDialog()
      void invalidate()
    },
    onError: () => toast.error('Не удалось отклонить идею'),
  })
  const mergeMutation = useMutation({
    mutationFn: ({ id, target, mergeReason }: { id: string; target: string; mergeReason: string }) =>
      mergeFeedback(token!, id, {
        target_id: target,
        reason: mergeReason.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('Дубль объединён с основной идеей')
      closeDialog()
      void invalidate()
    },
    onError: () => toast.error('Не удалось объединить идеи'),
  })

  const activeQuery = mode === 'pending' ? pendingQuery : publishedQuery
  const suggestions = activeQuery.data?.suggestions ?? []

  function closeDialog() {
    setDialog(null)
    setReason('')
    setTargetId('')
  }

  return (
    <AdminPage
      title="Идеи"
      actions={
        <div className="flex rounded-md border border-border/70 p-0.5">
          <ModeButton active={mode === 'pending'} onClick={() => setMode('pending')}>
            Модерация
          </ModeButton>
          <ModeButton active={mode === 'published'} onClick={() => setMode('published')}>
            Опубликованные
          </ModeButton>
        </div>
      }
    >
      {activeQuery.isLoading ? (
        <div className="flex min-h-48 items-center justify-center text-muted-foreground">
          <Loader2Icon className="size-5 animate-spin" />
        </div>
      ) : suggestions.length === 0 ? (
        <AdminEmpty>
          {mode === 'pending'
            ? 'Новых идей на модерации нет.'
            : 'Опубликованных идей пока нет.'}
        </AdminEmpty>
      ) : (
        <AdminSection>
          <AdminSectionHeader>
            {mode === 'pending' ? `Ожидают решения: ${suggestions.length}` : `Опубликовано: ${suggestions.length}`}
          </AdminSectionHeader>
          {suggestions.map((suggestion) => (
            <div key={suggestion._id}>
              <FeedbackAdminRow
                suggestion={suggestion}
                mode={mode}
                selected={selected?._id === suggestion._id}
                approving={approveMutation.isPending && approveMutation.variables === suggestion._id}
                onSelect={() => setSelected((current) => current?._id === suggestion._id ? null : suggestion)}
                onApprove={() => approveMutation.mutate(suggestion._id)}
                onReject={() => setDialog({ type: 'reject', suggestion })}
                onMerge={() => setDialog({ type: 'merge', suggestion })}
              />
              {mode === 'published' && selected?._id === suggestion._id ? (
                <PublishedFeedbackEditor
                  key={`${suggestion._id}:${suggestion.updated_at}`}
                  suggestion={suggestion}
                  token={token!}
                  onSaved={(updated) => {
                    setSelected(updated)
                    void invalidate()
                  }}
                />
              ) : null}
            </div>
          ))}
        </AdminSection>
      )}

      <Dialog open={Boolean(dialog)} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog?.type === 'merge' ? 'Объединить дубль' : 'Отклонить идею'}</DialogTitle>
            <DialogDescription>
              {dialog?.suggestion.title}
            </DialogDescription>
          </DialogHeader>
          {dialog?.type === 'merge' ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="feedback-target">Куда перенести голоса</Label>
                <Input id="feedback-target" value={targetId} onChange={(event) => setTargetId(event.target.value)} placeholder="ID основной идеи" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="feedback-merge-reason">Пояснение</Label>
                <Textarea id="feedback-merge-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Например: идея уже обсуждается" />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="feedback-rejection-reason">Причина</Label>
              <Textarea id="feedback-rejection-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Автор увидит это пояснение" />
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog}>Отмена</Button>
            <Button
              variant={dialog?.type === 'merge' ? 'default' : 'destructive'}
              disabled={dialog?.type === 'merge' ? !targetId.trim() : !reason.trim()}
              onClick={() => {
                if (!dialog) return
                if (dialog.type === 'merge') {
                  mergeMutation.mutate({ id: dialog.suggestion._id, target: targetId.trim(), mergeReason: reason })
                } else {
                  rejectMutation.mutate({ id: dialog.suggestion._id, rejectionReason: reason.trim() })
                }
              }}
            >
              {dialog?.type === 'merge' ? 'Объединить' : 'Отклонить'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  )
}

function ModeButton({ active, children, onClick }: { active: boolean; children: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cn('h-7 rounded px-2.5 text-[12px] transition-colors', active ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function FeedbackAdminRow({
  suggestion,
  mode,
  selected,
  approving,
  onSelect,
  onApprove,
  onReject,
  onMerge,
}: {
  suggestion: FeedbackSuggestion
  mode: Mode
  selected: boolean
  approving: boolean
  onSelect: () => void
  onApprove: () => void
  onReject: () => void
  onMerge: () => void
}) {
  return (
    <div className={cn('flex flex-col gap-3 border-b border-border/60 px-4 py-3 last:border-b-0 sm:flex-row sm:items-center', selected && 'bg-muted/25')}>
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onSelect}>
        <div className="truncate text-[13px] font-semibold">{suggestion.title}</div>
        <div className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-muted-foreground">{suggestion.description}</div>
        <div className="mt-1.5 flex flex-wrap gap-2 text-[10px] text-muted-foreground">
          <span>{suggestion.category}</span>
          <span>{suggestion.vote_count} голосов</span>
          <span className="font-mono">{suggestion._id}</span>
        </div>
      </button>
      {mode === 'pending' ? (
        <div className="flex shrink-0 flex-wrap gap-1.5">
          <Button size="sm" onClick={onApprove} disabled={approving}>
            <CheckIcon className="size-3.5" />
            Одобрить
          </Button>
          <Button size="sm" variant="secondary" onClick={onMerge}>Объединить</Button>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={onReject}>
            <XIcon className="size-3.5" />
            Отклонить
          </Button>
        </div>
      ) : (
        <Button size="sm" variant="secondary" onClick={onSelect}>
          {selected ? 'Свернуть' : 'Управлять'}
        </Button>
      )}
    </div>
  )
}

function PublishedFeedbackEditor({
  suggestion,
  token,
  onSaved,
}: {
  suggestion: FeedbackSuggestion
  token: string
  onSaved: (suggestion: FeedbackSuggestion) => void
}) {
  const [status, setStatus] = useState<FeedbackProductStatus>(suggestion.status)
  const [response, setResponse] = useState(suggestion.team_response ?? '')

  useEffect(() => {
    setStatus(suggestion.status)
    setResponse(suggestion.team_response ?? '')
  }, [suggestion])

  const saveMutation = useMutation({
    mutationFn: async () => {
      let updated = suggestion
      if (status !== suggestion.status) {
        updated = await setFeedbackStatus(token, suggestion._id, { status })
      }
      const normalizedResponse = response.trim() || null
      if (normalizedResponse !== (suggestion.team_response ?? null)) {
        updated = await setFeedbackResponse(token, suggestion._id, { response: normalizedResponse })
      }
      return updated
    },
    onSuccess: (updated) => {
      toast.success('Идея обновлена')
      onSaved(updated)
    },
    onError: () => toast.error('Не удалось сохранить изменения'),
  })
  const hideMutation = useMutation({
    mutationFn: () => hideFeedback(token, suggestion._id),
    onSuccess: (updated) => {
      toast.success('Идея скрыта')
      onSaved(updated)
    },
  })

  return (
    <div className="grid gap-4 border-b border-border/60 bg-muted/10 px-4 py-4 lg:grid-cols-[14rem_minmax(0,1fr)_auto]">
      <div className="space-y-1.5">
        <Label htmlFor={`status-${suggestion._id}`}>Статус</Label>
        <select
          id={`status-${suggestion._id}`}
          value={status}
          className="h-9 w-full rounded-md border border-input bg-input px-3 text-[13px] outline-none focus:ring-2 focus:ring-ring/50"
          onChange={(event) => setStatus(event.target.value as FeedbackProductStatus)}
        >
          {STATUS_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`response-${suggestion._id}`}>Ответ команды</Label>
        <Textarea
          id={`response-${suggestion._id}`}
          value={response}
          className="min-h-20"
          placeholder="Объяснение решения или текущего прогресса"
          onChange={(event) => setResponse(event.target.value)}
        />
      </div>
      <div className="flex items-end gap-2 lg:flex-col lg:justify-end">
        <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>Сохранить</Button>
        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => hideMutation.mutate()} disabled={hideMutation.isPending}>Скрыть</Button>
      </div>
    </div>
  )
}
