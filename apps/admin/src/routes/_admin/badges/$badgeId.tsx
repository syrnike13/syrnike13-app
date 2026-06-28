import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

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
  const { badgeId } = Route.useParams()
  const auth = useAuth()
  const token = auth.session?.token

  const badgesQuery = useQuery({
    queryKey: queryKeys.admin.badges,
    queryFn: () => fetchAdminBadges(token!),
    enabled: Boolean(token),
  })

  const badge = badgesQuery.data?.find((item) => item._id === badgeId)

  if (badgesQuery.isLoading) {
    return (
      <AdminPage title="Бейдж" back={{ to: '/badges', label: 'Бейджи' }}>
        <div className="flex h-32 items-center justify-center text-[13px] text-muted-foreground">
          <Loader2Icon className="mr-2 size-4 animate-spin" aria-hidden />
          Загрузка...
        </div>
      </AdminPage>
    )
  }

  if (!badge) {
    return (
      <AdminPage title="Не найден" back={{ to: '/badges', label: 'Бейджи' }}>
        <AdminEmpty>Бейдж не найден</AdminEmpty>
        <div className="mt-4">
          <Button asChild variant="outline" size="sm">
            <Link to="/badges">К каталогу</Link>
          </Button>
        </div>
      </AdminPage>
    )
  }

  return <BadgeEditorPage mode="edit" badge={badge} key={badge._id} />
}
