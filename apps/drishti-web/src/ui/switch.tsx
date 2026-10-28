import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "./cn";

export const Switch = forwardRef<ElementRef<typeof SwitchPrimitive.Root>, ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-line bg-bg outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent-fill disabled:opacity-50 data-[state=checked]:border-accent-fill data-[state=checked]:bg-accent-fill",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="block h-3 w-3 translate-x-0.5 rounded-full bg-muted transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-on-accent" />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";
