import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'

import { HeroSection } from '#/components/landing/hero-section'
import { LandingBackdrop } from '#/components/landing/landing-backdrop'
import { LandingGameHomages } from '#/components/landing/landing-game-homages'
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
    <div className="relative flex min-h-svh flex-col text-foreground">
      <LandingBackdrop />
      <LandingGameHomages />
      <SiteHeader />

      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 pb-16 pt-6">
        <HeroSection platform={platform} onSwitchPlatform={setPlatform} />
      </main>
    </div>
  )
}
