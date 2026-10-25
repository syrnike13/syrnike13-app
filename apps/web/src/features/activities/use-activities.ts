import { useCallback, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Effect } from 'effect'

import { useAuth } from '#/features/auth/auth-context'
import { queryKeys } from '#/lib/api/query-keys'
import { attachmentPreviewUrl } from '#/lib/media'
import {
  fetchActivityApplicationsEffect,
  type ActivityApplication,
} from './activity-api'
import { activityStore } from './activity-store'

const CATALOG_STALE_MS = 10 * 60_000

/** Running instance in a voice channel, or null. */
export function useActivityInstance(channelId: string | null | undefined) {
  const getSnapshot = useCallback(
    () =>
      channelId
        ? activityStore.instanceForChannel(channelId)
        : null,
    [channelId],
  )
  return useSyncExternalStore(activityStore.subscribe, getSnapshot, getSnapshot)
}

export function useActivityConnectionStatus() {
  const getSnapshot = useCallback(() => activityStore.status, [])
  return useSyncExternalStore(activityStore.subscribe, getSnapshot, getSnapshot)
}

/** Enabled Activity Applications; fetched once per session and cached. */
export function useActivityApplications(enabled = true) {
  const token = useAuth().session?.token
  return useQuery({
    queryKey: queryKeys.activities.applications,
    queryFn: ({ signal }) =>
      Effect.runPromise(fetchActivityApplicationsEffect(token!), { signal }),
    enabled: enabled && Boolean(token),
    staleTime: CATALOG_STALE_MS,
  })
}

export function useActivityApplication(applicationId: string | null | undefined) {
  const { data } = useActivityApplications(Boolean(applicationId))
  return applicationId
    ? (data?.find((application) => application._id === applicationId) ?? null)
    : null
}

export function activityApplicationIconUrl(application: ActivityApplication) {
  return application.icon ? attachmentPreviewUrl(application.icon) : null
}
