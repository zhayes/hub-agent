import { useNavigate } from '@solidjs/router'
import { createEffect } from 'solid-js'

/**
 * `/registry` 是 Agent 接入的旧地址（ADR 0029 §2.2 的分段）。
 *
 * 接入现在住在设置里，所以这里只做一次 replace 跳转：书签不失效，
 * 也不再维护第二个入口。
 */
export function RegistryRoute() {
  const navigate = useNavigate()
  createEffect(
    () => null,
    () => navigate('/settings/agents', { replace: true }),
  )
  return null
}
