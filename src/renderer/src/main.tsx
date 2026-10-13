import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { installWebBridge } from './lib/web-bridge'

// served by the home server in a browser: no Electron preload, talk to the server API instead
installWebBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
