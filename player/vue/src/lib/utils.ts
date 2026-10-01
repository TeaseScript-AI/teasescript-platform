import type { ClassValue } from "clsx";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const textInputTypes = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

// Text fields that own typing, including editing shortcuts and caret keys.
export function isTextEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && textInputTypes.has(target.type)) ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
