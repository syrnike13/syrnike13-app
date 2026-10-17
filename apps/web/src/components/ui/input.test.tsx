import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Input } from '@syrnike13/ui/primitives/input'
import { Textarea } from '@syrnike13/ui/primitives/textarea'

describe('form control surfaces', () => {
  it('renders the shadcn Base UI input', () => {
    const markup = renderToStaticMarkup(<Input aria-label="Название" />)

    expect(markup).toContain('data-slot="input"')
    expect(markup).toContain('border-input')
  })

  it('renders the shadcn Base UI textarea', () => {
    const markup = renderToStaticMarkup(<Textarea aria-label="Описание" />)

    expect(markup).toContain('data-slot="textarea"')
    expect(markup).toContain('border-input')
  })
})
