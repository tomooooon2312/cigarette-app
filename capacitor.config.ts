import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor（iOS アプリ化）の設定。Web 版のビルド結果（dist/）をそのままアプリに同梱する。
 * appId（Bundle Identifier）は署名に使う Apple の開発チームで一意である必要がある。変える場合は Xcode でも同じ値にする。
 */
const config: CapacitorConfig = {
  appId: 'io.github.towadachibatech.shibugarette',
  appName: 'シブガレット',
  webDir: 'dist',
  ios: {
    // WebView を画面全体に広げ、ノッチ・ホームインジケーターの余白は CSS（env(safe-area-inset-*)）で取る
    contentInset: 'never',
    backgroundColor: '#000000',
  },
}

export default config
