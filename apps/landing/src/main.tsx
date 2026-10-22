import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from '#/App'
import { AppLocaleProvider } from '#/features/i18n/locale-provider'

import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('Landing root element is missing')

createRoot(container).render(
  <StrictMode>
    <AppLocaleProvider>
      <App />
    </AppLocaleProvider>
  </StrictMode>,
)
