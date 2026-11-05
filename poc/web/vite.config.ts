import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' → dist 를 아무 정적 서버로 띄워도 된다 (poc/run.sh 는 python http.server)
export default defineConfig({ base: './', plugins: [react()] })
