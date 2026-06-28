import { Button } from '#/components/ui/button'
import { useAuth } from '#/features/auth/auth-context'

export function AccessDenied() {
  const auth = useAuth()

  return (
    <div className="flex h-svh items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-md border border-border/70 bg-card p-6 text-center">
        <h1 className="text-[15px] font-semibold">Нет доступа</h1>
        <p className="mt-2 text-[13px] text-muted-foreground">
          Нужен привилегированный аккаунт.
        </p>
        {auth.session ? (
          <Button variant="outline" size="sm" className="mt-4" onClick={() => void auth.logout()}>
            Выйти
          </Button>
        ) : null}
      </div>
    </div>
  )
}
