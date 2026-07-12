import { createFileRoute, Outlet } from '@tanstack/react-router'

import { AdminShell } from '#/components/admin-shell'
import { AuthedGate } from '#/features/auth/authed-gate'

export const Route = createFileRoute('/_admin')({
  component: AdminLayout,
})

function AdminLayout() {
  return (
    <AuthedGate>
      <AdminShell>
        <Outlet />
      </AdminShell>
    </AuthedGate>
  )
}
