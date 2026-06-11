import { applyThemeToDocument } from '#/features/appearance/apply-theme'
import { readStoredAppearanceSettings } from '#/features/appearance/appearance-settings-store'

export const APPEARANCE_BOOTSTRAP_SCRIPT = `(function(){try{var k='syrnike13-appearance';var r=localStorage.getItem(k);var d=true;if(r){var s=JSON.parse(r);if(s.colorMode==='light')d=false;else if(s.colorMode==='system')d=window.matchMedia('(prefers-color-scheme: dark)').matches;}else{var t=localStorage.getItem('theme');if(t==='light')d=false;}document.documentElement.classList.toggle('dark',d);}catch(e){document.documentElement.classList.add('dark');}})();`

export function bootstrapAppearance() {
  if (typeof window === 'undefined') return
  applyThemeToDocument(readStoredAppearanceSettings())
}

bootstrapAppearance()
