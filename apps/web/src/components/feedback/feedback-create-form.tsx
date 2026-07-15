import type {
  FeedbackArea,
  FeedbackCategory,
  FeedbackPlatform,
} from '@syrnike13/api-types'
import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import {
  FEEDBACK_AREAS,
  FEEDBACK_CATEGORIES,
  FEEDBACK_PLATFORMS,
} from '#/components/feedback/feedback-meta'
import {
  FeedbackCategoryBadge,
  FeedbackProductStatus,
} from '#/components/feedback/feedback-status'
import {
  AndroidIcon,
  AppleIcon,
  ArrowUpIcon,
  BugIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  GlobeIcon,
  InfoIcon,
  LinuxIcon,
  LightbulbIcon,
  WindowsIcon,
} from '#/components/icons'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { ScrollArea } from '#/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectGroup,
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
import { cn } from '#/lib/utils'

const TITLE_MAX = 120
const DESCRIPTION_MAX = 2_000

const PLATFORM_ICONS = {
  windows: WindowsIcon,
  macos: AppleIcon,
  linux: LinuxIcon,
  web: GlobeIcon,
  android: AndroidIcon,
  ios: AppleIcon,
} satisfies Record<FeedbackPlatform, typeof WindowsIcon>

const PLATFORM_ICON_CLASSES = {
  windows: 'bg-primary/12 text-primary',
  macos: 'bg-foreground/8 text-foreground',
  linux: 'bg-chart-2/12 text-chart-2',
  web: 'bg-chart-1/12 text-chart-1',
  android: 'bg-chart-3/12 text-chart-3',
  ios: 'bg-chart-4/12 text-chart-4',
} satisfies Record<FeedbackPlatform, string>

function FeedbackPlatformOption({
  platform,
}: {
  platform: (typeof FEEDBACK_PLATFORMS)[number]
}) {
  const Icon = PLATFORM_ICONS[platform.value]

  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-md',
          PLATFORM_ICON_CLASSES[platform.value],
        )}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="truncate">{platform.label}</span>
    </span>
  )
}

export function FeedbackCreateForm() {
  const auth = useAuth()
  const prefix = useAppRoutePrefix()
  const navigate = useNavigate()
  const token = auth.session?.token
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<FeedbackCategory | ''>('')
  const [area, setArea] = useState<FeedbackArea | ''>('')
  const [platform, setPlatform] = useState<FeedbackPlatform | ''>('')
  const normalizedTitle = title.trim()
  const selectedPlatform = FEEDBACK_PLATFORMS.find(
    (item) => item.value === platform,
  )

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
      Boolean(category) &&
      Boolean(platform),
    [category, description, normalizedTitle, platform],
  )

  const createMutation = useMutation({
    mutationFn: () =>
      createFeedbackSuggestion(token!, {
        title: normalizedTitle,
        description: description.trim(),
        category: category as FeedbackCategory,
        area: area || undefined,
        platform: platform as FeedbackPlatform,
      }),
    onSuccess: () => {
      toast.success('Обращение отправлено на модерацию')
      void navigate({
        to: `${prefix}/feedback`,
        search: { view: 'mine' },
      })
    },
    onError: () => {
      toast.error('Не удалось отправить обращение')
    },
  })

  return (
    <div className="gradient-surface-content flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="gradient-surface-chrome flex h-14 shrink-0 items-center gap-2 border-b border-shell-divider px-3 sm:px-5">
        <Button variant="ghost" size="icon" asChild>
          <Link to={`${prefix}/feedback`} search={{ view: 'all' }} aria-label="Назад к идеям">
            <ChevronLeftIcon className="size-5" />
          </Link>
        </Button>
        <h1 className="text-base font-semibold sm:text-lg">Добавить обращение</h1>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <form
          className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-8 sm:py-8"
          onSubmit={(event) => {
            event.preventDefault()
            if (canSubmit && !createMutation.isPending) createMutation.mutate()
          }}
        >
          <section className="space-y-3" aria-labelledby="feedback-category-label">
            <div>
              <Label id="feedback-category-label">Тип обращения</Label>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Выберите, сообщаете ли вы о проблеме или предлагаете новую возможность.
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {FEEDBACK_CATEGORIES.map((item) => {
                const selected = category === item.value
                const Icon = item.value === 'bug' ? BugIcon : LightbulbIcon
                return (
                  <button
                    key={item.value}
                    type="button"
                    className={cn(
                      'gradient-surface-input flex min-h-20 items-center gap-3 rounded-lg border px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                      selected
                        ? 'border-primary/55 bg-primary/10 text-foreground'
                        : 'border-shell-divider bg-muted/10 text-muted-foreground hover:border-primary/30 hover:bg-muted/20 hover:text-foreground',
                    )}
                    aria-pressed={selected}
                    onClick={() => setCategory(item.value)}
                  >
                    <span
                      className={cn(
                        'flex size-10 shrink-0 items-center justify-center rounded-lg border',
                        selected
                          ? 'border-primary/35 bg-primary/12 text-primary'
                          : 'border-shell-divider bg-background/30',
                      )}
                    >
                      <Icon className="size-5" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{item.label}</span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                        {item.description}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </section>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="feedback-area">Область <span className="font-normal text-muted-foreground">— необязательно</span></Label>
              <Select value={area} onValueChange={(value) => setArea(value as FeedbackArea)}>
                <SelectTrigger id="feedback-area" className="h-11 w-full">
                  <SelectValue placeholder="Выберите область" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {FEEDBACK_AREAS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="feedback-platform">Платформа</Label>
              <Select
                value={platform}
                onValueChange={(value) => setPlatform(value as FeedbackPlatform)}
              >
                <SelectTrigger id="feedback-platform" className="h-11 w-full">
                  <SelectValue placeholder="Выберите платформу">
                    {selectedPlatform ? (
                      <FeedbackPlatformOption platform={selectedPlatform} />
                    ) : null}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {FEEDBACK_PLATFORMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        <FeedbackPlatformOption platform={item} />
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          </div>

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
              <div className="gradient-surface-card overflow-hidden rounded-lg border border-shell-divider bg-card/20">
                {similarQuery.isLoading ? (
                  <div className="p-4 text-sm text-muted-foreground">Ищем похожие обращения…</div>
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
                        <span className="mt-1 flex flex-wrap items-center gap-2">
                          <FeedbackCategoryBadge category={suggestion.category} />
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

          <div className="flex items-start gap-2 text-sm leading-6 text-muted-foreground">
            <InfoIcon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
            <p>Перед публикацией обращение пройдёт модерацию.</p>
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
