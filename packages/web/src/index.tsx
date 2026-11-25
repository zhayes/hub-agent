import { render } from '@solidjs/web'
import App from './App'
import './styles/layers.css'
import './styles/fonts.css'
import './styles.css'
import './styles/tailwind.css'
import './styles/motion.css'

const root = document.getElementById('app')
if (root !== null) render(() => <App />, root)
