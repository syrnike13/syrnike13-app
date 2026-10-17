// design-allow-file hardcoded-string: internal developer component gallery; demo copy is illustrative.
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import {
  BanIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CopyIcon,
  DownloadIcon,
  Gamepad2Icon,
  HeadphonesIcon,
  InfoIcon,
  Loader2Icon,
  MessageCircleIcon,
  MicIcon,
  MicOffIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  ShieldOffIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserPlusIcon,
} from '#/components/icons'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@syrnike13/ui/primitives/accordion'
import { Alert, AlertDescription, AlertTitle } from '@syrnike13/ui/primitives/alert'
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
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from '@syrnike13/ui/primitives/avatar'
import { Badge } from '@syrnike13/ui/primitives/badge'
import {
  Button,
  buttonVariants,
} from '@syrnike13/ui/primitives/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@syrnike13/ui/primitives/card'
import { Checkbox } from '@syrnike13/ui/primitives/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@syrnike13/ui/primitives/collapsible'
import { Combobox } from '@syrnike13/ui/primitives/combobox'
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
  ContextMenuContent,
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
  DrawerHeader,
  DrawerTitle,
} from '@syrnike13/ui/primitives/drawer'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@syrnike13/ui/primitives/dropdown-menu'
import { Field } from '@syrnike13/ui/primitives/field'
import { FloatingMenu, FloatingMenuItem } from '@syrnike13/ui/primitives/floating-menu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@syrnike13/ui/primitives/hover-card'
import { IconButton } from '@syrnike13/ui/primitives/icon-button'
import { Input } from '@syrnike13/ui/primitives/input'
import { Kbd } from '@syrnike13/ui/primitives/kbd'
import { Label } from '@syrnike13/ui/primitives/label'
import {
  LayerCard,
  LayerCardPrimary,
  LayerCardSecondary,
  LayerCardStrip,
} from '@syrnike13/ui/primitives/layer-card'
import { ListItem } from '@syrnike13/ui/primitives/list-item'
import { Marker, MarkerContent, MarkerIcon } from '@syrnike13/ui/primitives/marker'
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from '@syrnike13/ui/primitives/popover'
import { Progress } from '@syrnike13/ui/primitives/progress'
import { RadioGroup, RadioGroupItem } from '@syrnike13/ui/primitives/radio-group'
import { ScrollArea } from '@syrnike13/ui/primitives/scroll-area'
import { SearchField } from '@syrnike13/ui/primitives/search-field'
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
import { Spinner } from '@syrnike13/ui/primitives/spinner'
import { Squircle } from '@syrnike13/ui/primitives/squircle'
import { Switch } from '@syrnike13/ui/primitives/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@syrnike13/ui/primitives/tabs'
import { Textarea } from '@syrnike13/ui/primitives/textarea'
import { Toggle } from '@syrnike13/ui/primitives/toggle'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@syrnike13/ui/primitives/tooltip'

const COMPONENT_NAV = [
  { id: 'foundations', label: 'Foundations' },
  { id: 'forms', label: 'Forms' },
  { id: 'overlays', label: 'Overlays' },
  { id: 'navigation', label: 'Navigation' },
  { id: 'examples', label: 'Examples' },
] as const

function Section({
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
    <section id={id} className="scroll-mt-24 space-y-4">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
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

function ButtonGallery() {
  return (
    <Demo title="Button" hint="Variants, sizes and icon composition." wide>
      <div className="space-y-4">
        <Row>
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="success">Success</Button>
          <Button variant="link">Link</Button>
          <Button variant="quiet">Quiet</Button>
          <Button variant="outline-ghost">Outline ghost</Button>
          <Button variant="inverse">Inverse</Button>
        </Row>
        <Row>
          <Button size="xs">Extra small</Button>
          <Button size="sm">Small</Button>
          <Button>Default</Button>
          <Button size="lg">Large</Button>
          <Button size="icon" aria-label="Icon button">
            <PlusIcon />
          </Button>
          <Button size="icon-sm" aria-label="Add member">
            <UserPlusIcon />
          </Button>
        </Row>
        <Row>
          <Button>
            <DownloadIcon data-icon="inline-start" />
            Download
          </Button>
          <Button variant="outline">
            <SettingsIcon data-icon="inline-start" />
            Settings
          </Button>
          <Button variant="destructive">
            <Trash2Icon data-icon="inline-start" />
            Delete
          </Button>
          <Button disabled>
            <Loader2Icon className="animate-spin" data-icon="inline-start" />
            Saving
          </Button>
        </Row>
        <div className="rounded-lg bg-media-backdrop p-4">
          <Row>
            <Button variant="media-outline">Media outline</Button>
            <Button variant="media-ghost">Media ghost</Button>
            <Button variant="media-ghost-active">Active</Button>
            <Button variant="scrim">Scrim</Button>
          </Row>
        </div>
      </div>
    </Demo>
  )
}

function Foundations() {
  return (
    <>
      <ButtonGallery />

      <Demo title="IconButton" hint="Button with icon sizing and a required label.">
        <Row>
          <IconButton aria-label="Search">
            <SearchIcon />
          </IconButton>
          <IconButton aria-label="Settings" variant="outline">
            <SettingsIcon />
          </IconButton>
          <IconButton aria-label="Delete" variant="destructive">
            <Trash2Icon />
          </IconButton>
          <IconButton aria-label="Copy" variant="ghost" size="icon-sm">
            <CopyIcon />
          </IconButton>
        </Row>
      </Demo>

      <Demo title="Badge" hint="Status and meta labels.">
        <Row>
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Destructive</Badge>
          <Badge variant="success">Success</Badge>
          <Badge variant="warning">Warning</Badge>
          <Badge variant="contrast">3</Badge>
        </Row>
      </Demo>

      <Demo title="Alert" hint="Inline status messages." wide>
        <div className="grid gap-3 md:grid-cols-2">
          <Alert>
            <InfoIcon />
            <div>
              <AlertTitle>Information</AlertTitle>
              <AlertDescription>Neutral contextual message.</AlertDescription>
            </div>
          </Alert>
          <Alert variant="success">
            <CircleCheckIcon />
            <div>
              <AlertTitle>Success</AlertTitle>
              <AlertDescription>Changes were saved.</AlertDescription>
            </div>
          </Alert>
          <Alert variant="warning">
            <TriangleAlertIcon />
            <div>
              <AlertTitle>Warning</AlertTitle>
              <AlertDescription>Check the selected device.</AlertDescription>
            </div>
          </Alert>
          <Alert variant="destructive">
            <ShieldOffIcon />
            <div>
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>The request could not be completed.</AlertDescription>
            </div>
          </Alert>
        </div>
      </Demo>

      <Demo title="Avatar" hint="Image, fallback, presence badge and groups.">
        <div className="space-y-4">
          <Row>
            <Avatar size="sm">
              <AvatarImage src="/app-logo.png" alt="Syrnike" />
              <AvatarFallback>SY</AvatarFallback>
            </Avatar>
            <Avatar>
              <AvatarImage src="/app-logo.png" alt="Syrnike" />
              <AvatarFallback>SY</AvatarFallback>
            </Avatar>
            <Avatar size="lg">
              <AvatarFallback>AL</AvatarFallback>
              <AvatarBadge />
            </Avatar>
            <Avatar size="lg">
              <AvatarFallback>MK</AvatarFallback>
            </Avatar>
          </Row>
          <AvatarGroup>
            <Avatar>
              <AvatarFallback>AL</AvatarFallback>
            </Avatar>
            <Avatar>
              <AvatarFallback>MK</AvatarFallback>
            </Avatar>
            <Avatar>
              <AvatarFallback>SY</AvatarFallback>
            </Avatar>
            <AvatarGroupCount>+4</AvatarGroupCount>
          </AvatarGroup>
        </div>
      </Demo>

      <Demo title="Card" hint="Header, action, content and footer.">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Nightly build</CardTitle>
            <CardDescription>Rolling channel for the desktop client.</CardDescription>
            <CardAction>
              <Badge variant="success">Live</Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Builds ship automatically after every merge into develop.
          </CardContent>
          <CardFooter className="gap-2">
            <Button size="sm">Install</Button>
            <Button size="sm" variant="ghost">
              Details
            </Button>
          </CardFooter>
        </Card>
      </Demo>

      <Demo title="LayerCard" hint="Compact layered list row with a footer strip.">
        <LayerCard className="w-full">
          <LayerCardPrimary>
            <Avatar>
              <AvatarFallback>SY</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">Syrnike desktop</div>
              <LayerCardSecondary>Version 0.7.1 · nightly</LayerCardSecondary>
            </div>
          </LayerCardPrimary>
          <LayerCardStrip className="mt-3">
            <Badge variant="secondary">Electron</Badge>
            <Badge variant="outline">Windows</Badge>
          </LayerCardStrip>
        </LayerCard>
      </Demo>

      <Demo title="Squircle" hint="Squircle surface with an optional ring.">
        <Row>
          <Squircle
            size={56}
            cornerRadius={16}
            className="bg-primary text-primary-foreground"
          >
            <span className="flex size-full items-center justify-center text-sm font-semibold">
              SY
            </span>
          </Squircle>
          <Squircle
            size={56}
            cornerRadius={16}
            ring
            className="bg-secondary text-secondary-foreground"
          >
            <span className="flex size-full items-center justify-center">
              <Gamepad2Icon className="size-6" />
            </span>
          </Squircle>
        </Row>
      </Demo>

      <Demo title="Separator" hint="Horizontal and vertical dividers.">
        <div className="space-y-3">
          <Separator />
          <div className="flex h-8 items-center gap-3 text-sm text-muted-foreground">
            <span>Above</span>
            <Separator orientation="vertical" />
            <span>Below</span>
          </div>
        </div>
      </Demo>

      <Demo title="Skeleton & Spinner" hint="Loading placeholders.">
        <div className="space-y-4">
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-20 w-full" />
          </div>
          <Row>
            <Spinner label="Loading" />
            <Spinner label="Loading" className="size-6" />
            <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
          </Row>
        </div>
      </Demo>

      <Demo title="Kbd" hint="Keyboard hint.">
        <Row>
          <Kbd>Ctrl</Kbd>
          <span className="text-sm text-muted-foreground">+</span>
          <Kbd>K</Kbd>
          <Kbd>Esc</Kbd>
        </Row>
      </Demo>

      <Demo title="Marker" hint="Icon + truncated label.">
        <div className="space-y-2">
          <Marker>
            <MarkerIcon>
              <MicIcon />
            </MarkerIcon>
            <MarkerContent>Microphone</MarkerContent>
          </Marker>
          <Marker>
            <MarkerIcon>
              <HeadphonesIcon />
            </MarkerIcon>
            <MarkerContent>Headphones</MarkerContent>
          </Marker>
        </div>
      </Demo>

      <Demo title="Progress" hint="Determinate progress bar.">
        <div className="space-y-3">
          <Progress value={35} />
          <Progress value={72} />
        </div>
      </Demo>

      <Demo title="ListItem" hint="Default, flush and inset rows.">
        <div className="space-y-2">
          <ListItem variant="inset">
            <Avatar size="sm">
              <AvatarFallback>AL</AvatarFallback>
            </Avatar>
            <span className="flex-1 truncate">Alice</span>
            <Badge variant="secondary">Admin</Badge>
          </ListItem>
          <ListItem variant="flush">
            <Avatar size="sm">
              <AvatarFallback>MK</AvatarFallback>
            </Avatar>
            <span className="flex-1 truncate">Mark</span>
            <span className="text-xs text-muted-foreground">Online</span>
          </ListItem>
          <ListItem variant="flush" active>
            <Avatar size="sm">
              <AvatarFallback>SY</AvatarFallback>
            </Avatar>
            <span className="flex-1 truncate">Syrnike</span>
            <span className="text-xs text-muted-foreground">Selected</span>
          </ListItem>
        </div>
      </Demo>
    </>
  )
}

function Forms() {
  const [search, setSearch] = useState('nightly')
  const [combo, setCombo] = useState('stable')

  return (
    <>
      <Demo title="Input & Textarea" hint="Text fields with placeholder and disabled state.">
        <div className="space-y-3">
          <Input placeholder="Display name" />
          <Input placeholder="Disabled input" disabled />
          <Textarea placeholder="Tell us more…" rows={3} />
        </div>
      </Demo>

      <Demo title="Label + Input" hint="Manual association through htmlFor/id.">
        <div className="space-y-2">
          <Label htmlFor="gallery-email">Email</Label>
          <Input id="gallery-email" type="email" placeholder="you@syrnike13.ru" />
        </div>
      </Demo>

      <Demo title="Field" hint="Label, control, hint and error in one primitive.">
        <div className="space-y-4">
          <Field label="Username" hint="Visible to everyone.">
            <Input placeholder="syrnike" />
          </Field>
          <Field label="Slug" error="This slug is already taken.">
            <Input defaultValue="syrnike" />
          </Field>
        </div>
      </Demo>

      <Demo title="SearchField" hint="Search input with a clear action.">
        <SearchField
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onClear={() => setSearch('')}
          placeholder="Search messages"
        />
      </Demo>

      <Demo title="Checkbox & Switch" hint="Boolean controls.">
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Checkbox id="gallery-notifications" defaultChecked />
            <Label htmlFor="gallery-notifications">Enable notifications</Label>
          </div>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium">Screen share audio</div>
              <div className="text-xs text-muted-foreground">
                Capture system sound with the stream.
              </div>
            </div>
            <Switch defaultChecked />
          </div>
        </div>
      </Demo>

      <Demo title="RadioGroup" hint="Single choice.">
        <RadioGroup defaultValue="everyone">
          <div className="flex items-center gap-2">
            <RadioGroupItem id="gallery-everyone" value="everyone" />
            <Label htmlFor="gallery-everyone">Everyone</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem id="gallery-friends" value="friends" />
            <Label htmlFor="gallery-friends">Friends only</Label>
          </div>
        </RadioGroup>
      </Demo>

      <Demo title="Slider" hint="Range input.">
        <div className="space-y-3">
          <Slider defaultValue={[45]} max={100} step={1} />
          <Slider defaultValue={[20, 70]} max={100} step={1} />
        </div>
      </Demo>

      <Demo title="Select" hint="Grouped options.">
        <Select defaultValue="stable">
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Release channel" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Channel</SelectLabel>
              <SelectItem value="stable">Stable</SelectItem>
              <SelectItem value="nightly">Nightly</SelectItem>
              <SelectItem value="development">Development</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Demo>

      <Demo title="Combobox" hint="Searchable select built on Popover + Command.">
        <Combobox
          options={[
            { value: 'stable', label: 'Stable' },
            { value: 'nightly', label: 'Nightly' },
            { value: 'development', label: 'Development' },
          ]}
          value={combo}
          onChange={setCombo}
          placeholder="Select channel"
          searchPlaceholder="Search channel…"
          emptyText="Nothing found"
        />
      </Demo>

      <Demo title="Toggle" hint="Pressed-state button.">
        <Row>
          <Toggle aria-label="Mic">
            <MicIcon />
          </Toggle>
          <Toggle aria-label="Headphones" defaultPressed>
            <HeadphonesIcon />
          </Toggle>
          <Toggle size="sm">
            <SettingsIcon />
            Settings
          </Toggle>
        </Row>
      </Demo>
    </>
  )
}

function Overlays() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [floating, setFloating] = useState<{ open: boolean; x: number; y: number }>({
    open: false,
    x: 0,
    y: 0,
  })

  return (
    <>
      <Demo title="Dialog" hint="Modal with header, body and footer.">
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button variant="outline">Open dialog</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete this channel?</DialogTitle>
              <DialogDescription>
                This action cannot be undone. Messages will be removed.
              </DialogDescription>
            </DialogHeader>
            <Field label="Reason" hint="Visible in the audit log.">
              <Input placeholder="Optional" />
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost">Cancel</Button>
              </DialogClose>
              <Button variant="destructive" onClick={() => setDialogOpen(false)}>
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Demo>

      <Demo title="AlertDialog" hint="Destructive confirmation.">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">Remove member</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove Alice?</AlertDialogTitle>
              <AlertDialogDescription>
                They will lose access to this server immediately.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction>Remove</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </Demo>

      <Demo title="Sheet" hint="Side panel anchored to the viewport.">
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="outline">Open sheet</Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Channel settings</SheetTitle>
              <SheetDescription>Manage permissions and notifications.</SheetDescription>
            </SheetHeader>
            <div className="grid gap-4 p-4">
              <Field label="Channel name">
                <Input defaultValue="general" />
              </Field>
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm">Slow mode</span>
                <Switch />
              </div>
            </div>
            <SheetFooter>
              <Button>Save changes</Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      </Demo>

      <Demo title="Drawer" hint="Bottom sheet for mobile flows.">
        <Button variant="outline" onClick={() => setDrawerOpen(true)}>
          Open drawer
        </Button>
        <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>Voice participants</DrawerTitle>
              <DrawerDescription>3 people are in this channel.</DrawerDescription>
            </DrawerHeader>
            <div className="space-y-2 px-4 pb-6">
              <ListItem variant="flush">
                <Avatar size="sm">
                  <AvatarFallback>AL</AvatarFallback>
                </Avatar>
                <span className="flex-1">Alice</span>
                <MicIcon className="size-4 text-muted-foreground" />
              </ListItem>
              <ListItem variant="flush">
                <Avatar size="sm">
                  <AvatarFallback>MK</AvatarFallback>
                </Avatar>
                <span className="flex-1">Mark</span>
                <MicOffIcon className="size-4 text-muted-foreground" />
              </ListItem>
              <Button
                variant="outline"
                className="mt-2 w-full"
                onClick={() => setDrawerOpen(false)}
              >
                Close
              </Button>
            </div>
          </DrawerContent>
        </Drawer>
      </Demo>

      <Demo title="Popover" hint="Anchored floating content.">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline">Open popover</Button>
          </PopoverTrigger>
          <PopoverContent className="w-72">
            <PopoverHeader>
              <PopoverTitle>Notifications</PopoverTitle>
              <PopoverDescription>
                Choose which events should reach you.
              </PopoverDescription>
            </PopoverHeader>
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span>Mentions</span>
                <Switch defaultChecked />
              </div>
              <div className="flex items-center justify-between gap-3 text-sm">
                <span>Direct messages</span>
                <Switch defaultChecked />
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </Demo>

      <Demo title="HoverCard" hint="Preview on hover.">
        <HoverCard>
          <HoverCardTrigger asChild>
            <Button variant="link">@syrnike</Button>
          </HoverCardTrigger>
          <HoverCardContent className="w-64">
            <div className="flex items-center gap-3">
              <Avatar>
                <AvatarImage src="/app-logo.png" alt="Syrnike" />
                <AvatarFallback>SY</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">Syrnike</div>
                <div className="truncate text-xs text-muted-foreground">@syrnike</div>
              </div>
            </div>
          </HoverCardContent>
        </HoverCard>
      </Demo>

      <Demo title="Tooltip" hint="Compact hint on hover.">
        <TooltipProvider delayDuration={200}>
          <Row>
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton aria-label="Copy user ID" variant="outline">
                  <CopyIcon />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent>Copy user ID</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton aria-label="Settings" variant="outline">
                  <SettingsIcon />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent>Open settings</TooltipContent>
            </Tooltip>
          </Row>
        </TooltipProvider>
      </Demo>

      <Demo title="DropdownMenu" hint="Menu with shortcut hints.">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline">
              Actions
              <ChevronDownIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Channel</DropdownMenuLabel>
            <DropdownMenuItem>
              <SettingsIcon />
              Settings
              <DropdownMenuShortcut>⌘,</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem>
              <UserPlusIcon />
              Invite people
            </DropdownMenuItem>
            <DropdownMenuItem>
              <CopyIcon />
              Copy link
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive">
              <Trash2Icon />
              Delete channel
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Demo>

      <Demo title="ContextMenu" hint="Right-click menu.">
        <ContextMenu>
          <ContextMenuTrigger className="flex h-24 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
            Right-click this area
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuLabel>Message</ContextMenuLabel>
            <ContextMenuItem>
              <MessageCircleIcon />
              Reply
            </ContextMenuItem>
            <ContextMenuItem>
              <CopyIcon />
              Copy text
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive">
              <Trash2Icon />
              Delete
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </Demo>

      <Demo title="FloatingMenu" hint="Portal menu positioned at a point.">
        <div className="relative h-24">
          <Button
            variant="outline"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setFloating({
                open: true,
                x: rect.left,
                y: rect.bottom + 8,
              })
            }}
          >
            Open floating menu
          </Button>
          <FloatingMenu
            open={floating.open}
            x={floating.x}
            y={floating.y}
            onClose={() => setFloating((current) => ({ ...current, open: false }))}
          >
            <FloatingMenuItem>
              <CopyIcon className="size-3.5" />
              Copy ID
            </FloatingMenuItem>
            <FloatingMenuItem destructive>
              <BanIcon className="size-3.5" />
              Block user
            </FloatingMenuItem>
          </FloatingMenu>
        </div>
      </Demo>

      <Demo title="Command" hint="Inline command list." wide>
        <Command className="rounded-lg border border-border">
          <CommandInput placeholder="Search commands…" />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup heading="Navigation">
              <CommandItem>
                <PlusIcon />
                New channel
                <CommandShortcut>⌘N</CommandShortcut>
              </CommandItem>
              <CommandItem>
                <UserPlusIcon />
                Invite people
              </CommandItem>
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Settings">
              <CommandItem>
                <SettingsIcon />
                Open settings
                <CommandShortcut>⌘,</CommandShortcut>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </Demo>

      <Demo title="Sonner" hint="Global toaster; trigger sample toasts." wide>
        <Row>
          <Button
            variant="outline"
            onClick={() => toast.success('Settings saved')}
          >
            Success toast
          </Button>
          <Button
            variant="outline"
            onClick={() => toast.error('Could not save settings')}
          >
            Error toast
          </Button>
          <Button
            variant="outline"
            onClick={() => toast.message('Update available', { description: 'v0.7.1 is ready to install.' })}
          >
            Message toast
          </Button>
        </Row>
      </Demo>
    </>
  )
}

function Navigation() {
  return (
    <>
      <Demo title="Tabs" hint="Default and line variants." wide>
        <div className="space-y-6">
          <Tabs defaultValue="overview">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="members">Members</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="pt-3 text-sm text-muted-foreground">
              Channel overview content.
            </TabsContent>
            <TabsContent value="members" className="pt-3 text-sm text-muted-foreground">
              Member list content.
            </TabsContent>
            <TabsContent value="settings" className="pt-3 text-sm text-muted-foreground">
              Settings content.
            </TabsContent>
          </Tabs>
          <Tabs defaultValue="general">
            <TabsList variant="line">
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="roles">Roles</TabsTrigger>
            </TabsList>
            <TabsContent value="general" className="pt-3 text-sm text-muted-foreground">
              General settings.
            </TabsContent>
            <TabsContent value="roles" className="pt-3 text-sm text-muted-foreground">
              Role settings.
            </TabsContent>
          </Tabs>
        </div>
      </Demo>

      <Demo title="Accordion" hint="Collapsible sections.">
        <Accordion type="single" collapsible defaultValue="item-1">
          <AccordionItem value="item-1">
            <AccordionTrigger>Appearance</AccordionTrigger>
            <AccordionContent>
              Theme, color mode and custom gradient controls.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-2">
            <AccordionTrigger>Notifications</AccordionTrigger>
            <AccordionContent>
              Push, mentions and sound preferences.
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="item-3">
            <AccordionTrigger>Voice & video</AccordionTrigger>
            <AccordionContent>
              Input, output and camera device selection.
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Demo>

      <Demo title="Collapsible" hint="Single disclosure region.">
        <Collapsible defaultOpen>
          <CollapsibleTrigger asChild>
            <Button variant="ghost">
              <ChevronDownIcon data-icon="inline-start" />
              Advanced
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3 text-sm text-muted-foreground">
            Experimental options and diagnostics.
          </CollapsibleContent>
        </Collapsible>
      </Demo>

      <Demo title="ScrollArea" hint="Overlay scrollbar container.">
        <ScrollArea className="h-40 rounded-md border border-border">
          <div className="space-y-1 p-3">
            {Array.from({ length: 12 }, (_, index) => (
              <div
                key={index}
                className="rounded px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted"
              >
                List row {index + 1}
              </div>
            ))}
          </div>
        </ScrollArea>
      </Demo>
    </>
  )
}

function Examples() {
  const [channel, setChannel] = useState('stable')

  return (
    <>
      <Demo title="Settings block" hint="Fields, switches and a save action." wide>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="space-y-4">
            <Field label="Display name" hint="Shown next to your messages.">
              <Input defaultValue="Syrnike" />
            </Field>
            <Field label="Custom status">
              <Input placeholder="What are you up to?" />
            </Field>
            <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
              <div>
                <div className="text-sm font-medium">Push notifications</div>
                <div className="text-xs text-muted-foreground">
                  Receive mentions while the app is in the background.
                </div>
              </div>
              <Switch defaultChecked />
            </div>
          </div>
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
            <div className="text-sm font-medium">Preview</div>
            <div className="flex items-center gap-3">
              <Avatar>
                <AvatarImage src="/app-logo.png" alt="Syrnike" />
                <AvatarFallback>SY</AvatarFallback>
                <AvatarBadge />
              </Avatar>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">Syrnike</div>
                <div className="truncate text-xs text-muted-foreground">@syrnike</div>
              </div>
            </div>
            <Button size="sm" className="w-full">
              Save profile
            </Button>
            <Button size="sm" variant="ghost" className="w-full">
              Reset
            </Button>
          </div>
        </div>
      </Demo>

      <Demo title="Feedback card" hint="Badges, votes, progress and actions.">
        <Card className="w-full">
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="success">Idea</Badge>
              <Badge variant="outline">Navigation</Badge>
              <Badge variant="warning">Planned</Badge>
            </div>
            <CardTitle className="text-base">Keyboard navigation in the channel list</CardTitle>
            <CardDescription>
              Let arrow keys move between channels without opening the palette.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Votes</span>
              <span>42 / 100</span>
            </div>
            <Progress value={42} />
          </CardContent>
          <CardFooter className="gap-2">
            <Button size="sm">
              <CheckIcon data-icon="inline-start" />
              Vote
            </Button>
            <Button size="sm" variant="outline">
              <MessageCircleIcon data-icon="inline-start" />
              Discuss
            </Button>
          </CardFooter>
        </Card>
      </Demo>

      <Demo title="Voice participant" hint="Avatar, status marker and controller actions.">
        <LayerCard className="w-full">
          <LayerCardPrimary>
            <div className="relative">
              <Avatar size="lg">
                <AvatarImage src="/app-logo.png" alt="Syrnike" />
                <AvatarFallback>SY</AvatarFallback>
                <AvatarBadge />
              </Avatar>
            </div>
            <div className="min-w-0 flex-1">
              <Marker>
                <MarkerContent>Syrnike</MarkerContent>
                <Badge variant="success">On air</Badge>
              </Marker>
              <LayerCardSecondary>Screen sharing · 1280×720</LayerCardSecondary>
            </div>
            <Row>
              <IconButton aria-label="Mute microphone" variant="ghost" size="icon-sm">
                <MicIcon />
              </IconButton>
              <IconButton aria-label="Deafen" variant="ghost" size="icon-sm">
                <HeadphonesIcon />
              </IconButton>
            </Row>
          </LayerCardPrimary>
          <LayerCardStrip className="mt-3">
            <Button size="xs" variant="outline">
              Focus
            </Button>
            <Button size="xs" variant="destructive-ghost">
              Disconnect
            </Button>
          </LayerCardStrip>
        </LayerCard>
      </Demo>

      <Demo title="Members list" hint="List items with role badges." wide>
        <Card className="w-full py-0">
          <div className="divide-y divide-border">
            {[
              { name: 'Alice', handle: '@alice', role: 'Admin', tone: 'default' as const },
              { name: 'Mark', handle: '@mark', role: 'Moderator', tone: 'success' as const },
              { name: 'Syrnike', handle: '@syrnike', role: 'Member', tone: 'secondary' as const },
            ].map((member) => (
              <ListItem key={member.handle} asChild variant="flush">
                <div>
                  <Avatar>
                    <AvatarFallback>{member.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{member.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{member.handle}</div>
                  </div>
                  <Badge variant={member.tone}>{member.role}</Badge>
                  <IconButton aria-label={`Message ${member.name}`} variant="ghost" size="icon-sm">
                    <MessageCircleIcon />
                  </IconButton>
                </div>
              </ListItem>
            ))}
          </div>
        </Card>
      </Demo>

      <Demo title="Invite block" hint="Form, select and inline actions.">
        <div className="space-y-4">
          <Field label="Invite link" hint="Anyone with this link can join.">
            <div className="flex gap-2">
              <Input readOnly defaultValue="https://syrnike13.ru/invite/abc123" />
              <Button variant="outline">
                <CopyIcon data-icon="inline-start" />
                Copy
              </Button>
            </div>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Channel</Label>
              <Select value={channel} onValueChange={setChannel}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stable">Stable</SelectItem>
                  <SelectItem value="nightly">Nightly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Expires</Label>
              <Select defaultValue="7">
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1 day</SelectItem>
                  <SelectItem value="7">7 days</SelectItem>
                  <SelectItem value="30">30 days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Alert variant="info">
            <InfoIcon />
            <div>
              <AlertTitle>Invite limits</AlertTitle>
              <AlertDescription>
                The link stops working after the selected period.
              </AlertDescription>
            </div>
          </Alert>
        </div>
      </Demo>
    </>
  )
}

export function UiGalleryPage() {
  return (
    <main className="mx-auto w-full max-w-[90rem] px-4 py-8 sm:px-6">
      <header className="mb-8 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">UI kit</h1>
          <Badge variant="warning">dev only</Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Every shared primitive from <code className="rounded bg-muted px-1 py-0.5">@syrnike13/ui</code> plus
          a few composed blocks. This page is available only in development builds.
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Route</span>
          <Kbd>/dev/ui</Kbd>
        </div>
        <nav className="flex flex-wrap gap-1">
          {COMPONENT_NAV.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className={buttonVariants({ size: 'sm', variant: 'ghost' })}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </header>

      <div className="space-y-12">
        <Section
          id="foundations"
          title="Foundations"
          description="Surfaces, actions, status indicators and loading states."
        >
          <Foundations />
        </Section>
        <Section
          id="forms"
          title="Forms"
          description="Inputs, labels, selection controls and validation states."
        >
          <Forms />
        </Section>
        <Section
          id="overlays"
          title="Overlays"
          description="Dialogs, menus, popovers, command palette and toasts."
        >
          <Overlays />
        </Section>
        <Section
          id="navigation"
          title="Navigation & disclosure"
          description="Tabs, accordions and scroll containers."
        >
          <Navigation />
        </Section>
        <Section
          id="examples"
          title="Composed blocks"
          description="Small reference compositions made only from the primitives above."
        >
          <Examples />
        </Section>
      </div>
    </main>
  )
}
