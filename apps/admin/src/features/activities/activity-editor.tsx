import { useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Effect } from 'effect'

import {
  useAdminDraftRegistration,
  type AdminDraftController,
} from '#/components/draft-controller-context'
import { IconDropzone } from '#/components/icon-dropzone'
import {
  AdminPage,
  AdminSection,
  AdminSectionHeader,
} from '#/components/layout/page'
import { AdminUnsavedChangesBar } from '#/components/unsaved-changes-bar'
import {
  CopyIcon,
  ExternalLinkIcon,
  KeyIcon,
  PlusIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from '#/components/icons'
import { Alert, AlertDescription, AlertTitle } from '@syrnike13/ui/primitives/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@syrnike13/ui/primitives/alert-dialog'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@syrnike13/ui/primitives/field'
import { Input } from '@syrnike13/ui/primitives/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@syrnike13/ui/primitives/input-group'
import { Switch } from '@syrnike13/ui/primitives/switch'
import { Textarea } from '@syrnike13/ui/primitives/textarea'
import {
  ACTIVITY_DESCRIPTION_MAX_LENGTH,
  ACTIVITY_MAX_PARTICIPANTS_MAX,
  ACTIVITY_MAX_PARTICIPANTS_MIN,
  ACTIVITY_NAME_MAX_LENGTH,
  activityToForm,
  emptyActivityForm,
  formToCreatePayload,
  formToEditPayload,
  hasActivityFormErrors,
  isActivityFormDirty,
  newActivityMapping,
  validateActivityForm,
  type ActivityFormErrorKey,
  type ActivityFormErrors,
  type ActivityFormState,
  type ActivityMappingFormState,
} from '#/features/activities/activity-form'
import {
  ACTIVITY_ICON_UPLOAD_TAG,
  createAdminActivityEffect,
  deleteAdminActivityEffect,
  rotateAdminActivitySecretEffect,
  updateAdminActivityEffect,
  type AdminActivityApplication,
} from '#/features/api/activities-api'
import { uploadMediaFileEffect } from '#/features/api/media-api'
import { useAuth } from '#/features/auth/auth-context'
import { queryKeys } from '#/lib/api/query-keys'
import { badgeIconUrl } from '#/lib/media'

const ERROR_PARAMS = {
  nameMax: ACTIVITY_NAME_MAX_LENGTH,
  descriptionMax: ACTIVITY_DESCRIPTION_MAX_LENGTH,
  min: ACTIVITY_MAX_PARTICIPANTS_MIN,
  max: ACTIVITY_MAX_PARTICIPANTS_MAX,
}

export function ActivityEditorPage({
  mode,
  activity,
}: {
  mode: 'create' | 'edit'
  activity?: AdminActivityApplication
}) {
  const t = useTranslations('activities.editor')
  const tm = useTranslations('media')
  const auth = useAuth()
  const token = auth.session?.token
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const baseline = useMemo(
    () => (activity ? activityToForm(activity) : emptyActivityForm),
    [activity],
  )

  const [form, setForm] = useState<ActivityFormState>(baseline)
  const [iconFile, setIconFile] = useState<File | null>(null)
  const [removeIcon, setRemoveIcon] = useState(false)
  const [showErrors, setShowErrors] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [rotateOpen, setRotateOpen] = useState(false)
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  // Kept locally: updating the cached application would reset unsaved edits.
  const [secretRotated, setSecretRotated] = useState(false)
  const hasClientSecret = Boolean(activity?.has_client_secret) || secretRotated

  useEffect(() => {
    setForm(baseline)
    setIconFile(null)
    setRemoveIcon(false)
    setShowErrors(false)
  }, [baseline])

  const dirty = isActivityFormDirty(form, baseline, iconFile, removeIcon)
  const errors = useMemo(() => validateActivityForm(form), [form])
  const visibleErrors: ActivityFormErrors = showErrors ? errors : { mappings: {} }

  const previewUrl = useMemo(() => {
    if (iconFile) return URL.createObjectURL(iconFile)
    if (removeIcon) return null
    return activity ? badgeIconUrl(activity.icon) : null
  }, [activity, iconFile, removeIcon])

  useEffect(() => {
    if (!iconFile || !previewUrl) return
    return () => URL.revokeObjectURL(previewUrl)
  }, [iconFile, previewUrl])

  const replaceCached = (updated: AdminActivityApplication) => {
    queryClient.setQueryData<AdminActivityApplication[]>(
      queryKeys.admin.activities,
      (current = []) =>
        current.map((item) => (item._id === updated._id ? updated : item)),
    )
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      Effect.runPromise(
        Effect.gen(function*() {
          if (!token) return yield* Effect.fail(new Error(t('noSession')))
          const iconFileId = iconFile
            ? yield* uploadMediaFileEffect(
                token,
                ACTIVITY_ICON_UPLOAD_TAG,
                iconFile,
                tm,
              )
            : undefined
          if (mode === 'create' || !activity) {
            return yield* createAdminActivityEffect(
              token,
              formToCreatePayload(form, iconFileId),
            )
          }
          return yield* updateAdminActivityEffect(
            token,
            activity._id,
            formToEditPayload(form, iconFileId, removeIcon && !iconFile),
          )
        }),
      ),
    onSuccess: (saved) => {
      if (mode === 'create') {
        queryClient.setQueryData<AdminActivityApplication[]>(
          queryKeys.admin.activities,
          (current = []) => [...current, saved],
        )
        void navigate({
          to: '/activities/$activityId',
          params: { activityId: saved._id },
          ignoreBlocker: true,
        })
        return
      }
      replaceCached(saved)
    },
    onError: () => {
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () =>
      Effect.runPromise(
        Effect.gen(function*() {
          if (!token || !activity) {
            return yield* Effect.fail(new Error(t('noSession')))
          }
          yield* deleteAdminActivityEffect(token, activity._id)
          return activity
        }),
      ),
    onSuccess: (deleted) => {
      queryClient.setQueryData<AdminActivityApplication[]>(
        queryKeys.admin.activities,
        (current = []) => current.filter((item) => item._id !== deleted._id),
      )
      void navigate({ to: '/activities', ignoreBlocker: true })
    },
    onError: () => {
    },
  })

  const rotateMutation = useMutation({
    mutationFn: () =>
      Effect.runPromise(
        Effect.gen(function*() {
          if (!token || !activity) {
            return yield* Effect.fail(new Error(t('noSession')))
          }
          return yield* rotateAdminActivitySecretEffect(token, activity._id)
        }),
      ),
    onSuccess: ({ client_secret }) => {
      setSecretRotated(true)
      setRotateOpen(false)
      setClientSecret(client_secret)
    },
    onError: () => {
    },
  })

  const busy =
    saveMutation.isPending ||
    deleteMutation.isPending ||
    rotateMutation.isPending

  const save = useCallback(async () => {
    if (saveMutation.isPending) return false
    if (hasActivityFormErrors(errors)) {
      setShowErrors(true)
      return false
    }
    try {
      await saveMutation.mutateAsync()
      return true
    } catch {
      return false
    }
  }, [errors, saveMutation, t])

  const reset = useCallback(() => {
    if (saveMutation.isPending) return false
    setForm(baseline)
    setIconFile(null)
    setRemoveIcon(false)
    setShowErrors(false)
    return true
  }, [baseline, saveMutation.isPending])

  const draftRegistration = useMemo<AdminDraftController>(
    () => ({
      isDirty: dirty,
      isSaving: saveMutation.isPending,
      save,
      reset,
    }),
    [dirty, reset, save, saveMutation.isPending],
  )
  useAdminDraftRegistration(draftRegistration)

  const errorText = (key: ActivityFormErrorKey | undefined) =>
    key ? t(`errors.${key}`, ERROR_PARAMS) : undefined

  const updateMapping = (
    key: string,
    patch: Partial<Omit<ActivityMappingFormState, 'key'>>,
  ) => {
    setForm((current) => ({
      ...current,
      urlMappings: current.urlMappings.map((mapping) =>
        mapping.key === key ? { ...mapping, ...patch } : mapping,
      ),
    }))
  }

  const copySecret = async () => {
    if (!clientSecret) return
    try {
      await navigator.clipboard.writeText(clientSecret)
    } catch {
    }
  }

  return (
    <AdminPage
      title={mode === 'create' ? t('newActivity') : form.name || t('activityFallback')}
      back={{ to: '/activities', label: t('backActivities') }}
    >
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <div className="grid gap-5 lg:badge-editor-grid">
          <div className="min-w-0 space-y-5">
            <AdminSection className="p-4 sm:p-5">
              <div className="grid gap-4">
                <TextField
                  label={t('id')}
                  description={mode === 'create' ? t('idHint') : t('idImmutable')}
                  error={errorText(visibleErrors.id)}
                >
                  <Input
                    value={form.id}
                    className="font-mono"
                    disabled={mode === 'edit'}
                    aria-invalid={Boolean(visibleErrors.id)}
                    placeholder={t('idPlaceholder')}
                    onChange={(e) =>
                      setForm({ ...form, id: e.target.value.toLowerCase() })
                    }
                  />
                </TextField>
                <TextField label={t('name')} error={errorText(visibleErrors.name)}>
                  <Input
                    value={form.name}
                    maxLength={ACTIVITY_NAME_MAX_LENGTH}
                    aria-invalid={Boolean(visibleErrors.name)}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </TextField>
                <TextField
                  label={t('description')}
                  error={errorText(visibleErrors.description)}
                >
                  <Textarea
                    value={form.description}
                    rows={2}
                    maxLength={ACTIVITY_DESCRIPTION_MAX_LENGTH}
                    aria-invalid={Boolean(visibleErrors.description)}
                    onChange={(e) =>
                      setForm({ ...form, description: e.target.value })
                    }
                  />
                </TextField>
                <TextField
                  label={t('originUrl')}
                  description={t('originUrlHint')}
                  error={errorText(visibleErrors.originUrl)}
                >
                  <Input
                    value={form.originUrl}
                    className="font-mono"
                    inputMode="url"
                    placeholder={t('urlPlaceholder')}
                    aria-invalid={Boolean(visibleErrors.originUrl)}
                    onChange={(e) => setForm({ ...form, originUrl: e.target.value })}
                  />
                </TextField>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    label={t('maxParticipants')}
                    error={errorText(visibleErrors.maxParticipants)}
                  >
                    <Input
                      value={form.maxParticipants}
                      inputMode="numeric"
                      className="font-mono"
                      aria-invalid={Boolean(visibleErrors.maxParticipants)}
                      onChange={(e) =>
                        setForm({ ...form, maxParticipants: e.target.value })
                      }
                    />
                  </TextField>
                  <div className="space-y-3 pt-1">
                    <SwitchRow
                      label={t('enabled')}
                      checked={form.enabled}
                      onCheckedChange={(enabled) => setForm({ ...form, enabled })}
                    />
                    <SwitchRow
                      label={t('firstParty')}
                      checked={form.firstParty}
                      onCheckedChange={(firstParty) =>
                        setForm({ ...form, firstParty })
                      }
                    />
                  </div>
                </div>
              </div>
            </AdminSection>

            <AdminSection>
              <AdminSectionHeader>{t('mappingsTitle')}</AdminSectionHeader>
              <div className="space-y-3 p-4">
                <p className="text-xs leading-5 text-muted-foreground">
                  {t('mappingsDescription')}
                </p>
                {form.urlMappings.map((mapping) => {
                  const rowErrors = visibleErrors.mappings[mapping.key]
                  return (
                    <div
                      key={mapping.key}
                      className="flex flex-col gap-2 sm:flex-row sm:items-start"
                    >
                      <Field
                        className="sm:w-44"
                        data-invalid={Boolean(rowErrors?.prefix) || undefined}
                      >
                        <InputGroup>
                          <InputGroupAddon className="font-mono">
                            /.proxy/
                          </InputGroupAddon>
                          <InputGroupInput
                            value={mapping.prefix}
                            className="font-mono"
                            aria-label={t('mappingPrefix')}
                            placeholder={t('mappingPrefixPlaceholder')}
                            aria-invalid={Boolean(rowErrors?.prefix)}
                            onChange={(e) =>
                              updateMapping(mapping.key, {
                                prefix: e.target.value.toLowerCase(),
                              })
                            }
                          />
                        </InputGroup>
                        {rowErrors?.prefix ? (
                          <FieldError>{errorText(rowErrors.prefix)}</FieldError>
                        ) : null}
                      </Field>
                      <Field
                        className="min-w-0 flex-1"
                        data-invalid={Boolean(rowErrors?.target) || undefined}
                      >
                        <Input
                          value={mapping.target}
                          className="font-mono"
                          inputMode="url"
                          aria-label={t('mappingTarget')}
                          placeholder={t('urlPlaceholder')}
                          aria-invalid={Boolean(rowErrors?.target)}
                          onChange={(e) =>
                            updateMapping(mapping.key, { target: e.target.value })
                          }
                        />
                        {rowErrors?.target ? (
                          <FieldError>{errorText(rowErrors.target)}</FieldError>
                        ) : null}
                      </Field>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="self-end sm:self-start"
                        aria-label={t('removeMapping')}
                        onClick={() =>
                          setForm((current) => ({
                            ...current,
                            urlMappings: current.urlMappings.filter(
                              (item) => item.key !== mapping.key,
                            ),
                          }))
                        }
                      >
                        <XIcon className="size-4" aria-hidden />
                      </Button>
                    </div>
                  )
                })}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setForm((current) => ({
                      ...current,
                      urlMappings: [...current.urlMappings, newActivityMapping()],
                    }))
                  }
                >
                  <PlusIcon className="size-4" aria-hidden />
                  {t('addMapping')}
                </Button>
              </div>
            </AdminSection>
          </div>

          <div className="min-w-0 space-y-3">
            <AdminSection className="p-4">
              <IconDropzone
                file={iconFile}
                previewUrl={previewUrl}
                disabled={busy}
                onFileChange={(file) => {
                  setIconFile(file)
                  setRemoveIcon(false)
                }}
              />
              {mode === 'edit' && (activity?.icon || removeIcon || iconFile) ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-2 w-full"
                  disabled={busy}
                  onClick={() => {
                    setIconFile(null)
                    setRemoveIcon((current) => !current)
                  }}
                >
                  <XIcon className="size-4" aria-hidden />
                  {removeIcon ? t('cancelRemoveIcon') : t('removeIcon')}
                </Button>
              ) : null}
            </AdminSection>

            {mode === 'edit' && activity ? (
              <>
                <AdminSection>
                  <AdminSectionHeader>{t('activityUrl')}</AdminSectionHeader>
                  <p className="px-4 py-3 text-xs">
                    <a
                      href={activity.activity_url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-w-0 items-center gap-1.5 text-primary hover:underline"
                    >
                      <span className="truncate font-mono">{activity.activity_url}</span>
                      <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden />
                    </a>
                  </p>
                </AdminSection>

                <AdminSection>
                  <AdminSectionHeader>{t('credentialsTitle')}</AdminSectionHeader>
                  <div className="space-y-3 p-4 text-xs">
                    <div className="space-y-1">
                      <div className="text-muted-foreground">{t('clientId')}</div>
                      <div className="truncate font-mono">{activity._id}</div>
                    </div>
                    <div className="text-muted-foreground">
                      {hasClientSecret
                        ? t('secretPresent')
                        : t('secretMissing')}
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full"
                      disabled={busy}
                      onClick={() =>
                        hasClientSecret
                          ? setRotateOpen(true)
                          : rotateMutation.mutate()
                      }
                    >
                      <KeyIcon className="size-4" aria-hidden />
                      {hasClientSecret
                        ? t('rotateSecret')
                        : t('generateSecret')}
                    </Button>
                  </div>
                </AdminSection>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2Icon className="size-4" aria-hidden />
                  {t('delete')}
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </form>

      <AdminUnsavedChangesBar
        saveLabel={mode === 'create' ? t('create') : undefined}
      />

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deleteDescription', { name: activity?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate()}
            >
              {t('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={rotateOpen} onOpenChange={setRotateOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('rotateTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('rotateDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rotateMutation.isPending}>
              {t('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={rotateMutation.isPending}
              onClick={() => rotateMutation.mutate()}
            >
              {t('rotateSecret')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={clientSecret !== null}
        onOpenChange={(open) => {
          if (!open) setClientSecret(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('secretTitle')}</AlertDialogTitle>
          </AlertDialogHeader>
          <Alert variant="destructive">
            <TriangleAlertIcon aria-hidden />
            <AlertTitle>{t('secretWarningTitle')}</AlertTitle>
            <AlertDescription>{t('secretWarning')}</AlertDescription>
          </Alert>
          <InputGroup>
            <InputGroupInput
              readOnly
              value={clientSecret ?? ''}
              className="font-mono"
              aria-label={t('secretTitle')}
              onFocus={(e) => e.currentTarget.select()}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                aria-label={t('copySecret')}
                title={t('copySecret')}
                onClick={() => void copySecret()}
              >
                <CopyIcon aria-hidden />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setClientSecret(null)}>
              {t('secretDone')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminPage>
  )
}

function TextField({
  label,
  description,
  error,
  children,
}: {
  label: string
  description?: string
  error?: string
  children: ReactNode
}) {
  return (
    <Field data-invalid={Boolean(error) || undefined}>
      <FieldLabel>{label}</FieldLabel>
      {children}
      {error ? (
        <FieldError>{error}</FieldError>
      ) : description ? (
        <FieldDescription>{description}</FieldDescription>
      ) : null}
    </Field>
  )
}

function SwitchRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  )
}
