import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/v3.css'
import { V3Runtime } from './runtime/v3Runtime'

const root = createRoot(document.getElementById('root')!);
const runtime = new V3Runtime();
runtime.start();
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    runtime.dispose();
    root.unmount();
  });
}
