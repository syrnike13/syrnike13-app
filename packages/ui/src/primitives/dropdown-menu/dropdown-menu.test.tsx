// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./index"

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

async function renderMenu(item: React.ReactNode, label = "Action") {
  render(
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger>Открыть</DropdownMenuTrigger>
      <DropdownMenuContent>{item}</DropdownMenuContent>
    </DropdownMenu>,
  )

  return screen.findByText(label)
}

describe("DropdownMenuItem description", () => {
  it("renders the description as a secondary line", async () => {
    await renderMenu(
      <DropdownMenuItem description="Default">Microphone</DropdownMenuItem>,
      "Microphone",
    )

    const item = document.querySelector('[data-slot="dropdown-menu-item"]')
    const content = item?.querySelector(
      '[data-slot="dropdown-menu-item-content"]',
    )
    const description = item?.querySelector(
      '[data-slot="dropdown-menu-item-description"]',
    )

    expect(content).toBeInTheDocument()
    expect(description).toHaveTextContent("Default")
    expect(description?.className).toContain("text-xs")
    expect(description?.className).toContain("text-muted-foreground")
    expect(item?.className).toContain("py-1.5")
  })

  it("keeps the plain layout without a description", async () => {
    await renderMenu(<DropdownMenuItem>Copy link</DropdownMenuItem>, "Copy link")

    const item = document.querySelector('[data-slot="dropdown-menu-item"]')

    expect(
      document.querySelector('[data-slot="dropdown-menu-item-content"]'),
    ).toBeNull()
    expect(item?.textContent).toBe("Copy link")
    expect(item?.className).not.toContain("py-1.5")
  })

  it("supports a description on submenu triggers", async () => {
    await renderMenu(
      <DropdownMenuSub>
        <DropdownMenuSubTrigger description="Default">
          Microphone
        </DropdownMenuSubTrigger>
      </DropdownMenuSub>,
      "Microphone",
    )

    const trigger = document.querySelector(
      '[data-slot="dropdown-menu-sub-trigger"]',
    )

    expect(
      trigger?.querySelector('[data-slot="dropdown-menu-item-description"]'),
    ).toHaveTextContent("Default")
    expect(trigger?.className).toContain("py-1.5")
  })

  it("supports a description on checkbox items", async () => {
    await renderMenu(
      <DropdownMenuCheckboxItem checked description="Muted until 23.10">
        Notifications
      </DropdownMenuCheckboxItem>,
      "Notifications",
    )

    const item = document.querySelector(
      '[data-slot="dropdown-menu-checkbox-item"]',
    )

    expect(
      item?.querySelector('[data-slot="dropdown-menu-item-description"]'),
    ).toHaveTextContent("Muted until 23.10")
    expect(item?.className).toContain("py-1.5")
    expect(item?.className).toContain("pr-9")
    expect(
      item?.querySelector('[data-slot="dropdown-menu-checkbox-item-indicator"]'),
    ).toBeInTheDocument()
  })

  it("supports a description on radio items", async () => {
    await renderMenu(
      <DropdownMenuRadioGroup value="all">
        <DropdownMenuRadioItem value="all" description="Every message">
          All messages
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>,
      "All messages",
    )

    const item = document.querySelector('[data-slot="dropdown-menu-radio-item"]')

    expect(
      item?.querySelector('[data-slot="dropdown-menu-item-description"]'),
    ).toHaveTextContent("Every message")
    expect(item?.className).toContain("py-1.5")
    expect(
      item?.querySelector('[data-slot="dropdown-menu-radio-item-indicator"]'),
    ).toBeInTheDocument()
  })
})
