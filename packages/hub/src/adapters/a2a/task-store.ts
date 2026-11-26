import { Task, TaskState } from '@a2a-js/sdk'
import { resolveUserScope, type ServerCallContext, type TaskStore } from '@a2a-js/sdk/server'
import type { Db } from '../../storage/db'

interface TaskRow {
  task_json: string
}

/**
 * A2A `TaskStore` 的 SQLite 实现。
 *
 * 三件事必须守住：
 * 1. **owner 隔离**：读写都按 `resolveUserScope(context)` 收窄，跨 peer 读不到对方的任务。
 * 2. **覆盖语义**：SDK 约定按 taskId 覆盖，这里用 `ON CONFLICT DO UPDATE`。
 * 3. **只存投影**：这张表是对外视图；本地真相仍是 events/projections，不在这里改状态机。
 */
export function createSqliteTaskStore(db: Db): TaskStore {
  return {
    async save(task: Task, context: ServerCallContext): Promise<void> {
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO a2a_tasks (id, context_id, state, task_json, owner, created_at, updated_at)
         VALUES (@id, @contextId, @state, @taskJson, @owner, @now, @now)
         ON CONFLICT(id) DO UPDATE SET
           context_id = excluded.context_id,
           state      = excluded.state,
           task_json  = excluded.task_json,
           updated_at = excluded.updated_at`,
      ).run({
        id: task.id,
        contextId: task.contextId ?? null,
        state: TaskState[task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED] ?? 'UNSPECIFIED',
        taskJson: JSON.stringify(Task.toJSON(task)),
        owner: resolveUserScope(context),
        now,
      })
    },

    async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
      const row = db
        .prepare('SELECT task_json FROM a2a_tasks WHERE id = ? AND owner = ?')
        .get(taskId, resolveUserScope(context)) as TaskRow | undefined
      return row === undefined ? undefined : Task.fromJSON(JSON.parse(row.task_json))
    },

    async list(params, context) {
      const owner = resolveUserScope(context)
      const pageSize = Math.min(Math.max(params.pageSize ?? 50, 1), 100)
      const offset =
        params.pageToken === undefined || params.pageToken === '' ? 0 : Number(params.pageToken)
      const start = Number.isFinite(offset) && offset >= 0 ? Math.floor(offset) : 0

      const filters: string[] = ['owner = @owner']
      const values: Record<string, unknown> = { owner }
      if (params.contextId !== undefined && params.contextId !== '') {
        filters.push('context_id = @contextId')
        values['contextId'] = params.contextId
      }
      if (params.status !== undefined && params.status !== TaskState.TASK_STATE_UNSPECIFIED) {
        filters.push('state = @state')
        values['state'] = TaskState[params.status]
      }
      const where = filters.join(' AND ')

      const total = (
        db.prepare(`SELECT COUNT(*) AS n FROM a2a_tasks WHERE ${where}`).get(values) as {
          n: number
        }
      ).n
      const rows = db
        .prepare(
          `SELECT task_json FROM a2a_tasks WHERE ${where}
           ORDER BY updated_at DESC, id ASC LIMIT @limit OFFSET @offset`,
        )
        .all({ ...values, limit: pageSize, offset: start }) as TaskRow[]

      const next = start + rows.length
      return {
        tasks: rows.map((row) => Task.fromJSON(JSON.parse(row.task_json))),
        nextPageToken: next < total ? String(next) : '',
        pageSize,
        totalSize: total,
      }
    },
  }
}
