import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "./cn";

const button = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border text-[inherit] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent-fill disabled:pointer-events-none disabled:opacity-50 cursor-pointer",
  {
    variants: {
      variant: {
        default: "border-accent-fill bg-accent-fill text-on-accent hover:brightness-110",
        outline: "border-line bg-transparent text-text hover:bg-hover",
        ghost: "border-transparent bg-transparent text-text hover:bg-hover",
        destructive: "border-down bg-transparent text-down hover:bg-hover",
      },
      size: { sm: "h-6 px-2 text-[12px]", md: "h-7 px-3", icon: "h-7 w-7" },
    },
    defaultVariants: { variant: "outline", size: "md" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, asChild, type, ...props }, ref) => {
  const Comp = asChild ? Slot : "button";
  return <Comp ref={ref} type={type} className={cn(button({ variant, size }), className)} {...props} />;
});
Button.displayName = "Button";
