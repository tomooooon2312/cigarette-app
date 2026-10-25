import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/potta-one/400.css'
import '@fontsource/shippori-mincho/400.css'
import '@fontsource/shippori-mincho/700.css'
import '@fontsource/yuji-syuku/400.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
