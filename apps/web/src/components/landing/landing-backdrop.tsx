export function LandingBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div className="gradient-surface-content absolute inset-0 bg-background" />
      <div className="absolute inset-x-0 bottom-0 h-[55%] bg-gradient-to-t from-primary/[0.14] via-primary/[0.04] to-transparent" />
      <div className="absolute inset-x-0 top-0 h-[30%] bg-gradient-to-b from-primary/[0.05] to-transparent" />
    </div>
  )
}
