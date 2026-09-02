"use client"

import * as React from "react"
import { Select as SelectPrimitive } from "@base-ui/react/select"
import { Check, ChevronsUpDown } from "lucide-react"

import { cn } from "@/lib/utils"

export type SelectOption<T extends string> = {
  value: T
  label: React.ReactNode
  disabled?: boolean
}

/**
 * antd `<Select>` 的 shadcn 替代（基于 @base-ui/react，与本项目其它基础件一致）。
 */
function Select<T extends string>({
  value,
  onValueChange,
  options,
  placeholder,
  className,
  contentClassName,
  disabled,
  ariaLabel,
  size = "default",
}: {
  value: T
  onValueChange: (value: T) => void
  options: SelectOption<T>[]
  placeholder?: React.ReactNode
  className?: string
  contentClassName?: string
  disabled?: boolean
  ariaLabel?: string
  size?: "sm" | "default"
}) {
  return (
    <SelectPrimitive.Root
      value={value}
      disabled={disabled}
      items={options}
      onValueChange={(next) => onValueChange(next as T)}
    >
      <SelectPrimitive.Trigger
        data-slot="select-trigger"
        aria-label={ariaLabel}
        className={cn(
          "inline-flex w-full items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-2.5 text-sm transition-colors outline-none select-none hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[popup-open]:bg-muted/50 dark:bg-input/30",
          size === "sm" ? "h-7" : "h-8",
          className
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon className="shrink-0 text-muted-foreground">
          <ChevronsUpDown className="size-3.5" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          sideOffset={4}
          alignItemWithTrigger={false}
          className="z-[70] outline-none"
        >
          <SelectPrimitive.Popup
            className={cn(
              "max-h-[min(24rem,var(--available-height))] min-w-[var(--anchor-width)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              contentClassName
            )}
          >
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="relative flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-8 pl-2.5 text-sm transition-colors outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-muted"
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="absolute right-2 flex items-center text-primary">
                  <Check className="size-4" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

export { Select }
