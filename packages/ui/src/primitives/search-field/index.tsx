import * as React from 'react'

import { useTranslations } from '../../i18n'
import { SearchIcon, XIcon } from '../../icons'
import { cn } from '../../lib/cn'
import { Button } from '../button'
import { Input } from '../input'

type SearchFieldProps = Omit<React.ComponentProps<typeof Input>, 'type'> & {
  inputClassName?: string
  onClear?: () => void
  clearLabel?: string
}

function SearchField({
  className,
  inputClassName,
  value,
  onClear,
  clearLabel,
  ...props
}: SearchFieldProps) {
  const t = useTranslations('ui')
  const resolvedClearLabel = clearLabel ?? t('clear')
  const hasValue = Array.isArray(value)
    ? value.length > 0
    : value !== undefined && value !== null && String(value).length > 0

  return (
    <div data-slot="search-field" className={cn('relative', className)}>
      <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        className={cn(
          'pl-9 [&::-webkit-search-cancel-button]:hidden',
          onClear && hasValue && 'pr-9',
          inputClassName,
        )}
        {...props}
      />
      {onClear && hasValue ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={resolvedClearLabel}
          onClick={onClear}
          className="absolute right-1.5 top-1/2 -translate-y-1/2"
        >
          <XIcon />
        </Button>
      ) : null}
    </div>
  )
}

export { SearchField }
