export function ActiveNowPanel() {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-l border-shell-divider bg-background xl:flex">
      <header className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Сейчас активны</h2>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm font-medium text-muted-foreground">Скоро</p>
        <p className="text-xs text-muted-foreground">
          Здесь появятся игры и активности друзей
        </p>
      </div>
    </aside>
  )
}
