import { createSignal } from 'solid-js'

/**
 * 「创建一个新工作区」的交接单。
 *
 * 按钮在侧栏，草稿状态在对话页：两边不在同一棵子树里，而且点下去会从
 * `/chat/:id` 走到 `/chat`——对话页会被重建一次。所以这里存的不是“一次性请求”，
 * 而是**草稿会话本身的状态**：新实例挂载时直接读它，路径不会在中途丢掉。
 *
 * 它只传目录，不建会话：真正建线程发生在第一条消息发送时（`send`）。
 * `active` 另管一件事：草稿期间不要让 `/chat` 的“回到上次对话”把人顶回去。
 */
const [workspace, setWorkspace] = createSignal<string>()
const [active, setActive] = createSignal(false)

export const draft = {
  workspace,
  active,
  begin: (path: string): void => {
    setWorkspace(path)
    setActive(true)
  },
  /** 第一条消息建好线程（或选中了别的会话）之后，草稿态结束。 */
  end: (): void => {
    setWorkspace(undefined)
    setActive(false)
  },
}
