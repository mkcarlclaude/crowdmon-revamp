import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Every generated shadcn/ui component imports this. `clsx` resolves the
 * conditional-class idiom those components are written in; `twMerge` then
 * collapses conflicting Tailwind utilities (two `px-*` values, say) to the
 * last one instead of shipping both to the browser and letting CSS source
 * order decide.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
