import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import { createPosterCopyHandler } from './server/posterServer.ts'

/**
 * 開発サーバー専用：src/lib のファイルを変更したら、ページ全体を再読み込みする。
 * 画面（PenTracker）は useRef で FireController・PersonController などのインスタンスを持っているので、
 * 部分的な更新（HMR）では変更前のクラスのインスタンスが残り、新しい画面のコードと形が合わずにエラーになるため
 * （例：FireFrame に追加した handViews が古いインスタンスの結果に無い）。ビルド・iOS アプリには影響しない。
 */
function fullReloadOnLibChange(): Plugin {
  return {
    name: 'full-reload-on-lib-change',
    apply: 'serve',
    handleHotUpdate({ file, server }) {
      if (!file.includes('/src/lib/')) return
      server.ws.send({ type: 'full-reload' })
      return []
    },
  }
}

/**
 * STEP 14：開発サーバー・プレビューで、ポスターのコピー生成 API（/api/poster-copy）を同じオリジンに置く。
 * GEMINI_API_KEY は .env.local から読み、サーバーの中だけで使う（VITE_ で始めないので、ブラウザのコードには入らない）。
 */
function posterCopyApi(env: Record<string, string>): Plugin {
  const handler = createPosterCopyHandler({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL })
  return {
    name: 'poster-copy-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => void handler(req, res, next))
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => void handler(req, res, next))
    },
  }
}

/**
 * STEP 15：@fontsource の CSS から、古い形式の woff の指定を除く（woff2 だけを同梱する）。
 * iPhone の WKWebView・現在のブラウザは woff2 に対応しているので、woff は使われないのにアプリの大きさだけが増えるため。
 */
function fontsourceWoff2Only(): Plugin {
  return {
    name: 'fontsource-woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('/@fontsource/') || !id.endsWith('.css')) return
      return code.replace(/,\s*url\([^)]*\.woff\)\s*format\(['"]woff['"]\)/g, '')
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [fontsourceWoff2Only(), react(), fullReloadOnLibChange(), posterCopyApi(env)],
  }
})
