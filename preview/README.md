# Web Console previews

Standalone HTML previews for the Signal Console direction. Mock data only; no API calls.

## Chat v2 — theme / i18n / collapse

```bash
open preview/web-chat-v2.html
# light + Chinese:
open 'preview/web-chat-v2.html?theme=light&lang=zh'
# collapsed sidebars:
open 'preview/web-chat-v2.html?left=collapsed&right=collapsed'
# approval thread:
open 'preview/web-chat-v2.html#t2'
```

What this version adds:

- System / Light / Dark theme cycle (bottom-left moon/sun icon)
- English / 中文 toggle (language icon)
- Collapsible Threads and Context panes (buttons in conversation header)
- No decorative selection borders; selected thread uses background + weight
- Higher-contrast dark tokens; light tokens with `light-dark()`
- IME-safe Enter submit in the composer
- Inline icons for theme, language, collapse, copy

## Chat v1

```bash
open preview/web-chat.html
```

## Tasks / Agents / Approvals

```bash
open preview/web-console.html
open 'preview/web-console.html#agents'
open 'preview/web-console.html#approvals'
```

Production implementation plan: `docs/WEB-CONSOLE-PLAN.md`.

## Chat v2 visual refinements (same file)

- Composer has no decorative border; uses surface background.
- Primary actions are icon-only: Run/Ask mode, Send, New, Open task, Copy, Collapse.
- Threads and Context each have a collapse control in their header; the conversation header keeps both toggles.
- Collapsed Context exposes a clickable vertical rail.
