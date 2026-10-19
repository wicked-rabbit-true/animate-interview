import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge conditional class names and resolve conflicting Tailwind utilities. */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
