import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import {
  FEEDBACK_CATEGORIES,
} from '#/components/feedback/feedback-meta'
import { FeedbackProductStatus } from '#/components/feedback/feedback-status'
import {
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  InfoIcon,
} from '#/components/icons'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { ScrollArea } from '#/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { Textarea } from '#/components/ui/textarea'
import { useAuth } from '#/features/auth/auth-context'
import {
  createFeedbackSuggestion,
  fetchFeedbackSuggestions,
} from '#/features/api/feedback-api'
import { useAppRoutePrefix } from '#/features/navigation/route-prefix'
import { queryKeys } from '#/lib/api/query-keys'

const TITLE_MAX = 120
const DESCRIPTION_MAX = 2_000

export function FeedbackCreateForm() {
  const auth = useAuth()
  const prefix = useAppRoutePrefix()
  const navigate = useNavigate()
  const token = auth.session?.token
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const normalizedTitle = title.trim()

  const similarQuery = useQuery({
    queryKey: queryKeys.feedback.list({ similar: normalizedTitle }),
    queryFn: () =>
      fetchFeedbackSuggestions(token!, {
        search: normalizedTitle,
        sort: 'popular',
        offset: 0,
        limit: 3,
      }),
    enabled: Boolean(token) && normalizedTitle.length >= 4,
    staleTime: 30_000,
  })

  const similar = similarQuery.data?.suggestions ?? []
  const canSubmit = useMemo(
    () =>
      normalizedTitle.length >= 4 &&
      description.trim().length >= 10 &&
      Boolean(category),
    [category, description, normalizedTitle],
  )

  const createMutation = useMutation({
    mutationFn: () =>
      createFeedbackSuggestion(token!, {
        title: normalizedTitle,
        description: description.trim(),
        category,
      }),
    onSuccess: () => {
      toast.success('Идея отправлена на модерацию')
      void navigate({
        to: `${prefix}/feedback`,
        search: { view: 'mine' },
      })
    },
    onError: () => {
      toast.error('Не удалось отправить идею')
    },
  })

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-shell-divider px-3 sm:px-5">
        <Button variant="ghost" size="icon" asChild>
          <Link to={`${prefix}/feedback`} search={{ view: 'all' }} aria-label="Назад к идеям">
            <ChevronLeftIcon className="size-5" />
          </Link>
        </Button>
        <h1 className="text-base font-semibold sm:text-lg">Предложить идею</h1>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <form
          className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-8 sm:py-8"
          onSubmit={(event) => {
            event.preventDefault()
            if (canSubmit && !createMutation.isPending) createMutation.mutate()
          }}
        >
          <p className="text-sm leading-6 text-muted-foreground">
            Перед публикацией идея пройдёт модерацию.
          </p>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="feedback-title">Название</Label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {title.length}/{TITLE_MAX}
              </span>
            </div>
            <Input
              id="feedback-title"
              value={title}
              maxLength={TITLE_MAX}
              autoFocus
              placeholder="Коротко опишите идею"
              className="h-11 text-base"
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          {normalizedTitle.length >= 4 && (similar.length > 0 || similarQuery.isLoading) ? (
            <section className="space-y-2" aria-labelledby="similar-feedback-title">
              <h2 id="similar-feedback-title" className="text-sm font-semibold">
                Похожие предложения
              </h2>
              <div className="overflow-hidden rounded-lg border border-shell-divider">
                {similarQuery.isLoading ? (
                  <div className="p-4 text-sm text-muted-foreground">Ищем похожие идеи…</div>
                ) : (
                  similar.map((suggestion) => (
                    <Link
                      key={suggestion._id}
                      to={`${prefix}/feedback/$feedbackId`}
                      params={{ feedbackId: suggestion._id }}
                      className="flex items-center gap-3 border-b border-shell-divider p-3 outline-none transition-colors last:border-b-0 hover:bg-muted/25 focus-visible:bg-muted/25"
                    >
                      <span className="flex size-14 shrink-0 flex-col items-center justify-center rounded-md border border-primary/25 bg-primary/5 text-xs font-semibold text-primary">
                        <ArrowUpIcon className="size-4" aria-hidden />
                        {suggestion.vote_count.toLocaleString('ru-RU')}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{suggestion.title}</span>
                        <span className="mt-1 block">
                          <FeedbackProductStatus status={suggestion.status} />
                        </span>
                      </span>
                      <ChevronRightIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                    </Link>
                  ))
                )}
              </div>
            </section>
          ) : null}

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="feedback-description">Описание</Label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {description.length}/{DESCRIPTION_MAX}
              </span>
            </div>
            <Textarea
              id="feedback-description"
              value={description}
              maxLength={DESCRIPTION_MAX}
              placeholder="Опишите проблему, как должно работать решение и какую пользу оно принесёт сообществу."
              className="min-h-36 resize-y text-sm leading-6"
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="feedback-category">Категория</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="feedback-category" className="h-11 w-full">
                <SelectValue placeholder="Выберите категорию" />
              </SelectTrigger>
              <SelectContent>
                {FEEDBACK_CATEGORIES.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm leading-6 text-muted-foreground">
            <InfoIcon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
            <p>После одобрения модерацией ваш голос за идею будет добавлен автоматически.</p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" asChild>
              <Link to={`${prefix}/feedback`} search={{ view: 'all' }}>Отмена</Link>
            </Button>
            <Button type="submit" disabled={!canSubmit || createMutation.isPending}>
              {createMutation.isPending ? 'Отправляем…' : 'Отправить на модерацию'}
            </Button>
          </div>
        </form>
      </ScrollArea>
    </div>
  )
}
