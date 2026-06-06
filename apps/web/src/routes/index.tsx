import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'

import { HeroSection } from '#/components/landing/hero-section'
import { SiteHeader } from '#/components/landing/site-header'
import type { DesktopPlatform } from '#/lib/config'
import { detectDesktopPlatform } from '#/lib/detect-platform'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  const [platform, setPlatform] = useState<DesktopPlatform>('windows')

  useEffect(() => {
    const detected = detectDesktopPlatform()
    if (detected) setPlatform(detected)
  }, [])

  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <SiteHeader />

      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-6 pb-20 pt-10 text-center">
        <HeroSection platform={platform} onSwitchPlatform={setPlatform} />
      </main>
    </div>
  )
}
