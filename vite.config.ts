import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig, type Plugin } from 'vitest/config';

// connect-src を自オリジンに限り、チャット内の外部画像URLを取りに行かない＝オフライン要件を機械的に守る。
// 開発サーバー（HMR のインラインスクリプト・WebSocket）を壊さないよう、ビルド時だけ入れる。
const CSP =
  "default-src 'self'; img-src 'self' blob: data:; media-src blob:; connect-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'";

function cspMeta(): Plugin {
  return {
    name: 'csp-meta',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
    ],
  };
}

export default defineConfig({
  base: '/vlc-chat-pwa/',
  build: { target: 'es2022' },
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
  plugins: [
    cspMeta(),
    VitePWA({
      // 再生中のリロードを避けるため 'prompt'（'autoUpdate' は自動でリロードする）。更新を促すコードも入れない。
      // 新しい Service Worker は、全クライアントが閉じた後の次回起動で有効になる。
      registerType: 'prompt',
      injectRegister: 'script', // 登録コードをインラインにしない（CSPの script-src 'self' と矛盾しない）
      manifestFilename: 'manifest.json',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'チャットリプレイプレーヤー',
        short_name: 'チャットリプレイ',
        lang: 'ja',
        display: 'standalone',
        start_url: '/vlc-chat-pwa/',
        scope: '/vlc-chat-pwa/',
        background_color: '#0e0e10',
        theme_color: '#0e0e10',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      // アプリ本体（HTML・JS・CSS・アイコン）だけをプリキャッシュ。動画・JSON・sqlite は取り扱わない。
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,json}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
