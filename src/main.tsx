import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import {
  disposeSessionPersistence,
  startSessionPersistence,
} from './runtime/sessionPersistence'
import './styles/v3.css'

startSessionPersistence()

const root = createRoot(document.getElementById('root')!)
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeSessionPersistence()
    root.unmount()
  })
}
