export interface StreamingTextProps {
  /** Text received so far. The component renders exactly this, never a fake animation. */
  text: string
  /** Shows the caret while the stream is open. */
  streaming?: boolean
}

/** Ported from Beautiful UI's Streaming Text (MIT), reduced to text + caret. */
export function StreamingText(props: StreamingTextProps) {
  return (
    <p class="max-w-[72ch] whitespace-pre-wrap text-body leading-relaxed text-ink">
      {props.text}
      {props.streaming === true ? (
        <span
          class="hx-caret ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] bg-accent align-baseline"
          aria-hidden="true"
        />
      ) : null}
    </p>
  )
}
