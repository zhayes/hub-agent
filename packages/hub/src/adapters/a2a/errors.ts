import { TaskNotFoundError } from '@a2a-js/sdk/errors'

/**
 * 判断一次 A2A 调用失败是不是“远端已没有该任务”（PRD §7.6.3）。
 *
 * SDK 用 `Symbol.hasInstance` 做品牌匹配，所以跨 entry-point 的 `instanceof`
 * 仍成立；这里集中封装，避免 Runtime 直接依赖 SDK 的错误类型细节。
 */
export function isTaskNotFound(error: unknown): boolean {
  return error instanceof TaskNotFoundError
}
