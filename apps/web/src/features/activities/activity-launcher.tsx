import { useState } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Button } from '@syrnike13/ui/primitives/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@syrnike13/ui/primitives/empty'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@syrnike13/ui/primitives/item'
import { Spinner } from '@syrnike13/ui/primitives/spinner'

import { canUseActivities } from '#/features/authorization/authorization'
import { useSyncStore } from '#/features/sync/sync-store'
import { ActivityApplicationIcon } from './activity-application-icon'
import { activityErrorMessage } from './activity-errors'
import { activityStore } from './activity-store'
import {
  useActivityApplications,
  useActivityConnectionStatus,
} from './use-activities'

type ActivityLauncherProps = {
  channelId: string
  onClose: () => void
}

/** Catalog of Activity Applications for the current voice channel. */
export function ActivityLauncher({ channelId, onClose }: ActivityLauncherProps) {
  const t = useTranslations('activities')
  const applications = useActivityApplications()
  const connection = useActivityConnectionStatus()
  // Subscribes to authorization snapshot changes for this channel.
  const allowed = useSyncStore(() => canUseActivities(channelId))
  const [starting, setStarting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const start = (applicationId: string) => {
    if (starting) return
    setStarting(applicationId)
    setError(null)
    activityStore
      .start(channelId, applicationId)
      .catch((cause: unknown) => setError(activityErrorMessage(cause, t)))
      .finally(() => setStarting(null))
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4 sm:p-6">
      <section
        aria-labelledby="activity-launcher-title"
        className="flex max-h-full w-full max-w-2xl min-w-0 flex-col gap-4 overflow-hidden rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xl sm:p-6"
      >
        <header className="flex flex-col gap-1">
          <h2 id="activity-launcher-title" className="text-xl font-semibold">
            {t('title')}
          </h2>
          <p className="text-sm text-muted-foreground">
            {allowed ? t('description') : t('missingPermission')}
          </p>
        </header>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="min-h-0 overflow-y-auto">
          {applications.isPending ? (
            <div
              role="status"
              className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
            >
              <Spinner className="size-4" />
              {t('loading')}
            </div>
          ) : applications.isError ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t('loadError')}</EmptyTitle>
              </EmptyHeader>
              <Button
                type="button"
                variant="outline"
                onClick={() => void applications.refetch()}
              >
                {t('retry')}
              </Button>
            </Empty>
          ) : applications.data.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t('emptyTitle')}</EmptyTitle>
                <EmptyDescription>{t('emptyDescription')}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ItemGroup>
              {applications.data.map((application) => (
                <Item key={application._id} variant="outline">
                  <ItemMedia>
                    <ActivityApplicationIcon
                      application={application}
                      className="size-12"
                    />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{application.name}</ItemTitle>
                    {application.description ? (
                      <ItemDescription>{application.description}</ItemDescription>
                    ) : null}
                  </ItemContent>
                  <ItemActions>
                    <Button
                      type="button"
                      disabled={
                        !allowed ||
                        starting !== null ||
                        connection !== 'connected'
                      }
                      onClick={() => start(application._id)}
                    >
                      {starting === application._id ? (
                        <Spinner data-icon="inline-start" />
                      ) : null}
                      {t('start')}
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          )}
        </div>

        <div>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('back')}
          </Button>
        </div>
      </section>
    </div>
  )
}
