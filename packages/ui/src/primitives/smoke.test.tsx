// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './accordion'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible'
import { IconButton } from './icon-button'
import { Kbd } from './kbd'
import { LayerCard, LayerCardPrimary, LayerCardSecondary } from './layer-card'
import { Marker, MarkerContent, MarkerIcon } from './marker'
import { Progress } from './progress'
import { Skeleton } from './skeleton'
import { Spinner } from './spinner'
import { Toggle } from './toggle'

test('renders the simple catalog primitives', () => {
  render(
    <div>
      <IconButton aria-label="Закрыть">x</IconButton>
      <Kbd>Ctrl</Kbd>
      <LayerCard>
        <LayerCardPrimary>Заголовок</LayerCardPrimary>
        <LayerCardSecondary>Описание</LayerCardSecondary>
      </LayerCard>
      <Marker>
        <MarkerIcon>i</MarkerIcon>
        <MarkerContent>Маркер</MarkerContent>
      </Marker>
      <Progress value={42} aria-label="Загрузка" />
      <Skeleton data-testid="skeleton" />
      <Spinner label="Загрузка" />
      <Toggle aria-label="Жирный">B</Toggle>
      <Collapsible>
        <CollapsibleTrigger>Открыть</CollapsibleTrigger>
        <CollapsibleContent>Содержимое</CollapsibleContent>
      </Collapsible>
      <Accordion type="single" collapsible>
        <AccordionItem value="a">
          <AccordionTrigger>Вопрос</AccordionTrigger>
          <AccordionContent>Ответ</AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>,
  )

  expect(screen.getByRole('button', { name: 'Закрыть' })).toBeInTheDocument()
  expect(screen.getByText('Ctrl')).toBeInTheDocument()
  expect(screen.getByText('Заголовок')).toBeInTheDocument()
  expect(screen.getByText('Маркер')).toBeInTheDocument()
  expect(screen.getByRole('progressbar')).toBeInTheDocument()
  expect(screen.getByTestId('skeleton')).toBeInTheDocument()
  expect(screen.getByRole('status', { name: 'Загрузка' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Жирный' })).toBeInTheDocument()
  expect(screen.getByText('Вопрос')).toBeInTheDocument()
})
