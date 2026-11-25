/* Shared button recipes for the P0 gallery. P2 replaces these with a typed
   Button primitive; keeping them in one place avoids five copies of the string. */

export const buttonPrimary =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-control bg-ink px-3 text-[13px] font-medium text-canvas transition-colors hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-45'

export const buttonSecondary =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-control border border-control bg-surface px-3 text-[13px] text-ink transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-45'

export const buttonGhost =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-control px-3 text-[13px] text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-45'

export const buttonDanger =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-control bg-danger px-3 text-[13px] font-medium text-canvas transition-colors hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-45'

export const fieldInput =
  'h-9 w-full rounded-control border border-control bg-surface px-3 text-body text-ink placeholder:text-ink-3 focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-ring'
