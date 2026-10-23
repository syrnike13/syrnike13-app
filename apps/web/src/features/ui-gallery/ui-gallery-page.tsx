// design-allow-file hardcoded-string: internal developer component gallery; demo copy is illustrative.
// design-allow-file restyle-shared: internal developer component gallery; bordered/raised demo containers are illustrative.
import { useState, type ReactNode } from 'react'
import { useTranslations } from '@syrnike13/ui/i18n'
import { toast as sonnerToast } from 'sonner'
import {
  BellIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CopyIcon,
  DownloadIcon,
  FileIcon,
  Gamepad2Icon,
  HeadphonesIcon,
  InfoIcon,
  LinkIcon,
  MessageCircleIcon,
  MicIcon,
  MonitorIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShieldIcon,
  Trash2Icon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
} from '#/components/icons'
import { Bar, BarChart, CartesianGrid, XAxis } from 'recharts'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@syrnike13/ui/primitives/accordion'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@syrnike13/ui/primitives/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@syrnike13/ui/primitives/alert-dialog'
import { AspectRatio } from '@syrnike13/ui/primitives/aspect-ratio'
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from '@syrnike13/ui/primitives/attachment'
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from '@syrnike13/ui/primitives/avatar'
import { Badge } from '@syrnike13/ui/primitives/badge'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@syrnike13/ui/primitives/breadcrumb'
import { Button, buttonVariants } from '@syrnike13/ui/primitives/button'
import { ButtonGroup, ButtonGroupSeparator } from '@syrnike13/ui/primitives/button-group'
import { Calendar } from '@syrnike13/ui/primitives/calendar'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@syrnike13/ui/primitives/card'
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from '@syrnike13/ui/primitives/carousel'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@syrnike13/ui/primitives/chart'
import { Checkbox } from '@syrnike13/ui/primitives/checkbox'
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@syrnike13/ui/primitives/code-block'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@syrnike13/ui/primitives/collapsible'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@syrnike13/ui/primitives/combobox'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@syrnike13/ui/primitives/command'
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@syrnike13/ui/primitives/context-menu'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@syrnike13/ui/primitives/dialog'
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@syrnike13/ui/primitives/drawer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@syrnike13/ui/primitives/dropdown-menu'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@syrnike13/ui/primitives/empty'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@syrnike13/ui/primitives/field'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@syrnike13/ui/primitives/hover-card'
import { Input } from '@syrnike13/ui/primitives/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from '@syrnike13/ui/primitives/input-group'
import { InputOTP, InputOTPGroup, InputOTPSeparator, InputOTPSlot } from '@syrnike13/ui/primitives/input-otp'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@syrnike13/ui/primitives/item'
import { Kbd, KbdGroup } from '@syrnike13/ui/primitives/kbd'
import { Marker, MarkerContent, MarkerIcon } from '@syrnike13/ui/primitives/marker'
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from '@syrnike13/ui/primitives/menubar'
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageGroup,
  MessageHeader,
} from '@syrnike13/ui/primitives/message'
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@syrnike13/ui/primitives/message-scroller'
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from '@syrnike13/ui/primitives/navigation-menu'
import { NativeSelect, NativeSelectOption } from '@syrnike13/ui/primitives/native-select'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@syrnike13/ui/primitives/pagination'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@syrnike13/ui/primitives/popover'
import { Progress } from '@syrnike13/ui/primitives/progress'
import { Questionnaire, QuestionnaireActions, QuestionnaireChoice, QuestionnaireChoiceDescription, QuestionnaireChoices, QuestionnaireDescription, QuestionnaireItem, QuestionnaireProgress, QuestionnaireSubmit, QuestionnaireTitle } from '@syrnike13/ui/primitives/questionnaire'
import { RadioGroup, RadioGroupItem } from '@syrnike13/ui/primitives/radio-group'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@syrnike13/ui/primitives/resizable'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@syrnike13/ui/primitives/select'
import { Separator } from '@syrnike13/ui/primitives/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@syrnike13/ui/primitives/sheet'
import { Skeleton } from '@syrnike13/ui/primitives/skeleton'
import { Slider } from '@syrnike13/ui/primitives/slider'
import { PresetSlider } from '#/components/ui/preset-slider'
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { Switch } from '@syrnike13/ui/primitives/switch'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@syrnike13/ui/primitives/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@syrnike13/ui/primitives/tabs'
import { Textarea } from '@syrnike13/ui/primitives/textarea'
import { Toaster as BaseToaster, toast as baseToast } from '@syrnike13/ui/primitives/toast'
import { Toggle } from '@syrnike13/ui/primitives/toggle'
import { ToggleGroup, ToggleGroupItem } from '@syrnike13/ui/primitives/toggle-group'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@syrnike13/ui/primitives/tooltip'
import {
  Trace,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@syrnike13/ui/primitives/trace'
import { useAppearance } from '#/features/appearance/appearance-context'
import { ThemePickerGrid } from '#/components/appearance/theme-picker-grid'
import { GatewayLoadingScreenView } from '#/components/layout/gateway-loading-screen'
import {
  CAKE_LOGO_VARIANTS,
  type CakeLogoVariant,
} from '#/components/layout/cake-logo'

const SECTIONS = [
  {
    id: 'foundations',
    label: 'Foundations',
    items: [
      'Button',
      'Button Group',
      'Badge',
      'Avatar',
      'Card',
      'Alert',
      'Separator',
      'Skeleton',
      'Spinner',
      'Kbd',
      'Marker',
      'Progress',
      'Aspect Ratio',
    ],
  },
  {
    id: 'forms',
    label: 'Forms',
    items: [
      'Field',
      'Input',
      'Textarea',
      'Label',
      'Input Group',
      'Native Select',
      'Checkbox',
      'Radio Group',
      'Switch',
      'Slider',
      'Select',
      'Combobox',
      'Toggle',
      'Toggle Group',
      'Input OTP',
      'Calendar',
    ],
  },
  {
    id: 'data',
    label: 'Data display',
    items: [
      'Table',
      'Item',
      'Empty',
      'Breadcrumb',
      'Pagination',
      'Tabs',
      'Accordion',
      'Collapsible',
      'Scroll Area',
      'Resizable',
      'Carousel',
      'Chart',
      'Code Block',
      'Trace',
      'Attachment',
    ],
  },
  {
    id: 'messaging',
    label: 'Messaging',
    items: ['Message', 'Message Scroller', 'Questionnaire'],
  },
  {
    id: 'overlays',
    label: 'Overlays',
    items: [
      'Dialog',
      'Alert Dialog',
      'Sheet',
      'Drawer',
      'Popover',
      'Hover Card',
      'Tooltip',
      'Dropdown Menu',
      'Context Menu',
      'Command',
      'Toast',
      'Sonner',
      'Menubar',
      'Navigation Menu',
    ],
  },
  {
    id: 'examples',
    label: 'Examples',
    items: [
      'Settings card',
      'Voice participant',
      'Members list',
      'Invite block',
      'Chat message',
      'Loading screen',
    ],
  },
] as const

function GallerySection({
  id,
  title,
  description,
  children,
}: {
  id: string
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section id={id} className="scroll-mt-6 space-y-4">
      <header className="space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
      </header>
      <div className="grid gap-4 xl:grid-cols-2">{children}</div>
    </section>
  )
}

function Demo({
  title,
  hint,
  wide,
  children,
}: {
  title: string
  hint?: string
  wide?: boolean
  children: ReactNode
}) {
  return (
    <Card className={wide ? 'xl:col-span-2' : undefined}>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
        {hint ? <CardDescription>{hint}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>
}

function GalleryNav() {
  return (
    <aside className="sticky top-0 hidden h-svh w-64 shrink-0 overflow-y-auto border-r p-4 lg:block">
      <p className="mb-4 text-sm font-semibold">syrnike13/ui</p>
      <nav className="space-y-5">
        {SECTIONS.map((section) => (
          <div key={section.id} className="space-y-1">
            <a
              href={`#${section.id}`}
              className="block text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
            >
              {section.label}
            </a>
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item}>
                  <a
                    href={`#${section.id}`}
                    className="block rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {item}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  )
}

function PalettePanel() {
  const { settings, resolvedVariant, setColorMode } = useAppearance()
  const modes = ['light', 'dark', 'system'] as const

  return (
    <Card className="sticky top-0 z-20 mb-6">
      <CardHeader>
        <CardTitle className="text-sm">Palette</CardTitle>
        <CardDescription>
          {settings.themeId} · {resolvedVariant}
        </CardDescription>
        <CardAction>
          <div className="flex items-center gap-1">
            {modes.map((mode) => (
              <Button
                key={mode}
                type="button"
                size="sm"
                variant={settings.colorMode === mode ? 'secondary' : 'ghost'}
                onClick={() => setColorMode(mode)}
              >
                {mode}
              </Button>
            ))}
          </div>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ThemePickerGrid />
      </CardContent>
    </Card>
  )
}

function ButtonGallery() {
  return (
    <>
      <Demo title="Button" hint="All upstream variants and sizes." wide>
        <div className="space-y-4">
          <Row>
            <Button>Default</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="link">Link</Button>
          </Row>
          <Row>
            <Button size="xs">Extra small</Button>
            <Button size="sm">Small</Button>
            <Button size="default">Default</Button>
            <Button size="lg">Large</Button>
            <Button size="icon" aria-label="Settings">
              <SettingsIcon />
            </Button>
            <Button size="icon-sm" aria-label="Add">
              <PlusIcon />
            </Button>
            <Button size="icon-lg" aria-label="Search">
              <SearchIcon />
            </Button>
            <Button disabled>Disabled</Button>
            <a
              href="#foundations"
              className={buttonVariants({ variant: 'outline' })}
            >
              Rendered link
            </a>
          </Row>
        </div>
      </Demo>
      <Demo title="Button Group" hint="Segmented actions and separators.">
        <div className="space-y-4">
          <ButtonGroup>
            <Button variant="outline">Day</Button>
            <Button variant="outline">Week</Button>
            <Button variant="outline">Month</Button>
          </ButtonGroup>
          <ButtonGroup>
            <Button variant="outline">
              <DownloadIcon /> Download
            </Button>
            <ButtonGroupSeparator />
            <Button variant="outline" size="icon" aria-label="More">
              <ChevronRightIcon />
            </Button>
          </ButtonGroup>
        </div>
      </Demo>
      <Demo title="Badge" hint="Upstream badge variants.">
        <Row>
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Destructive</Badge>
          <Badge variant="ghost">Ghost</Badge>
          <Badge variant="link">Link</Badge>
        </Row>
      </Demo>
      <Demo title="Avatar" hint="Images, fallbacks and groups.">
        <div className="space-y-4">
          <Row>
            <Avatar>
              <AvatarImage src="https://github.com/shadcn.png" alt="User" />
              <AvatarFallback>SY</AvatarFallback>
            </Avatar>
            <Avatar>
              <AvatarFallback>13</AvatarFallback>
            </Avatar>
            <AvatarGroup>
              <Avatar>
                <AvatarFallback>A</AvatarFallback>
              </Avatar>
              <Avatar>
                <AvatarFallback>B</AvatarFallback>
              </Avatar>
              <AvatarGroupCount>+4</AvatarGroupCount>
            </AvatarGroup>
          </Row>
        </div>
      </Demo>
      <Demo title="Card" hint="Header, content, footer and action." wide>
        <Card className="max-w-sm">
          <CardHeader>
            <CardTitle>Project nightfall</CardTitle>
            <CardDescription>Deployment happens at 21:00 UTC.</CardDescription>
            <CardAction>
              <Badge variant="secondary">Live</Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Shared surfaces own border, radius, padding and typography.
          </CardContent>
          <CardFooter className="gap-2">
            <Button size="sm">Open</Button>
            <Button size="sm" variant="outline">
              Dismiss
            </Button>
          </CardFooter>
        </Card>
      </Demo>
      <Demo title="Alert" hint="Informational and destructive alerts.">
        <div className="space-y-3">
          <Alert>
            <InfoIcon />
            <AlertTitle>Heads up</AlertTitle>
            <AlertDescription>All primitives are literal shadcn sources.</AlertDescription>
            <AlertAction>
              <Button size="xs" variant="outline">
                Details
              </Button>
            </AlertAction>
          </Alert>
          <Alert variant="destructive">
            <XIcon />
            <AlertTitle>Connection lost</AlertTitle>
            <AlertDescription>Retrying in the background.</AlertDescription>
          </Alert>
        </div>
      </Demo>
      <Demo title="Separator, Skeleton, Spinner" hint="Loading and structure.">
        <div className="space-y-4">
          <Separator />
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="space-y-2">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
          <Row>
            <Spinner aria-label="Loading" />
            <Spinner className="size-6" aria-label="Loading" />
          </Row>
        </div>
      </Demo>
      <Demo title="Kbd" hint="Keyboard hints.">
        <Row>
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
          <KbdGroup>
            <Kbd>Shift</Kbd>
            <Kbd>Enter</Kbd>
          </KbdGroup>
        </Row>
      </Demo>
      <Demo title="Marker" hint="Text with leading icon or separators.">
        <div className="space-y-3">
          <Marker>
            <MarkerIcon>
              <CircleCheckIcon />
            </MarkerIcon>
            <MarkerContent>All services operational</MarkerContent>
          </Marker>
          <Marker variant="border">
            <MarkerIcon>
              <BellIcon />
            </MarkerIcon>
            <MarkerContent>Notifications enabled</MarkerContent>
          </Marker>
          <Marker variant="separator">
            <MarkerContent>or</MarkerContent>
          </Marker>
        </div>
      </Demo>
      <Demo title="Progress" hint="Determinate and indeterminate.">
        <div className="space-y-4">
          <Progress value={64} />
          <Progress value={null} />
        </div>
      </Demo>
      <Demo title="Aspect Ratio" hint="Keeps media proportions.">
        <AspectRatio ratio={16 / 9} className="overflow-hidden rounded-lg bg-muted">
          <div className="flex size-full items-center justify-center text-sm text-muted-foreground">
            16 : 9
          </div>
        </AspectRatio>
      </Demo>
    </>
  )
}

const ZOOM_STOPS = [
  { value: 50, major: true },
  { value: 67 },
  { value: 75 },
  { value: 80 },
  { value: 90 },
  { value: 100, major: true },
  { value: 110 },
  { value: 125 },
  { value: 150, major: true },
  { value: 175 },
  { value: 200, major: true },
]

function PresetSliderDemo() {
  const [zoom, setZoom] = useState(100)
  const [even, setEven] = useState(50)
  const [continuous, setContinuous] = useState(37)
  const [released, setReleased] = useState(100)
  const [bare, setBare] = useState(40)

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Value layout · snap · major labels only on narrow
        </p>
        <PresetSlider
          stops={ZOOM_STOPS}
          value={zoom}
          onValueChange={setZoom}
          formatValue={(value) => `${value}%`}
          aria-label="Interface scale"
        />
      </div>
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Index layout · evenly spaced stops
        </p>
        <PresetSlider
          stops={[
            { value: 0, label: 'Off' },
            { value: 25 },
            { value: 50, major: true },
            { value: 75 },
            { value: 100 },
          ]}
          value={even}
          layout="index"
          onValueChange={setEven}
          formatValue={(value) => `${value}%`}
          aria-label="Evenly spaced"
        />
      </div>
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Continuous · labels are guides
        </p>
        <PresetSlider
          stops={[
            { value: 0, major: true },
            { value: 25 },
            { value: 50, major: true },
            { value: 75 },
            { value: 100, major: true },
          ]}
          value={continuous}
          mode="continuous"
          step={1}
          onValueChange={setContinuous}
          formatValue={(value) => `${value}%`}
          aria-label="Continuous"
        />
      </div>
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Release snap · value applies on pointer up
        </p>
        <PresetSlider
          stops={ZOOM_STOPS}
          value={released}
          drag="release"
          onValueChange={setReleased}
          formatValue={(value) => `${value}%`}
          aria-label="Release snap"
        />
      </div>
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Bare · plain slider without labels or ticks
        </p>
        <PresetSlider
          stops={[{ value: 0 }, { value: 100 }]}
          value={bare}
          mode="continuous"
          step={1}
          showLabels={false}
          showMarks={false}
          onValueChange={setBare}
          formatValue={(value) => `${value}%`}
          aria-label="Bare slider"
        />
      </div>
    </div>
  )
}

function FormGallery() {
  const [date, setDate] = useState<Date | undefined>(new Date())
  const [otp, setOtp] = useState('')

  return (
    <>
      <Demo title="Field" hint="Label, description and validation state." wide>
        <FieldGroup className="max-w-sm">
          <Field>
            <FieldLabel htmlFor="gallery-name">Display name</FieldLabel>
            <Input id="gallery-name" placeholder="syrnike" />
            <FieldDescription>Shown to everyone in the server.</FieldDescription>
          </Field>
          <Field data-invalid="true">
            <FieldLabel htmlFor="gallery-error">Email</FieldLabel>
            <Input id="gallery-error" aria-invalid defaultValue="not-an-email" />
            <FieldError>Enter a valid email address.</FieldError>
          </Field>
          <FieldSet>
            <FieldLegend>Notifications</FieldLegend>
            <Field orientation="horizontal">
              <Checkbox id="gallery-field-notify" defaultChecked />
              <FieldContent>
                <FieldLabel htmlFor="gallery-field-notify">Product updates</FieldLabel>
                <FieldDescription>At most one email per week.</FieldDescription>
              </FieldContent>
            </Field>
          </FieldSet>
        </FieldGroup>
      </Demo>
      <Demo title="Input and Textarea" hint="Native inputs with shared surface.">
        <div className="space-y-3">
          <Input placeholder="Search channels" />
          <Input disabled placeholder="Disabled" />
          <Textarea placeholder="Write a message" rows={3} />
        </div>
      </Demo>
      <Demo title="Input Group" hint="Addons and inline actions.">
        <div className="space-y-3">
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput placeholder="Search servers" />
            <InputGroupAddon align="inline-end">
              <InputGroupText>⌘K</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
          <InputGroup>
            <InputGroupInput defaultValue="https://syrnike13.dev" />
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" variant="ghost" aria-label="Copy">
                <CopyIcon />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>
      </Demo>
      <Demo title="Native Select" hint="Platform select for dense forms.">
        <NativeSelect defaultValue="ru">
          <NativeSelectOption value="ru">Русский</NativeSelectOption>
          <NativeSelectOption value="en">English</NativeSelectOption>
        </NativeSelect>
      </Demo>
      <Demo title="Checkbox and Radio Group" hint="Selection controls.">
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox defaultChecked /> Receive mentions
          </label>
          <RadioGroup defaultValue="all">
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="all" /> All messages
            </label>
            <label className="flex items-center gap-2 text-sm">
              <RadioGroupItem value="mentions" /> Mentions only
            </label>
          </RadioGroup>
        </div>
      </Demo>
      <Demo title="Switch" hint="Immediate settings.">
        <Row>
          <Switch defaultChecked aria-label="Enabled" />
          <Switch aria-label="Disabled" />
        </Row>
      </Demo>
      <Demo title="Slider" hint="Single value and range.">
        <div className="space-y-5">
          <Slider defaultValue={[40]} max={100} step={1} aria-label="Volume" />
          <Slider defaultValue={[20, 70]} max={100} step={1} aria-label="Range" />
        </div>
      </Demo>
      <Demo
        title="Preset slider"
        hint="Labelled stops, snapping, value and index layouts."
        wide
      >
        <PresetSliderDemo />
      </Demo>
      <Demo title="Select" hint="Grouped options.">
        <Select
          defaultValue="general"
          items={[
            { value: 'general', label: '# general' },
            { value: 'voice', label: '# voice' },
            { value: 'dev', label: '# dev' },
          ]}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Choose channel" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Channels</SelectLabel>
              <SelectItem value="general"># general</SelectItem>
              <SelectItem value="voice"># voice</SelectItem>
              <SelectItem value="dev"># dev</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Demo>
      <Demo title="Combobox" hint="Searchable single select.">
        <Combobox items={['monolit', 'glina', 'gradient-aurora']}>
          <ComboboxInput placeholder="Find a server" />
          <ComboboxContent>
            <ComboboxEmpty>No servers found.</ComboboxEmpty>
            <ComboboxList>
              {(item: string) => (
                <ComboboxItem key={item} value={item}>
                  {item}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </Demo>
      <Demo title="Toggle and Toggle Group" hint="Pressed-state controls.">
        <div className="space-y-3">
          <Row>
            <Toggle aria-label="Bold">B</Toggle>
            <Toggle variant="outline" aria-label="Italic">
              I
            </Toggle>
          </Row>
          <ToggleGroup defaultValue={['left']} multiple={false}>
            <ToggleGroupItem value="left">Left</ToggleGroupItem>
            <ToggleGroupItem value="center">Center</ToggleGroupItem>
            <ToggleGroupItem value="right">Right</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </Demo>
      <Demo title="Input OTP" hint="One-time passcode slots.">
        <InputOTP maxLength={6} value={otp} onChange={setOtp}>
          <InputOTPGroup>
            <InputOTPSlot index={0} />
            <InputOTPSlot index={1} />
            <InputOTPSlot index={2} />
          </InputOTPGroup>
          <InputOTPSeparator />
          <InputOTPGroup>
            <InputOTPSlot index={3} />
            <InputOTPSlot index={4} />
            <InputOTPSlot index={5} />
          </InputOTPGroup>
        </InputOTP>
      </Demo>
      <Demo title="Calendar" hint="Date picker.">
        <Calendar mode="single" selected={date} onSelect={setDate} />
      </Demo>
    </>
  )
}

function DataGallery() {
  const chartConfig = {
    desktop: { label: 'Desktop', color: 'var(--chart-1)' },
    mobile: { label: 'Mobile', color: 'var(--chart-2)' },
  } satisfies ChartConfig
  const chartData = [
    { month: 'Jan', desktop: 186, mobile: 80 },
    { month: 'Feb', desktop: 305, mobile: 200 },
    { month: 'Mar', desktop: 237, mobile: 120 },
    { month: 'Apr', desktop: 273, mobile: 190 },
  ]

  return (
    <>
      <Demo title="Table" hint="Semantic table with caption." wide>
        <Table>
          <TableCaption>Open incidents</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Service</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Latency</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>gateway</TableCell>
              <TableCell>
                <Badge variant="secondary">Degraded</Badge>
              </TableCell>
              <TableCell className="text-right">182 ms</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>media</TableCell>
              <TableCell>
                <Badge>Healthy</Badge>
              </TableCell>
              <TableCell className="text-right">42 ms</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Demo>
      <Demo title="Item" hint="List row with media and actions.">
        <ItemGroup>
          <Item variant="outline">
            <ItemMedia variant="icon">
              <UsersIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Members</ItemTitle>
              <ItemDescription>24 people in this server</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button size="sm" variant="outline">
                Manage
              </Button>
            </ItemActions>
          </Item>
          <Item variant="muted" size="sm">
            <ItemMedia variant="icon">
              <ShieldIcon />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>Moderator</ItemTitle>
              <ItemDescription>Role assigned to 3 members</ItemDescription>
            </ItemContent>
          </Item>
        </ItemGroup>
      </Demo>
      <Demo title="Empty" hint="Empty state with action.">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SearchIcon />
            </EmptyMedia>
            <EmptyTitle>Nothing found</EmptyTitle>
            <EmptyDescription>Try a different search query.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" variant="outline">
              Clear filters
            </Button>
          </EmptyContent>
        </Empty>
      </Demo>
      <Demo title="Breadcrumb" hint="Path navigation.">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="#data">Servers</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink href="#data">syrnike13</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Settings</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </Demo>
      <Demo title="Pagination" hint="Page controls.">
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious href="#data" />
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#data" isActive>
                1
              </PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationLink href="#data">2</PaginationLink>
            </PaginationItem>
            <PaginationItem>
              <PaginationEllipsis />
            </PaginationItem>
            <PaginationItem>
              <PaginationNext href="#data" />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </Demo>
      <Demo title="Tabs" hint="Section switching.">
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="members">Members</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="pt-3 text-sm text-muted-foreground">
            Server overview content.
          </TabsContent>
          <TabsContent value="members" className="pt-3 text-sm text-muted-foreground">
            Member list content.
          </TabsContent>
          <TabsContent value="settings" className="pt-3 text-sm text-muted-foreground">
            Server settings content.
          </TabsContent>
        </Tabs>
      </Demo>
      <Demo title="Accordion" hint="Disclosure list.">
        <Accordion defaultValue={['account']}>
          <AccordionItem value="account">
            <AccordionTrigger>Account</AccordionTrigger>
            <AccordionContent>Profile, status and pronouns.</AccordionContent>
          </AccordionItem>
          <AccordionItem value="voice">
            <AccordionTrigger>Voice</AccordionTrigger>
            <AccordionContent>Input, output and noise suppression.</AccordionContent>
          </AccordionItem>
        </Accordion>
      </Demo>
      <Demo title="Collapsible" hint="Single disclosure.">
        <Collapsible>
          <CollapsibleTrigger render={<Button variant="outline" size="sm" />}>
            Show details
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3 text-sm text-muted-foreground">
            Collapsed content is rendered with shadcn base-nova styles.
          </CollapsibleContent>
        </Collapsible>
      </Demo>
      <Demo title="Scroll Area" hint="Custom scrollbar.">
        <ScrollArea className="h-40 rounded-md border p-3">
          <div className="space-y-2">
            {Array.from({ length: 16 }, (_, index) => (
              <p key={index} className="text-sm text-muted-foreground">
                Channel {index + 1}
              </p>
            ))}
          </div>
        </ScrollArea>
      </Demo>
      <Demo title="Resizable" hint="Draggable split panes." wide>
        <ResizablePanelGroup orientation="horizontal" className="h-40 rounded-lg border">
          <ResizablePanel defaultSize={50}>
            <div className="flex size-full items-center justify-center text-sm text-muted-foreground">
              Left panel
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={50}>
            <div className="flex size-full items-center justify-center text-sm text-muted-foreground">
              Right panel
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </Demo>
      <Demo title="Carousel" hint="Embla-powered slides.">
        <Carousel className="w-full max-w-sm">
          <CarouselContent>
            {['Twilight', 'Aurora', 'Sunset'].map((label) => (
              <CarouselItem key={label}>
                <div className="flex h-32 items-center justify-center rounded-lg border bg-muted text-sm font-medium">
                  {label}
                </div>
              </CarouselItem>
            ))}
          </CarouselContent>
          <CarouselPrevious />
          <CarouselNext />
        </Carousel>
      </Demo>
      <Demo title="Chart" hint="Recharts container with semantic colors." wide>
        <ChartContainer config={chartConfig} className="h-56 w-full">
          <BarChart data={chartData}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="month" tickLine={false} axisLine={false} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar dataKey="desktop" fill="var(--color-desktop)" radius={4} />
            <Bar dataKey="mobile" fill="var(--color-mobile)" radius={4} />
          </BarChart>
        </ChartContainer>
      </Demo>
      <Demo title="Code Block" hint="Code with copy action." wide>
        <CodeBlock>
          <CodeBlockHeader>
            <CodeBlockTitle>theme.ts</CodeBlockTitle>
            <CodeBlockCopyButton
              value={'export const theme = "monolit"\napplyThemeToDocument(theme)'}
            />
          </CodeBlockHeader>
          <CodeBlockContent>
            {'export const theme = "monolit"\napplyThemeToDocument(theme)'}
          </CodeBlockContent>
        </CodeBlock>
      </Demo>
      <Demo title="Trace" hint="Compact activity trace.">
        <Trace>
          <TraceLine>
            <TraceIcon>
              <CircleCheckIcon />
            </TraceIcon>
            <TraceTitle>Theme applied</TraceTitle>
            <TraceDescription>syrnike · dark</TraceDescription>
          </TraceLine>
          <TraceLine status="running">
            <TraceIcon>
              <Spinner className="size-4" aria-label="Running" />
            </TraceIcon>
            <TraceTitle>Syncing settings</TraceTitle>
          </TraceLine>
        </Trace>
      </Demo>
      <Demo title="Attachment" hint="File attachment row.">
        <Attachment>
          <AttachmentMedia>
            <FileIcon />
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>release-notes.pdf</AttachmentTitle>
            <AttachmentDescription>240 KB</AttachmentDescription>
          </AttachmentContent>
        </Attachment>
      </Demo>
    </>
  )
}

function MessagingGallery() {
  return (
    <>
      <Demo title="Message" hint="Message row with avatar and header." wide>
        <MessageGroup>
          <Message>
            <MessageAvatar>
              <Avatar>
                <AvatarFallback>SY</AvatarFallback>
              </Avatar>
            </MessageAvatar>
            <MessageContent>
              <MessageHeader>
                <span className="font-semibold">syrnike</span>
                <span className="text-xs text-muted-foreground">21:24</span>
              </MessageHeader>
              <p>All primitives now come from shadcn base-nova.</p>
            </MessageContent>
          </Message>
          <Message align="end">
            <MessageContent>
              <div className="w-fit rounded-xl bg-primary px-3 py-2 text-primary-foreground">
                Nice.
              </div>
            </MessageContent>
          </Message>
        </MessageGroup>
      </Demo>
      <Demo title="Message Scroller" hint="Scrollable message viewport." wide>
        <MessageScrollerProvider>
          <MessageScroller className="h-64 rounded-lg border">
            <MessageScrollerViewport>
              <MessageScrollerContent className="p-3">
                {Array.from({ length: 12 }, (_, index) => (
                  <MessageScrollerItem key={index}>
                    <p className="text-sm text-muted-foreground">
                      Message {index + 1}
                    </p>
                  </MessageScrollerItem>
                ))}
              </MessageScrollerContent>
            </MessageScrollerViewport>
          </MessageScroller>
        </MessageScrollerProvider>
      </Demo>
      <Demo title="Questionnaire" hint="Multi-step questions." wide>
        <Questionnaire>
          <QuestionnaireProgress>1 of 1</QuestionnaireProgress>
          <QuestionnaireItem name="notify">
            <QuestionnaireTitle>How should we notify you?</QuestionnaireTitle>
            <QuestionnaireDescription>Choose one option.</QuestionnaireDescription>
            <QuestionnaireChoices>
              <QuestionnaireChoice value="mentions">
                Mentions only
                <QuestionnaireChoiceDescription>
                  Only when someone mentions you.
                </QuestionnaireChoiceDescription>
              </QuestionnaireChoice>
              <QuestionnaireChoice value="all">All messages</QuestionnaireChoice>
            </QuestionnaireChoices>
          </QuestionnaireItem>
          <QuestionnaireActions>
            <QuestionnaireSubmit>Continue</QuestionnaireSubmit>
          </QuestionnaireActions>
        </Questionnaire>
      </Demo>
    </>
  )
}

function OverlayGallery() {
  return (
    <>
      <Demo title="Dialog" hint="Modal with footer actions.">
        <Dialog>
          <DialogTrigger render={<Button variant="outline" />}>
            Open dialog
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create channel</DialogTitle>
              <DialogDescription>
                Channels are visible to everyone in the server.
              </DialogDescription>
            </DialogHeader>
            <Input placeholder="channel-name" />
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>
                Cancel
              </DialogClose>
              <Button>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Demo>
      <Demo title="Alert Dialog" hint="Destructive confirmation.">
        <AlertDialog>
          <AlertDialogTrigger render={<Button variant="destructive" />}>
            Delete server
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete syrnike13?</AlertDialogTitle>
              <AlertDialogDescription>
                This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Demo>
      <Demo title="Sheet" hint="Side panel.">
        <Sheet>
          <SheetTrigger render={<Button variant="outline" />}>
            Open sheet
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Members</SheetTitle>
              <SheetDescription>24 people online.</SheetDescription>
            </SheetHeader>
            <div className="px-4 text-sm text-muted-foreground">
              Sheet body content.
            </div>
            <SheetFooter>
              <Button>Invite</Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </Demo>
      <Demo title="Drawer" hint="Bottom sheet with swipe handle.">
        <Drawer>
          <DrawerTrigger render={<Button variant="outline" />}>
            Open drawer
          </DrawerTrigger>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>Quick settings</DrawerTitle>
              <DrawerDescription>Swipe down to close.</DrawerDescription>
            </DrawerHeader>
            <div className="p-4 text-sm text-muted-foreground">
              Drawer body content.
            </div>
            <DrawerFooter>
              <Button>Save</Button>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      </Demo>
      <Demo title="Popover" hint="Anchored surface.">
        <Popover>
          <PopoverTrigger render={<Button variant="outline" />}>
            Open popover
          </PopoverTrigger>
          <PopoverContent>
            <PopoverHeader>
              <PopoverTitle>Appearance</PopoverTitle>
              <PopoverDescription>Change the palette.</PopoverDescription>
            </PopoverHeader>
            <Button size="sm">Save</Button>
          </PopoverContent>
        </Popover>
      </Demo>
      <Demo title="Hover Card" hint="Preview on hover.">
        <HoverCard>
          <HoverCardTrigger render={<Button variant="link" />}>
            @syrnike
          </HoverCardTrigger>
          <HoverCardContent>
            <div className="flex items-center gap-3">
              <Avatar>
                <AvatarFallback>SY</AvatarFallback>
              </Avatar>
              <div>
                <p className="text-sm font-semibold">syrnike</p>
                <p className="text-xs text-muted-foreground">Product designer</p>
              </div>
            </div>
          </HoverCardContent>
        </HoverCard>
      </Demo>
      <Demo title="Tooltip" hint="Short contextual hint.">
        <TooltipProvider delay={200}>
          <Tooltip>
            <TooltipTrigger render={<Button variant="outline" size="icon" aria-label="Info" />}>
              <InfoIcon />
            </TooltipTrigger>
            <TooltipContent>Tooltip content</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </Demo>
      <Demo title="Dropdown Menu" hint="Actions and shortcuts.">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" />}>
            Open menu
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Channel</DropdownMenuLabel>
              <DropdownMenuItem description="Default">
                <MicIcon />
                Microphone
              </DropdownMenuItem>
              <DropdownMenuItem>
                Mark as read <DropdownMenuShortcut>⇧R</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem>Copy link</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive">
              <Trash2Icon /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Demo>
      <Demo title="Context Menu" hint="Right click surface.">
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <div className="flex h-24 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground" />
            }
          >
            Right click here
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuGroup>
              <ContextMenuLabel>Message</ContextMenuLabel>
              <ContextMenuItem description="Only @mentions">
                Notification settings
              </ContextMenuItem>
              <ContextMenuItem>
                <ChevronRightIcon /> Reply
              </ContextMenuItem>
              <ContextMenuItem>
                <CopyIcon /> Copy text
              </ContextMenuItem>
              <ContextMenuCheckboxItem
                checked={false}
                closeOnClick={false}
                description="Until 23:00"
              >
                Mute notifications
              </ContextMenuCheckboxItem>
            </ContextMenuGroup>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive">
              <Trash2Icon /> Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </Demo>
      <Demo title="Command" hint="Filterable command list." wide>
        <Command className="rounded-lg border">
          <CommandInput placeholder="Type a command..." />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup heading="Navigation">
              <CommandItem>
                <MessageCircleIcon /> Go to chat
                <CommandShortcut>G C</CommandShortcut>
              </CommandItem>
              <CommandItem>
                <SettingsIcon /> Open settings
                <CommandShortcut>G S</CommandShortcut>
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Voice">
              <CommandItem>
                <MicIcon /> Toggle microphone
              </CommandItem>
              <CommandItem>
                <HeadphonesIcon /> Toggle sound
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </Demo>
      <Demo title="Toast" hint="Base UI toast manager.">
        <div className="space-y-3">
          <Row>
            <Button
              variant="outline"
              onClick={() =>
                baseToast.add({
                  title: 'Saved',
                  description: 'Appearance updated.',
                  type: 'success',
                })
              }
            >
              Show toast
            </Button>
          </Row>
          <BaseToaster />
        </div>
      </Demo>
      <Demo title="Sonner" hint="Application toast queue.">
        <Row>
          <Button
            variant="outline"
            onClick={() => sonnerToast.success('Saved to server')}
          >
            Success
          </Button>
          <Button
            variant="outline"
            onClick={() => sonnerToast.error('Something went wrong')}
          >
            Error
          </Button>
        </Row>
      </Demo>
      <Demo title="Menubar" hint="Desktop menu bar.">
        <Menubar>
          <MenubarMenu>
            <MenubarTrigger>File</MenubarTrigger>
            <MenubarContent>
              <MenubarItem>
                New channel <MenubarShortcut>⌘N</MenubarShortcut>
              </MenubarItem>
              <MenubarItem>Invite</MenubarItem>
              <MenubarSeparator />
              <MenubarItem>Close</MenubarItem>
            </MenubarContent>
          </MenubarMenu>
          <MenubarMenu>
            <MenubarTrigger>Edit</MenubarTrigger>
            <MenubarContent>
              <MenubarItem>Undo</MenubarItem>
              <MenubarItem>Redo</MenubarItem>
            </MenubarContent>
          </MenubarMenu>
        </Menubar>
      </Demo>
      <Demo title="Navigation Menu" hint="Hover navigation.">
        <NavigationMenu>
          <NavigationMenuList>
            <NavigationMenuItem>
              <NavigationMenuTrigger>Product</NavigationMenuTrigger>
              <NavigationMenuContent className="grid w-64 gap-1 p-2">
                <NavigationMenuLink href="#overlays">Features</NavigationMenuLink>
                <NavigationMenuLink href="#overlays">Changelog</NavigationMenuLink>
              </NavigationMenuContent>
            </NavigationMenuItem>
            <NavigationMenuItem>
              <NavigationMenuLink href="#overlays">Docs</NavigationMenuLink>
            </NavigationMenuItem>
          </NavigationMenuList>
        </NavigationMenu>
      </Demo>
    </>
  )
}

const CAKE_VARIANT_LABEL_KEYS: Record<CakeLogoVariant, string> = {
  classic: 'variantClassic',
  witch: 'variantWitch',
}

function ExamplesGallery() {
  const t = useTranslations('layout.loading.preview')
  const [animationRun, setAnimationRun] = useState(0)
  const [logoVariant, setLogoVariant] = useState<CakeLogoVariant>('classic')

  return (
    <>
      <Demo title="Settings card" hint="Section header, field and save bar." wide>
        <div className="max-w-xl space-y-5 rounded-xl border bg-card p-5">
          <div>
            <h3 className="text-base font-semibold">Voice &amp; video</h3>
            <p className="text-sm text-muted-foreground">
              Input device, volume and noise suppression.
            </p>
          </div>
          <Field>
            <FieldLabel htmlFor="example-mic">Microphone</FieldLabel>
            <Select
              defaultValue="default"
              items={[
                { value: 'default', label: 'System default' },
                { value: 'usb', label: 'USB microphone' },
              ]}
            >
              <SelectTrigger id="example-mic" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">System default</SelectItem>
                <SelectItem value="usb">USB microphone</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field orientation="horizontal">
            <Switch id="example-noise" defaultChecked />
            <FieldContent>
              <FieldLabel htmlFor="example-noise">Noise suppression</FieldLabel>
              <FieldDescription>Reduces background noise.</FieldDescription>
            </FieldContent>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost">Reset</Button>
            <Button>Save changes</Button>
          </div>
        </div>
      </Demo>
      <Demo title="Voice participant" hint="Tile with controls.">
        <div className="flex items-center gap-3 rounded-xl border bg-muted/40 p-3">
          <Avatar>
            <AvatarFallback>IS</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">iskra</p>
            <p className="text-xs text-muted-foreground">Speaking</p>
          </div>
          <Button size="icon-sm" variant="ghost" aria-label="Mute">
            <MicIcon />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Disconnect">
            <XIcon />
          </Button>
        </div>
      </Demo>
      <Demo title="Members list" hint="Items with roles.">
        <ItemGroup>
          {[
            { name: 'syrnike', role: 'Owner' },
            { name: 'lug', role: 'Admin' },
            { name: 'iskra', role: 'Member' },
          ].map((member) => (
            <Item key={member.name} variant="outline" size="sm">
              <ItemMedia variant="icon">
                <Gamepad2Icon />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{member.name}</ItemTitle>
                <ItemDescription>{member.role}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Badge variant="secondary">{member.role}</Badge>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      </Demo>
      <Demo title="Invite block" hint="Input with primary action.">
        <div className="space-y-3 rounded-xl border p-4">
          <div className="flex items-center gap-2">
            <LinkIcon className="size-4 text-muted-foreground" />
            <p className="text-sm font-medium">Invite link</p>
          </div>
          <InputGroup>
            <InputGroupInput readOnly defaultValue="https://syrnike13.dev/invite/abc" />
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="xs">Copy</InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
          <Button className="w-full" variant="secondary">
            <UserPlusIcon /> Invite friends
          </Button>
        </div>
      </Demo>
      <Demo title="Chat message" hint="Bubble with reactions.">
        <div className="flex gap-3">
          <Avatar>
            <AvatarFallback>SY</AvatarFallback>
          </Avatar>
          <div className="min-w-0 space-y-1">
            <p className="text-sm">
              <span className="font-semibold">syrnike</span>{' '}
              <span className="text-xs text-muted-foreground">21:24</span>
            </p>
            <p className="text-sm">The new primitives are in.</p>
            <div className="flex gap-1">
              <Badge variant="secondary">👍 3</Badge>
              <Badge variant="outline">
                <PlusIcon /> 1
              </Badge>
            </div>
          </div>
        </div>
      </Demo>
      <Demo title="Media preview" hint="Aspect ratio and monitor icon.">
        <AspectRatio ratio={16 / 9} className="overflow-hidden rounded-lg border bg-muted">
          <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <MonitorIcon className="size-8" />
            <span className="text-sm">Screen share</span>
          </div>
        </AspectRatio>
      </Demo>
      <Demo
        title="Loading screen"
        hint="Boot screen: tetromino assembly; the Halloween witch skin keeps the logo whole."
        wide
      >
        <div
          role="group"
          aria-label={t('variants')}
          className="mb-3 flex flex-wrap gap-2"
        >
          {CAKE_LOGO_VARIANTS.map((variant) => (
            <Button
              key={variant}
              type="button"
              size="sm"
              variant={logoVariant === variant ? 'default' : 'outline'}
              onClick={() => {
                setLogoVariant(variant)
                setAnimationRun((current) => current + 1)
              }}
            >
              {t(CAKE_VARIANT_LABEL_KEYS[variant])}
            </Button>
          ))}
        </div>
        <div role="group" aria-label={t('label')} className="mb-3 flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setAnimationRun((current) => current + 1)}
          >
            {t('replay')}
          </Button>
        </div>
        <div className="relative h-96 overflow-hidden rounded-xl border gradient-surface-content bg-background text-foreground">
          <GatewayLoadingScreenView
            key={`${animationRun}:${logoVariant}`}
            previewMotion={animationRun > 0}
            logoVariant={logoVariant}
            className="absolute inset-0"
            factTitle="Did you know?"
            fact="A pinned message is an important announcement everyone promises to read later."
            status="Connecting"
            showStatus
          />
        </div>
      </Demo>
    </>
  )
}

export function UiGalleryPage() {
  return (
    <div className="flex min-h-svh bg-background text-foreground">
      <GalleryNav />
      <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
        <PalettePanel />
        <div className="space-y-10 pb-16">
          <GallerySection
            id="foundations"
            title="Foundations"
            description="Buttons, surfaces, status and loading primitives. Every component is the literal shadcn base-nova source."
          >
            <ButtonGallery />
          </GallerySection>
          <GallerySection
            id="forms"
            title="Forms"
            description="Inputs, pickers and selection controls built on Base UI."
          >
            <FormGallery />
          </GallerySection>
          <GallerySection
            id="data"
            title="Data display"
            description="Tables, lists, disclosures, charts and media."
          >
            <DataGallery />
          </GallerySection>
          <GallerySection
            id="messaging"
            title="Messaging"
            description="Message layout and scroll management primitives."
          >
            <MessagingGallery />
          </GallerySection>
          <GallerySection
            id="overlays"
            title="Overlays"
            description="Dialogs, sheets, popovers and menus."
          >
            <OverlayGallery />
          </GallerySection>
          <GallerySection
            id="examples"
            title="Examples"
            description="Composed blocks assembled only from the primitives above."
          >
            <ExamplesGallery />
          </GallerySection>
        </div>
      </main>
    </div>
  )
}
