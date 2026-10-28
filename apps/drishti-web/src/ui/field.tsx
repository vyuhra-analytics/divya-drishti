import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes } from "react";
import { cn } from "./cn";

const control =
  "h-7 [font:inherit] rounded-md border border-[color-mix(in_srgb,var(--muted)_65%,transparent)] bg-bg px-2 text-[inherit] text-text outline-none transition-colors placeholder:text-muted hover:border-muted focus-visible:ring-2 focus-visible:ring-accent-fill disabled:opacity-50";

const CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238a8e9a' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")";

/** A native select (keeps the keyboard, mobile pickers and the form tests working) with the app's control look and a chevron. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, children, style, ...props }, ref) => (
  <select
    ref={ref}
    style={{ backgroundImage: CHEVRON, ...style }}
    className={cn(control, "appearance-none bg-[length:12px] bg-[right_8px_center] bg-no-repeat pr-7", className)}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = "Select";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn(control, className)} {...props} />
));
Input.displayName = "Input";
