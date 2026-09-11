import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * shadcn/ui's class combiner: `clsx` for conditional class lists, `tailwind-merge` so a caller's `className`
 * can override a component's own utility of the same kind instead of both landing in the class attribute and
 * the cascade picking a winner by stylesheet order.
 */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
