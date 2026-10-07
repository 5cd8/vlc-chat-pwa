# vlc-chat-pwa

iPhone のホーム画面に置ける、チャットリプレイ付きの動画プレーヤー（PWA）。動画とチャットリプレイJSON（YouTube / Twitch）を端末内から選び、再生位置に合わせてチャットを表示する。初回に1回だけ通信し、以後は完全オフラインで動く。

- 要件：[Issue #1](https://github.com/5cd8/vlc-chat-pwa/issues/1)
- 実装計画：`design-docs-for-ai/`
- PC版（WPF）：vlc-chat
- 実機での検証（Phase 0）：[vlc-chat-pwa-spike](https://github.com/5cd8/vlc-chat-pwa-spike)

## 使い方

1. 配信URL（GitHub Pages）を iPhone の Safari で開き、「共有」→「ホーム画面に追加」する。
2. **オンラインのうちに、ホーム画面のアイコンから一度起動する**（アプリ本体のキャッシュを作る。ホーム画面のWebアプリは Safari とストレージが別）。
3. 以後は機内モードでも、アイコンから起動できる。
4. 「ファイルを選択」で、動画（`.mp4 .mov .webm .mkv`）・チャット（`.json`）・絵文字（`.sqlite`、省略可）をまとめて選び、再生ボタンを押す。

動画とチャットが無いと再生を始めない。ファイルを選び直すと、選んだ組で最初から作り直す。

## 開発

```bash
npm ci
npm run dev      # 開発サーバー（http://localhost:5173/vlc-chat-pwa/）
npm test         # Vitest
npm run build    # tsc（メイン・Worker）＋ vite build（0警告0エラー）
```

使っている版は `package-lock.json` で固定している（TypeScript 7.0.2、Vite 8.3.3、Vitest 5.0.3、vite-plugin-pwa 2.0.0、mediabunny 1.61.3）。mediabunny は更新が活発で API が変わり得るので、上げたら MKV の実機確認（計画 S2）をやり直す。

## メモリの設計（要約）

数GB・数時間の動画、数百MBのチャットJSON・sqlite でも、JSヒープにファイル全体を載せない。上限は `src/limits.ts` に単位つきで集めてある。

- **MP4/MOV/WebM**：`<video>` に `File` のオブジェクトURLをそのまま渡す。JSはバイトに触れない。
- **MKV**：Mediabunny でパケットを1件ずつ読み、再エンコードせずフラグメントMP4にして `ManagedMediaSource` に供給する。常駐は総量予算 80MiB（iPhone の SourceBuffer は約100MiB）、先読み30秒、後方15秒。1回の `appendBuffer` は約4MiB以下に分ける。`Output` は5分ごとに作り直す。キーフレーム間隔の長いMKV（最大フラグメント 40MiB 超）は再生を断り、PCで `ffmpeg -c copy` により MP4 へ変換するよう案内する。
- **チャット**：Web Worker で `file.slice` を1MiBずつ読んで逐次解析し、圧縮配列で保持する（22万件で約15MB）。表示中の最大200件だけをデコードする。
- **絵文字**：独自の読み取り専用 sqlite リーダーで、必要な B ツリーのページだけを読む（ページキャッシュ 8MiB）。画像はオブジェクトURLの LRU（1000件かつ 32MiB）。
- `blob.stream()` は使わない（WebKit の不具合を避けるため）。

## ライセンス

本アプリのコードとは別に、依存する [Mediabunny](https://github.com/Vanilagy/mediabunny) は MPL-2.0 で配布されている。ビルド成果物に Mediabunny のコードを含む。
