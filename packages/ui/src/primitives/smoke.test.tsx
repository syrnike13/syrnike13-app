// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './accordion'
import { Button } from './button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible'
import { Kbd } from './kbd'
import { Marker, MarkerContent, MarkerIcon } from './marker'
import { Progress } from './progress'
import { Skeleton } from './skeleton'
import { Spinner } from './spinner'
import { Toggle } from './toggle'

test('renders the simple catalog primitives', () => {
  render(
    <div>
      <Button aria-label="Закрыть">x</Button>
      <Kbd>Ctrl</Kbd>
      <Marker>
        <MarkerIcon>i</MarkerIcon>
        <MarkerContent>Маркер</MarkerContent>
      </Marker>
      <Progress value={42} aria-label="Загрузка" />
      <Skeleton data-testid="skeleton" />
      <Spinner aria-label="Загрузка" />
      <Toggle aria-label="Жирный">B</Toggle>
      <Collapsible>
        <CollapsibleTrigger>Открыть</CollapsibleTrigger>
        <CollapsibleContent>Содержимое</CollapsibleContent>
      </Collapsible>
      <Accordion multiple={false}>
        <AccordionItem value="a">
          <AccordionTrigger>Вопрос</AccordionTrigger>
          <AccordionContent>Ответ</AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>,
  )

  expect(screen.getByRole('button', { name: 'Закрыть' })).toBeInTheDocument()
  expect(screen.getByText('Ctrl')).toBeInTheDocument()
  expect(screen.getByText('Маркер')).toBeInTheDocument()
  expect(screen.getByRole('progressbar')).toBeInTheDocument()
  expect(screen.getByTestId('skeleton')).toBeInTheDocument()
  expect(screen.getByRole('status', { name: 'Загрузка' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Жирный' })).toBeInTheDocument()
  expect(screen.getByText('Вопрос')).toBeInTheDocument()
})
