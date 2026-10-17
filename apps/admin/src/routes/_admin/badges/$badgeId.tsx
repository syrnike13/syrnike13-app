import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useTranslations } from '@syrnike13/ui/i18n'

import { Loader2Icon } from '#/components/icons'
import { AdminEmpty, AdminPage } from '#/components/layout/page'
import { Button } from '#/components/ui/button'
import { BadgeEditorPage } from '#/features/badges/badge-editor'
import { fetchAdminBadges } from '#/features/api/admin-api'
import { useAuth } from '#/features/auth/auth-context'
import { queryKeys } from '#/lib/api/query-keys'

export const Route = createFileRoute('/_admin/badges/$badgeId')({
  component: EditBadgePage,
})

function EditBadgePage() {
  const t = useTranslations('badges.detail')
  const { badgeId } = Route.useParams()
  const auth = useAuth()
  const token = auth.session?.token

  const badgesQuery = useQuery({
    queryKey: queryKeys.admin.badges,
    queryFn: ({ signal }) => fetchAdminBadges(token!, signal),
    enabled: Boolean(token),
  })

  const badge = badgesQuery.data?.find((item) => item._id === badgeId)

  if (badgesQuery.isLoading) {
    return (
      <AdminPage
        title={t('badgeTitle')}
        back={{ to: '/badges', label: t('backBadges') }}
      >
        <div className="flex h-32 items-center justify-center text-[0.8125rem] text-muted-foreground">
          <Loader2Icon className="mr-2 size-4 animate-spin" aria-hidden />
          {t('loading')}
        </div>
      </AdminPage>
    )
  }

  if (!badge) {
    return (
      <AdminPage
        title={t('notFoundTitle')}
        back={{ to: '/badges', label: t('backBadges') }}
      >
        <AdminEmpty>{t('notFound')}</AdminEmpty>
        <div className="mt-4">
          <Button asChild variant="outline" size="sm">
            <Link to="/badges">{t('backToCatalog')}</Link>
          </Button>
        </div>
      </AdminPage>
    )
  }

  return <BadgeEditorPage mode="edit" badge={badge} key={badge._id} />
}
