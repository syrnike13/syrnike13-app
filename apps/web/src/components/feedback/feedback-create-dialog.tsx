import type {
  FeedbackArea,
  FeedbackCategory,
  FeedbackPlatform,
} from '@syrnike13/api-types'
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { toast } from 'sonner'

import {
  FEEDBACK_AREAS,
  FEEDBACK_CATEGORIES,
  FEEDBACK_PLATFORMS,
  feedbackAreaLabel,
  feedbackPlatformLabel,
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
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeOffIcon,
  GlobeIcon,
  LightbulbIcon,
  LinuxIcon,
  UserIcon,
  WindowsIcon,
} from '#/components/icons'
import { Button } from '#/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#/components/ui/dialog'
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

const STEPS = [
  { id: 'type', label: 'Тип' },
  { id: 'text', label: 'Текст' },
  { id: 'review', label: 'Проверка' },
] as const

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

export function FeedbackCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: () => void
}) {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const prefix = useAppRoutePrefix()
  const token = auth.session?.token
  const viewerId = auth.user?._id
  const [step, setStep] = useState(0)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<FeedbackCategory | ''>('')
  const [area, setArea] = useState<FeedbackArea | ''>('')
  const [platform, setPlatform] = useState<FeedbackPlatform | ''>('')
  const [anonymous, setAnonymous] = useState(false)
  const normalizedTitle = title.trim()
  const selectedPlatform = FEEDBACK_PLATFORMS.find(
    (item) => item.value === platform,
  )

  const similarQuery = useQuery({
    queryKey: queryKeys.feedback.list(viewerId ?? 'pending-session', {
      similar: normalizedTitle,
    }),
    queryFn: () =>
      fetchFeedbackSuggestions(token!, {
        search: normalizedTitle,
        sort: 'popular',
        offset: 0,
        limit: 3,
      }),
    enabled: open && step === 1 && Boolean(token && viewerId) && normalizedTitle.length >= 4,
    staleTime: 30_000,
  })

  const similar = similarQuery.data?.suggestions ?? []

  const stepValid = useMemo(() => {
    if (step === 0) return Boolean(category)
    if (step === 1) {
      return (
        Boolean(platform) &&
        normalizedTitle.length >= 4 &&
        description.trim().length >= 10
      )
    }
    return true
  }, [category, description, normalizedTitle, platform, step])

  const isLastStep = step === STEPS.length - 1

  function resetWizard() {
    setStep(0)
    setTitle('')
    setDescription('')
    setCategory('')
    setArea('')
    setPlatform('')
    setAnonymous(false)
  }

  const createMutation = useMutation({
    mutationFn: (isAnonymous: boolean) =>
      createFeedbackSuggestion(token!, {
        title: normalizedTitle,
        description: description.trim(),
        category: category as FeedbackCategory,
        area: area || undefined,
        platform: platform as FeedbackPlatform,
        anonymous: isAnonymous,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.feedback.all })
      toast.success('Обращение отправлено на модерацию')
      resetWizard()
      onOpenChange(false)
      onCreated?.()
    },
    onError: () => {
      toast.error('Не удалось отправить обращение')
    },
  })

  function handleNext() {
    if (!stepValid || createMutation.isPending) return
    if (isLastStep) {
      createMutation.mutate(anonymous)
      return
    }
    setStep((current) => current + 1)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 gap-1 border-b border-shell-divider px-6 pt-4 pb-3">
          <DialogTitle>Добавить обращение</DialogTitle>
          <DialogDescription>
            {step === 0 && 'Начнём с типа обращения — это займёт меньше минуты.'}
            {step === 1 && 'Уточните, где это проявляется, и опишите своими словами.'}
            {step === 2 && 'Проверьте обращение перед отправкой на модерацию.'}
          </DialogDescription>
          <ol className="flex items-center gap-2 pt-2">
            {STEPS.map((item, index) => (
              <li key={item.id} className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors',
                    index < step
                      ? 'bg-primary text-primary-foreground'
                      : index === step
                        ? 'border-2 border-primary text-primary'
                        : 'border border-border text-muted-foreground',
                  )}
                >
                  {index < step ? (
                    <CheckIcon className="size-3.5" aria-hidden />
                  ) : (
                    index + 1
                  )}
                </span>
                <span
                  className={cn(
                    'text-xs font-medium',
                    index === step ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {item.label}
                </span>
                {index < STEPS.length - 1 ? (
                  <span className="mx-1 h-px w-8 bg-border" aria-hidden />
                ) : null}
              </li>
            ))}
          </ol>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1">
          <form
            id="feedback-create-form"
            className="space-y-6 px-6 py-5"
            onSubmit={(event) => {
              event.preventDefault()
              handleNext()
            }}
          >
            {step === 0 ? (
              <>
                <section className="space-y-3" aria-labelledby="feedback-category-label">
                  <Label id="feedback-category-label">Тип обращения</Label>
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
              </>
            ) : null}

            {step === 1 ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="feedback-area">Область <span className="font-normal text-muted-foreground">— необязательно</span></Label>
                    <Select
                      value={area}
                      onValueChange={(value) => setArea(value as FeedbackArea)}
                    >
                      <SelectTrigger id="feedback-area" className="h-11 w-full">
                        <SelectValue placeholder="Выберите область" />
                      </SelectTrigger>
                      <SelectContent
                        position="popper"
                        side="bottom"
                        align="start"
                        sideOffset={8}
                      >
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
                      <SelectContent
                        position="popper"
                        side="bottom"
                        align="start"
                        sideOffset={8}
                      >
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
                            onClick={() => onOpenChange(false)}
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
              </>
            ) : null}

            {step === 2 ? (
              <>
                <dl className="space-y-3 rounded-lg border border-shell-divider bg-muted/10 p-4 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="shrink-0 text-muted-foreground">Тип</dt>
                    <dd>{category ? <FeedbackCategoryBadge category={category} /> : '—'}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="shrink-0 text-muted-foreground">Область</dt>
                    <dd className="truncate">{area ? feedbackAreaLabel(area) : '—'}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="shrink-0 text-muted-foreground">Платформа</dt>
                    <dd className="truncate">{platform ? feedbackPlatformLabel(platform) : '—'}</dd>
                  </div>
                  <div className="border-t border-shell-divider pt-3">
                    <dt className="text-muted-foreground">Название</dt>
                    <dd className="mt-1 font-semibold">{normalizedTitle}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Описание</dt>
                    <dd className="mt-1 line-clamp-4 leading-6 whitespace-pre-wrap text-foreground/90">
                      {description.trim()}
                    </dd>
                  </div>
                </dl>

                <section className="space-y-3" aria-labelledby="feedback-author-label">
                  <div>
                    <Label id="feedback-author-label">От чьего имени опубликовать</Label>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      При анонимной публикации ваше имя увидят только модераторы.
                    </p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {([
                      {
                        value: false,
                        icon: UserIcon,
                        label: auth.user?.username ? `@${auth.user.username}` : 'От моего имени',
                        hint: 'Имя будет видно всем',
                      },
                      {
                        value: true,
                        icon: EyeOffIcon,
                        label: 'Анонимно',
                        hint: 'Имя увидят только модераторы',
                      },
                    ] as const).map((option) => {
                      const selected = anonymous === option.value
                      const Icon = option.icon
                      return (
                        <button
                          key={option.label}
                          type="button"
                          className={cn(
                            'gradient-surface-input flex items-center gap-3 rounded-lg border px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                            selected
                              ? 'border-primary/55 bg-primary/10 text-foreground'
                              : 'border-shell-divider bg-muted/10 text-muted-foreground hover:border-primary/30 hover:bg-muted/20 hover:text-foreground',
                          )}
                          aria-pressed={selected}
                          onClick={() => setAnonymous(option.value)}
                        >
                          <Icon className={cn('size-5 shrink-0', selected && 'text-primary')} aria-hidden />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold">{option.label}</span>
                            <span className="block text-xs text-muted-foreground">{option.hint}</span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              </>
            ) : null}
          </form>
        </ScrollArea>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-shell-divider bg-muted/20 px-6 py-4">
          <Button
            type="button"
            variant="ghost"
            disabled={step === 0 || createMutation.isPending}
            onClick={() => setStep((current) => Math.max(0, current - 1))}
          >
            <ChevronLeftIcon className="size-4" data-icon="inline-start" />
            Назад
          </Button>
          <Button
            type="submit"
            form="feedback-create-form"
            disabled={!stepValid || createMutation.isPending}
          >
            {isLastStep ? (
              createMutation.isPending ? 'Отправляем…' : 'Отправить на модерацию'
            ) : (
              <>
                Далее
                <ChevronRightIcon className="size-4" data-icon="inline-end" />
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
