import { Router } from './app/router'
import { AppProvider } from './app/store'

export default function App() {
  return (
    <AppProvider>
      <Router />
    </AppProvider>
  )
}
