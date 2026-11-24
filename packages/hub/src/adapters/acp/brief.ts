import type { TaskBrief } from '../../domain/entities'

/**
 * 把 Task Brief 渲染成一段可下发的文本。
 *
 * M4 不接 Brain，brief 由固定脚本构造；这里保持结构稳定，M6 之后只换来源。
 */
export function renderTaskBrief(brief: TaskBrief): string {
  const section = (title: string, lines: readonly string[]): string =>
    lines.length === 0
      ? `## ${title}\n（无）`
      : `## ${title}\n${lines.map((line) => `- ${line}`).join('\n')}`

  return [
    '# HubAgent Task Brief',
    '## 目标',
    brief.objective,
    section('约束', brief.constraints),
    section('上下文引用', brief.contextRefs),
    section('既有约定', brief.existingConventions),
    section('验收标准', brief.acceptance),
    section('不在范围内', brief.outOfScope),
    section('已知坑', brief.knownPitfalls),
  ].join('\n\n')
}
