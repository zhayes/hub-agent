import { render } from '@solidjs/web'
import App from './App'
import './styles.css'

const root = document.getElementById('app')
if (root !== null) render(() => <App />, root)
