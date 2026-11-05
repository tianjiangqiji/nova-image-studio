"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

interface SwitchProps extends SwitchPrimitive.Root.Props {
  size?: "default" | "sm"
  variant?: "default" | "neutral"
}

function Switch({ className, size = "default", variant = "default", ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent p-0.5 shadow-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[checked]:bg-primary data-[unchecked]:bg-input dark:data-[unchecked]:bg-input/50",
        size === "sm" && "h-4 w-7 p-px",
        variant === "neutral" && "focus-visible:ring-neutral-400/50 data-[checked]:bg-neutral-900 data-[unchecked]:bg-neutral-300 dark:data-[checked]:bg-neutral-100 dark:data-[unchecked]:bg-neutral-700",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className={cn(
        "pointer-events-none block size-4 rounded-full bg-background shadow-lg ring-0 transition-transform data-[checked]:translate-x-4 data-[unchecked]:translate-x-0",
        size === "sm" && "size-3 data-[checked]:translate-x-3",
        variant === "neutral" && "bg-white dark:bg-neutral-200 dark:data-[checked]:bg-neutral-900",
      )} />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
