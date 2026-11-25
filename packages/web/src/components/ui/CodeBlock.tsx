import type { JSX } from '@solidjs/web'
import { Show } from 'solid-js'
import { Icon } from './Icon'
import { StreamingText } from './StreamingText'

export interface CodeBlockProps {
  code: string
  language?: string
  /** Accessible name for the copy action; pass a translated string. */
  copyLabel: string
  class?: string
}

/** Fenced code from an assistant reply: mono block, language label, copy action. */
export function CodeBlock(props: CodeBlockProps) {
  const copy = (): void => {
    void navigator.clipboard?.writeText(props.code)
  }

  return (
    <div
      class={`overflow-hidden rounded-control border border-line bg-canvas${props.class === undefined ? '' : ` ${props.class}`}`}
    >
      <div class="flex items-center justify-between gap-3 border-b border-line px-3 py-1.5">
        <span class="font-mono text-badge text-ink-3">{props.language ?? 'text'}</span>
        <Show when={navigator.clipboard !== undefined}>
          <button
            type="button"
            class="inline-flex h-6 items-center gap-1 rounded-control px-1.5 text-badge text-ink-3 transition-colors hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            aria-label={props.copyLabel}
            title={props.copyLabel}
            onClick={copy}
          >
            <Icon name="copy" size={12} />
            <span>{props.copyLabel}</span>
          </button>
        </Show>
      </div>
      <pre class="overflow-x-auto px-3 py-2.5 font-mono text-meta leading-relaxed whitespace-pre text-ink">
        <code>{props.code}</code>
      </pre>
    </div>
  )
}

interface Segment {
  kind: 'text' | 'code'
  body: string
  language?: string
}

/** Split assistant text into prose and ``` fenced blocks. Unclosed fences stay prose. */
export function splitCodeFences(text: string): Segment[] {
  const segments: Segment[] = []
  const lines = text.split('\n')
  let buffer: string[] = []
  let fence: { language: string; body: string[] } | undefined

  const flushText = (): void => {
    if (buffer.length === 0) return
    const body = buffer.join('\n')
    if (body.trim() !== '') segments.push({ kind: 'text', body })
    buffer = []
  }

  for (const line of lines) {
    const open = /^```(\w*)\s*$/.exec(line)
    if (fence === undefined) {
      if (open !== null) {
        flushText()
        fence = { language: open[1] ?? '', body: [] }
      } else {
        buffer.push(line)
      }
      continue
    }
    if (line.trim() === '```') {
      segments.push({ kind: 'code', body: fence.body.join('\n'), language: fence.language })
      fence = undefined
      continue
    }
    fence.body.push(line)
  }

  if (fence === undefined) {
    flushText()
  } else {
    /* Unclosed fence: render it as prose rather than swallowing the tail. */
    segments.push({ kind: 'text', body: ['```' + fence.language, ...fence.body].join('\n') })
  }
  return segments
}

export interface RichTextProps {
  text: string
  copyLabel: string
  streaming?: boolean
  /** Assistant plan/result paragraphs sit one step quieter than user text. */
  quiet?: boolean
  caret?: JSX.Element
}

/** Prose with fenced code lifted into CodeBlocks; the caret rides the last line. */
export function RichText(props: RichTextProps) {
  const segments = (): Segment[] => splitCodeFences(props.text)
  const lastTextIndex = (): number => {
    const list = segments()
    for (let index = list.length - 1; index >= 0; index -= 1) {
      if (list[index]?.kind === 'text') return index
    }
    return -1
  }

  return (
    <div class="flex flex-col gap-2">
      {segments().map((segment, index) => (
        <Show
          when={segment.kind === 'code'}
          fallback={
            <StreamingText
              text={segment.body}
              streaming={props.streaming === true && index === lastTextIndex()}
              quiet={props.quiet === true}
            />
          }
        >
          <CodeBlock
            code={segment.body}
            copyLabel={props.copyLabel}
            {...(segment.language === undefined || segment.language === ''
              ? {}
              : { language: segment.language })}
          />
        </Show>
      ))}
    </div>
  )
}
