import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { runChecks } from './checks'
import './styles.css'

// 자동 검사는 렌더와 무관하게 한 번만 (StrictMode의 effect 2회 실행과 섞이지 않게)
const checks = runChecks()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App checks={checks} />
  </StrictMode>,
)
