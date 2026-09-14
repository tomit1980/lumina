"use client"

import * as React from "react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"
import { Tick02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { cn } from "@/lib/utils"

/**
 * A checkbox, from the same Radix package every other primitive here comes
 * from — so it inherits the keyboard behaviour, the label association and the
 * focus ring the rest of the app already has, rather than approximating them.
 *
 * `size-5` (20px) with `after:-inset-1` widening the hit area to 28px: the
 * visual box stays in proportion with the 28px inputs beside it while the
 * thing a thumb has to land on clears the 24px minimum. Same trick the Switch
 * uses.
 */
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative size-5 shrink-0 rounded-[5px] border border-input shadow-xs transition-all outline-none after:absolute after:-inset-1 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:bg-input/30 dark:data-[state=checked]:bg-primary",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        <HugeiconsIcon icon={Tick02Icon} className="size-3.5" strokeWidth={2.5} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
