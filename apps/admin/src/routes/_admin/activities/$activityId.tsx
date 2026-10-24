import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from '@syrnike13/ui/i18n'

import { AdminEmpty, AdminPage } from '#/components/layout/page'
import { buttonVariants } from '@syrnike13/ui/primitives/button'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { cn } from '#/lib/utils'
import { ActivityEditorPage } from '#/features/activities/activity-editor'
import { fetchAdminActivities } from '#/features/api/activities-api'
import { useAuth } from '#/features/auth/auth-context'
import { queryKeys } from '#/lib/api/query-keys'

export const Route = createFileRoute('/_admin/activities/$activityId')({
  component: EditActivityPage,
})

function EditActivityPage() {
  const t = useTranslations('activities.detail')
  const { activityId } = Route.useParams()
  const auth = useAuth()
  const token = auth.session?.token

  const activitiesQuery = useQuery({
    queryKey: queryKeys.admin.activities,
    queryFn: ({ signal }) => fetchAdminActivities(token!, signal),
    enabled: Boolean(token),
  })

  const activity = activitiesQuery.data?.find((item) => item._id === activityId)

  if (activitiesQuery.isLoading) {
    return (
      <AdminPage
        title={t('activityTitle')}
        back={{ to: '/activities', label: t('backActivities') }}
      >
        <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
          <Spinner className="mr-2 size-4" aria-hidden />
          {t('loading')}
        </div>
      </AdminPage>
    )
  }

  if (!activity) {
    return (
      <AdminPage
        title={t('notFoundTitle')}
        back={{ to: '/activities', label: t('backActivities') }}
      >
        <AdminEmpty>{t('notFound')}</AdminEmpty>
        <div className="mt-4">
          <Link
            to="/activities"
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
          >
            {t('backToCatalog')}
          </Link>
        </div>
      </AdminPage>
    )
  }

  return <ActivityEditorPage mode="edit" activity={activity} key={activity._id} />
}
