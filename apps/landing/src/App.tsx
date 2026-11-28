import { HeroSection } from '#/components/landing/hero-section'
import { LandingBackdrop } from '#/components/landing/landing-backdrop'
import { LandingGameHomages } from '#/components/landing/landing-game-homages'
import { SiteHeader } from '#/components/landing/site-header'

export function App() {
  return (
    <div className="relative flex min-h-svh flex-col text-foreground">
      <LandingBackdrop />
      <LandingGameHomages />
      <SiteHeader />

      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 pb-16 pt-6">
        <HeroSection />
      </main>
    </div>
  )
}
