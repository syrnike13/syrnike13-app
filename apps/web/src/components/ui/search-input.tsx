import { SearchIcon } from '#/components/icons'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@syrnike13/ui/primitives/input-group'

type SearchInputProps = React.ComponentProps<typeof InputGroupInput>

/** Filter field with a leading magnifier; `className` places the group. */
export function SearchInput({ className, ...props }: SearchInputProps) {
  return (
    <InputGroup className={className}>
      <InputGroupAddon>
        <SearchIcon aria-hidden />
      </InputGroupAddon>
      <InputGroupInput type="search" {...props} />
    </InputGroup>
  )
}
