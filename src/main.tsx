import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import {
  disposeSessionPersistence,
  startSessionPersistence,
} from './runtime/sessionPersistence'
import './styles/v3.css'
import { V3Runtime } from './runtime/v3Runtime'

startSessionPersistence()

const root = createRoot(document.getElementById('root')!)
const runtime = new V3Runtime();
runtime.start();
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposeSessionPersistence()
    runtime.dispose()
    root.unmount()
  })
}
