/* Shared button recipes for the plugin surfaces that still use legacy markup.
   New code uses <Button> from components/ui/Button; P3 replaces the rest. */

export const buttonPrimary =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-control bg-ink px-3 text-[13px] font-medium text-canvas transition-colors hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-45'

export const buttonSecondary =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-control border border-control bg-surface px-3 text-[13px] text-ink transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-45'

export const buttonGhost =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-control px-3 text-[13px] text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-45'

export const buttonDanger =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-control bg-danger px-3 text-[13px] font-medium text-canvas transition-colors hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-45'
