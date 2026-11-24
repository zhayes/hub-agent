import { useApp } from '../app/store'
import { SettingsView } from '../features/settings/SettingsView'

export function SettingsRoute() {
  const app = useApp()
  return (
    <SettingsView
      theme={app.theme}
      locale={app.locale()}
      t={app.t}
      onLocale={app.setLocale}
      token={app.token()}
      onSaveToken={app.saveConnectionToken}
    />
  )
}
