import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Input } from '#/components/ui/input'
import { Textarea } from '#/components/ui/textarea'

describe('form control surfaces', () => {
  it('assigns the shared gradient input surface to Input', () => {
    const markup = renderToStaticMarkup(<Input aria-label="Название" />)

    expect(markup).toContain('data-slot="input"')
    expect(markup).toContain('gradient-surface-input')
  })

  it('assigns the shared gradient input surface to Textarea', () => {
    const markup = renderToStaticMarkup(<Textarea aria-label="Описание" />)

    expect(markup).toContain('data-slot="textarea"')
    expect(markup).toContain('gradient-surface-input')
  })
})
