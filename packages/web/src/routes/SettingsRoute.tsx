import { useNavigate, useParams } from '@solidjs/router'
import { useApp } from '../app/store'
import { SettingsDialog, type SettingsSection } from '../features/settings/SettingsDialog'

/**
 * `/settings` 与 `/settings/:section`：设置是一条可深链的**浮层**，不是页面。
 *
 * 关掉它回到对话，而不是落到一张空页上；URL 仍然是唯一事实，刷新能回到同一节。
 */
export function SettingsRoute() {
  const app = useApp()
  const params = useParams()
  const navigate = useNavigate()

  const section = (): SettingsSection => {
    const value = params.section
    return value === 'model' || value === 'agents' ? value : 'general'
  }

  return (
    <SettingsDialog
      section={section()}
      onSection={(next) =>
        navigate(next === 'general' ? '/settings' : `/settings/${next}`, { replace: true })
      }
      onClose={() => navigate('/chat')}
      theme={app.theme}
      locale={app.locale()}
      t={app.t}
      onLocale={app.setLocale}
    />
  )
}
