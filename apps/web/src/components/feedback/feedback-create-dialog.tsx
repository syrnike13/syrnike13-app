import type {
  FeedbackArea,
  FeedbackCategory,
  FeedbackPeripheral,
  FeedbackPlatform,
  FeedbackSystem,
} from '@syrnike13/api-types'
import * as ApiSchema from '@syrnike13/api-types/effect-schema'
import { Effect, Option, Schema } from 'effect'
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useLocale, useTranslations } from '@syrnike13/ui/i18n'

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
  FeedbackPeripheralsSummary,
  FeedbackSystemFields,
  FeedbackSystemSummary,
  PERIPHERALS_MAX,
  type EditablePeripheral,
} from '#/components/feedback/feedback-system'
import { ComposerAttachmentStrip } from '#/components/chat/composer-attachment-strip'
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
  PaperclipIcon,
  UserIcon,
  WindowsIcon,
} from '#/components/icons'
import { ChoiceCardGroup } from '#/components/ui/choice-card-group'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@syrnike13/ui/primitives/dialog'
import { FieldError } from '@syrnike13/ui/primitives/field'
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@syrnike13/ui/primitives/item'
import { Input } from '@syrnike13/ui/primitives/input'
import { Label } from '@syrnike13/ui/primitives/label'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { Separator } from '@syrnike13/ui/primitives/separator'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@syrnike13/ui/primitives/select'
import { Textarea } from '@syrnike13/ui/primitives/textarea'
import { useAuth } from '#/features/auth/auth-context'
import { useSyrnikeConfig } from '#/features/auth/use-syrnike-config'
import {
  createFeedbackSuggestion,
  fetchFeedbackSuggestions,
} from '#/features/api/feedback-api'
import { useComposerAttachments } from '#/features/chat/use-composer-attachments'
import {
  collectFeedbackSystem,
  hasSystemDetails,
} from '#/features/feedback/system-info'
import {
  readSystemProfile,
  writeSystemProfile,
} from '#/features/feedback/system-profile'
import { queryKeys } from '#/lib/api/query-keys'
import { cn } from '#/lib/utils'

const TITLE_MAX = 120
const DESCRIPTION_MAX = 2_000
/** Mirrors the `maxItems` of `DataCreateFeedbackSuggestion.attachments`. */
const ATTACHMENTS_MAX = 10
/** Used until `GET /` reports the configured `feedback` upload limit. */
const FALLBACK_ATTACHMENT_MAX_BYTES = 200_000_000

let peripheralKeySeed = 0

/** Stable React key for an editable device row. */
function nextPeripheralKey() {
  peripheralKeySeed += 1
  return `peripheral-${peripheralKeySeed}`
}

class FeedbackAttachmentsError extends Error {}

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
  { id: 'type', labelKey: 'stepType' },
  { id: 'text', labelKey: 'stepText' },
  { id: 'review', labelKey: 'stepReview' },
] as const

function FeedbackPlatformOption({
  platform,
}: {
  platform: (typeof FEEDBACK_PLATFORMS)[number]
}) {
  const tm = useTranslations('feedback.meta')
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
      <span className="truncate">{tm(platform.labelKey)}</span>
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
  const t = useTranslations('feedback.create')
  const tm = useTranslations('feedback.meta')
  const { locale } = useLocale()
  const auth = useAuth()
  const queryClient = useQueryClient()
  const token = auth.session?.token
  const viewerId = auth.user?._id
  const [step, setStep] = useState(0)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<FeedbackCategory | ''>('')
  const [area, setArea] = useState<FeedbackArea | ''>('')
  const [platform, setPlatform] = useState<FeedbackPlatform | ''>('')
  const [anonymous, setAnonymous] = useState(false)
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const {
    files,
    append: appendFiles,
    remove: removeFile,
    reset: resetFiles,
    start: startUploads,
    uploadAll: uploadFiles,
  } = useComposerAttachments(undefined, { tag: 'feedback' })
  const fileCountRef = useRef(files.length)
  fileCountRef.current = files.length
  const [system, setSystem] = useState<FeedbackSystem | null>(null)
  const [systemBusy, setSystemBusy] = useState(false)
  const [systemError, setSystemError] = useState<string | null>(null)
  const [peripherals, setPeripherals] = useState<EditablePeripheral[]>([])
  const [profileSaved, setProfileSaved] = useState(false)
  const limits = useSyrnikeConfig().data?.features.limits
  const attachmentMaxBytes = limits
    ? Math.min(
        limits.new_user.file_upload_size_limits.feedback ??
          FALLBACK_ATTACHMENT_MAX_BYTES,
        limits.default.file_upload_size_limits.feedback ??
          FALLBACK_ATTACHMENT_MAX_BYTES,
      )
    : FALLBACK_ATTACHMENT_MAX_BYTES
  const attachmentMaxMb = Math.floor(attachmentMaxBytes / 1_000_000)
  const normalizedTitle = title.trim()
  const selectedPlatform = FEEDBACK_PLATFORMS.find(
    (item) => item.value === platform,
  )

  const similarQuery = useQuery({
    queryKey: queryKeys.feedback.list(viewerId ?? 'pending-session', {
      similar: normalizedTitle,
    }),
    queryFn: ({ signal }) =>
      fetchFeedbackSuggestions(
        token!,
        {
          search: normalizedTitle,
          sort: 'popular',
          offset: 0,
          limit: 3,
        },
        signal,
      ),
    enabled:
      open &&
      step === 1 &&
      Boolean(token && viewerId) &&
      normalizedTitle.length >= 4,
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
    setAttachmentNotice(null)
    setSubmitError(null)
    setSystem(null)
    setSystemError(null)
    setSystemBusy(false)
    setPeripherals([])
    setProfileSaved(false)
    resetFiles()
  }

  /** Devices the author actually named; blank rows are never submitted. */
  function namedPeripherals(): FeedbackPeripheral[] {
    return peripherals
      .map(({ device, connection }) => ({ device: device.trim(), connection }))
      .filter((peripheral) => peripheral.device.length > 0)
      .slice(0, PERIPHERALS_MAX)
  }

  const submittedSystem = category === 'bug' ? system : null
  const submittedPeripherals = category === 'bug' ? namedPeripherals() : []
  const canSaveProfile = Boolean(system) || namedPeripherals().length > 0

  // Prefill the machine profile saved by an earlier report on this device.
  useEffect(() => {
    if (!open) return

    const saved = readSystemProfile()
    if (!saved) return

    setSystem((current) => current ?? saved.system)
    setPeripherals((current) =>
      current.length > 0
        ? current
        : saved.peripherals.map((peripheral) => ({
            ...peripheral,
            key: nextPeripheralKey(),
          })),
    )
    setProfileSaved(Boolean(saved.system) || saved.peripherals.length > 0)
  }, [open])

  async function collectSystem() {
    setSystemBusy(true)
    setSystemError(null)
    setProfileSaved(false)

    try {
      const collected = await collectFeedbackSystem()
      if (!hasSystemDetails(collected)) {
        setSystem(null)
        setSystemError(t('systemFailed'))
        return
      }
      setSystem(collected)
    } catch {
      setSystemError(t('systemFailed'))
    } finally {
      setSystemBusy(false)
    }
  }

  function saveProfile() {
    const saved = writeSystemProfile({
      system,
      peripherals: namedPeripherals(),
    })
    setProfileSaved(saved)
    setSystemError(saved ? null : t('systemSaveFailed'))
  }

  function addPeripheral() {
    setPeripherals((current) =>
      current.length >= PERIPHERALS_MAX
        ? current
        : [...current, { key: nextPeripheralKey(), device: '', connection: 'wired' }],
    )
  }

  function changePeripheral(
    key: string,
    patch: Partial<Omit<EditablePeripheral, 'key'>>,
  ) {
    setProfileSaved(false)
    setPeripherals((current) =>
      current.map((peripheral) =>
        peripheral.key === key ? { ...peripheral, ...patch } : peripheral,
      ),
    )
  }

  function removePeripheral(key: string) {
    setProfileSaved(false)
    setPeripherals((current) =>
      current.filter((peripheral) => peripheral.key !== key),
    )
  }

  function addFiles(fileList: FileList | File[]) {
    const accepted: File[] = []
    let notice: string | null = null
    for (const file of Array.from(fileList)) {
      if (file.size > attachmentMaxBytes) {
        notice = t('attachmentTooLarge', { name: file.name, size: attachmentMaxMb })
        continue
      }
      accepted.push(file)
    }

    // The ref also counts files appended earlier in this render cycle.
    const free = Math.max(0, ATTACHMENTS_MAX - fileCountRef.current)
    if (accepted.length > free) {
      notice = t('attachmentsLimit', { count: ATTACHMENTS_MAX })
    }
    setAttachmentNotice(notice)
    const added = accepted.slice(0, free)
    fileCountRef.current += added.length
    appendFiles(added)
  }

  // Upload right after selection so large videos are ready by submission.
  useEffect(() => {
    if (token && files.some((file) => file.status === 'pending')) {
      startUploads(token)
    }
  })

  function handleDrop(event: DragEvent) {
    event.preventDefault()
    setDragActive(false)
    if (createMutation.isPending) return
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files)
  }

  const createMutation = useMutation({
    mutationFn: async (isAnonymous: boolean) => {
      if (!category || !platform) {
        throw new Error('Feedback category and platform are required')
      }
      const attachments = await Effect.runPromise(uploadFiles(token!)).catch(
        (error: unknown) => {
          throw new FeedbackAttachmentsError(String(error))
        },
      )
      return createFeedbackSuggestion(token!, {
        title: normalizedTitle,
        description: description.trim(),
        category,
        area: area || undefined,
        platform,
        attachments: attachments.length > 0 ? attachments : undefined,
        system: submittedSystem ?? undefined,
        peripherals:
          submittedPeripherals.length > 0 ? submittedPeripherals : undefined,
        anonymous: isAnonymous,
      })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.feedback.all })
      resetWizard()
      onOpenChange(false)
      onCreated?.()
    },
    onError: (error) => {
      setSubmitError(
        error instanceof FeedbackAttachmentsError
          ? t('attachmentsFailed')
          : t('sendError'),
      )
    },
  })

  function handleNext() {
    if (!stepValid || createMutation.isPending) return
    if (isLastStep) {
      setSubmitError(null)
      createMutation.mutate(anonymous)
      return
    }
    setStep((current) => current + 1)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        // Closing would hide a submission that still creates the suggestion.
        if (!nextOpen && createMutation.isPending) return
        // A closed dialog must not keep a draft or uploads running in the background.
        if (!nextOpen) resetWizard()
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="flex max-h-dialog-sm flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 gap-1 px-6 pt-4 pb-3">
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {step === 0 && t('descriptionType')}
            {step === 1 && t('descriptionText')}
            {step === 2 && t('descriptionReview')}
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
                  {t(item.labelKey)}
                </span>
                {index < STEPS.length - 1 ? (
                  <Separator aria-hidden className="mx-1 w-8" />
                ) : null}
              </li>
            ))}
          </ol>
        </DialogHeader>
        <Separator />

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
                  <Label id="feedback-category-label">{t('category')}</Label>
                  <ChoiceCardGroup
                    label={t('category')}
                    value={category}
                    onValueChange={setCategory}
                    options={FEEDBACK_CATEGORIES.map((item) => ({
                      value: item.value,
                      label: tm(item.labelKey),
                      description: tm(item.descriptionKey),
                      icon: item.value === 'bug' ? BugIcon : LightbulbIcon,
                    }))}
                  />
                </section>
              </>
            ) : null}

            {step === 1 ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="feedback-area">
                      {t('area')}{' '}
                      <span className="font-normal text-muted-foreground">
                        {t('optional')}
                      </span>
                    </Label>
                    <Select
                      items={FEEDBACK_AREAS.map((item) => ({
                        value: item.value,
                        label: tm(item.labelKey),
                      }))}
                      value={area}
                      onValueChange={(value) => {
                        const decoded = Schema.decodeUnknownOption(
                          ApiSchema.FeedbackArea,
                        )(value)
                        if (Option.isSome(decoded)) setArea(decoded.value)
                      }}
                    >
                      <SelectTrigger id="feedback-area" className="w-full">
                        <SelectValue placeholder={t('chooseArea')} />
                      </SelectTrigger>
                      <SelectContent
                        side="bottom"
                        align="start"
                        sideOffset={8}
                      >
                        <SelectGroup>
                          {FEEDBACK_AREAS.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                              {tm(item.labelKey)}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="feedback-platform">{t('platform')}</Label>
                    <Select
                      value={platform}
                      onValueChange={(value) => {
                        const decoded = Schema.decodeUnknownOption(
                          ApiSchema.FeedbackPlatform,
                        )(value)
                        if (Option.isSome(decoded)) setPlatform(decoded.value)
                      }}
                    >
                      <SelectTrigger id="feedback-platform" className="w-full">
                        <SelectValue placeholder={t('choosePlatform')}>
                          {selectedPlatform ? (
                            <FeedbackPlatformOption platform={selectedPlatform} />
                          ) : null}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent
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
                    <Label htmlFor="feedback-title">{t('titleLabel')}</Label>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {title.length}/{TITLE_MAX}
                    </span>
                  </div>
                  <Input
                    id="feedback-title"
                    value={title}
                    maxLength={TITLE_MAX}
                    autoFocus
                    placeholder={t('titlePlaceholder')}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </div>

                {normalizedTitle.length >= 4 && (similar.length > 0 || similarQuery.isLoading) ? (
                  <section className="space-y-2" aria-labelledby="similar-feedback-title">
                    <h2 id="similar-feedback-title" className="text-sm font-semibold">
                      {t('similarTitle')}
                    </h2>
                    <div className="gradient-surface-card overflow-hidden rounded-lg border border-shell-divider bg-card/20">
                      {similarQuery.isLoading ? (
                        <div className="p-4 text-sm text-muted-foreground">
                          {t('searchingSimilar')}
                        </div>
                      ) : (
                        similar.map((suggestion) => (
                          <Link
                            key={suggestion._id}
                            to={'/feedback/$feedbackId'}
                            params={{ feedbackId: suggestion._id }}
                            className="flex items-center gap-3 border-b border-shell-divider p-3 outline-none transition-colors last:border-b-0 hover:bg-hover focus-visible:bg-hover"
                            onClick={() => onOpenChange(false)}
                          >
                            <span className="flex size-14 shrink-0 flex-col items-center justify-center rounded-md border border-primary/25 bg-primary/5 text-xs font-semibold text-primary">
                              <ArrowUpIcon className="size-4" aria-hidden />
                              {suggestion.vote_count.toLocaleString(locale)}
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
                    <Label htmlFor="feedback-description">{t('descriptionLabel')}</Label>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {description.length}/{DESCRIPTION_MAX}
                    </span>
                  </div>
                  <Textarea
                    id="feedback-description"
                    value={description}
                    maxLength={DESCRIPTION_MAX}
                    placeholder={t('descriptionPlaceholder')}
                    className="min-h-36 resize-y"
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </div>

                <section className="space-y-2" aria-labelledby="feedback-attachments-label">
                  <div className="flex items-center justify-between gap-3">
                    <Label id="feedback-attachments-label">
                      {t('attachmentsLabel')}{' '}
                      <span className="font-normal text-muted-foreground">
                        {t('optional')}
                      </span>
                    </Label>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {files.length}/{ATTACHMENTS_MAX}
                    </span>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="sr-only"
                    tabIndex={-1}
                    aria-hidden
                    onChange={(event) => {
                      if (event.target.files) addFiles(event.target.files)
                      event.target.value = ''
                    }}
                  />
                  <Item
                    variant={dragActive ? 'muted' : 'outline'}
                    render={
                      <button
                        type="button"
                        disabled={files.length >= ATTACHMENTS_MAX}
                        onClick={() => fileInputRef.current?.click()}
                        onDragOver={(event) => {
                          event.preventDefault()
                          setDragActive(true)
                        }}
                        onDragLeave={() => setDragActive(false)}
                        onDrop={handleDrop}
                      />
                    }
                  >
                    <ItemMedia variant="icon">
                      <PaperclipIcon className="size-5" aria-hidden />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{t('addAttachments')}</ItemTitle>
                      <ItemDescription>
                        {t('attachmentsHint', { size: attachmentMaxMb })}
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                  {files.length > 0 ? (
                    <div className="-mx-3">
                      <ComposerAttachmentStrip
                        files={files}
                        sending={createMutation.isPending}
                        onRemove={removeFile}
                      />
                    </div>
                  ) : null}
                  <FieldError>{attachmentNotice}</FieldError>
                </section>

                {category === 'bug' ? (
                  <FeedbackSystemFields
                    system={system}
                    busy={systemBusy}
                    error={systemError}
                    peripherals={peripherals}
                    profileSaved={profileSaved}
                    canSaveProfile={canSaveProfile}
                    onCollect={() => void collectSystem()}
                    onClear={() => {
                      setSystem(null)
                      setSystemError(null)
                      setProfileSaved(false)
                    }}
                    onAddPeripheral={addPeripheral}
                    onChangePeripheral={changePeripheral}
                    onRemovePeripheral={removePeripheral}
                    onSaveProfile={saveProfile}
                  />
                ) : null}
              </>
            ) : null}

            {step === 2 ? (
              <>
                <dl className="space-y-3 rounded-lg border border-shell-divider bg-muted/10 p-4 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="shrink-0 text-muted-foreground">{t('typeSummary')}</dt>
                    <dd>{category ? <FeedbackCategoryBadge category={category} /> : '—'}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="shrink-0 text-muted-foreground">{t('areaSummary')}</dt>
                    <dd className="truncate">
                      {area ? feedbackAreaLabel(area, tm) : '—'}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="shrink-0 text-muted-foreground">{t('platformSummary')}</dt>
                    <dd className="truncate">
                      {platform ? feedbackPlatformLabel(platform, tm) : '—'}
                    </dd>
                  </div>
                  <div className="border-t border-shell-divider pt-3">
                    <dt className="text-muted-foreground">{t('titleSummary')}</dt>
                    <dd className="mt-1 font-semibold">{normalizedTitle}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t('descriptionSummary')}</dt>
                    <dd className="mt-1 line-clamp-4 leading-6 whitespace-pre-wrap text-foreground/90">
                      {description.trim()}
                    </dd>
                  </div>
                  {files.length > 0 ? (
                    <div>
                      <dt className="text-muted-foreground">{t('attachmentsSummary')}</dt>
                      <dd className="-mx-3">
                        <ComposerAttachmentStrip
                          files={files}
                          sending={createMutation.isPending}
                          onRemove={removeFile}
                        />
                      </dd>
                    </div>
                  ) : null}
                  {submittedSystem ? (
                    <div>
                      <dt className="text-muted-foreground">{t('systemSummary')}</dt>
                      <dd className="mt-1">
                        <FeedbackSystemSummary system={submittedSystem} />
                      </dd>
                    </div>
                  ) : null}
                  {submittedPeripherals.length > 0 ? (
                    <div>
                      <dt className="text-muted-foreground">{t('peripheralsTitle')}</dt>
                      <dd className="mt-1">
                        <FeedbackPeripheralsSummary
                          peripherals={submittedPeripherals}
                        />
                      </dd>
                    </div>
                  ) : null}
                </dl>

                <section className="space-y-3" aria-labelledby="feedback-author-label">
                  <div>
                    <Label id="feedback-author-label">{t('authorLabel')}</Label>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {t('authorHint')}
                    </p>
                  </div>
                  <ChoiceCardGroup
                    label={t('authorLabel')}
                    value={anonymous ? 'anonymous' : 'me'}
                    onValueChange={(next) => setAnonymous(next === 'anonymous')}
                    options={[
                      {
                        value: 'me',
                        icon: UserIcon,
                        label: auth.user?.username
                          ? `@${auth.user.username}`
                          : t('asMe'),
                        description: t('asMeHint'),
                      },
                      {
                        value: 'anonymous',
                        icon: EyeOffIcon,
                        label: t('anonymous'),
                        description: t('anonymousHint'),
                      },
                    ]}
                  />
                </section>
              </>
            ) : null}
            {step === 2 ? <FieldError>{submitError}</FieldError> : null}
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
            {t('back')}
          </Button>
          <Button
            type="submit"
            form="feedback-create-form"
            disabled={!stepValid || createMutation.isPending}
          >
            {isLastStep ? (
              createMutation.isPending ? t('submitting') : t('submit')
            ) : (
              <>
                {t('next')}
                <ChevronRightIcon className="size-4" data-icon="inline-end" />
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
