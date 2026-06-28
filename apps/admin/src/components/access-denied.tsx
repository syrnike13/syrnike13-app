export function AccessDenied() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-6 text-foreground">
      <div className="max-w-md text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          403
        </p>
        <h1 className="mt-3 text-2xl font-semibold">Нет доступа</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Этот аккаунт не имеет прав администратора.
        </p>
      </div>
    </div>
  )
}
