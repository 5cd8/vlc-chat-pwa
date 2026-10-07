# Issue #1: iPhone向け チャットリプレイ付き動画プレーヤー（PWA） 実装計画

対象Issue: https://github.com/5cd8/vlc-chat-pwa/issues/1（アシスタントが起票したIssue。要件の正式な情報源はIssue本文であり、本計画は要約・言い換えをしない）
スコープ: Issue全体（PRは分割しない）
依頼プロンプト: `user-prompt/202610061600_issue1.md`

本書は、本セッションの文脈を持たない別のAIがそのまま実装に使うことを想定している。

## 0. 前提・読み替え

- リポジトリ `C:\Users\owner\source\repos\vlc-chat-pwa`（**実装は、計画・Issueのコミットが既にある `feature/issue-1-pwa-chat-replay-player` ブランチで続ける。`origin/main` から切り直さない**）。PC版 `C:\Users\owner\source\repos\vlc-chat`（C#/WPF）の挙動を、チャットの解釈・同期・絵文字の契約の一次情報として使う。コードは移植（TypeScriptで書き直し）であり、共有はしない。
- **読み替え（00 項目30）**：本アプリはデスクトップ向け手順の「ブラウザ確認」ではなく、**iPhone実機（iPhone 16。実測時のSafariは 26.6.1）のSafariとホーム画面PWA**で確認する。実行ファイルのフォルダを開く手順（00 項目32）は、PWAには該当しないので「配信URLを開く」に読み替える。
- 開発機はWindows（Mac無し）。**SafariのWeb Inspectorは使えない**。実機のメモリ使用量は直接計測できないため、(a) アプリ内の計数（バッファ量・保持バイト数）、(b) 長時間再生でタブが再読み込みされないこと、で確かめる（4.3節・8節）。
- Node v24.20.0／npm 11.19.0 が導入済み。テストにはNode組み込みの `node:sqlite` が使える。
- 確認済みの一次情報（調査日 2026-10-06）と、**未確認でスパイク（Phase 0）で確かめる事項**を区別して書く。未確認の事項を既定の前提にしない。

## 1. スコープ・非ゴール

Issueの機能要件1〜7をすべて実装する。非ゴールはIssue記載の通り（スーパーチャット表示、全画面再生対応、投稿者の色付け、BTTV/FFZ/7TV、プレイリスト、選択ファイルの記憶、emoji sqlite作成ツール、本文中のURLのリンク化）。リンク化は、PC版にある機能をPWAでは省くとユーザーが決定した（2026-10-06、Issue #1の本文に追記済み）。

**計画で決めた、Issueに無い挙動（ユーザーとの確認の状況つき。確認済みのものは、Issue #1の本文に「実装前に確定した挙動」として追記済み）**：(a) **チャットの解析を待たずに再生を始める**（**確認済み**）。チャット欄は解析中「チャットを読み込み中（N件）」と表示し、完了したら再生位置に合わせて表示する（4.2節・5.5節。165MB・22万件の合成データで、解析は約2.7秒＝Node・Windowsの実測。iPhoneは未計測）、(b) **キーフレーム間隔（GOP）の長いMKVは、4.4節の三段階（F ≦ 24MiB は通常、24〜40MiB は警告、40MiB 超は再生を断って事前変換を案内）で扱う**（**仮決定**。ユーザーの決定、2026-10-07。実機の結果で見直す）、(c) 複数の動画・チャット・絵文字ファイルが選ばれたら最初の1つを採用し、余りは画面に通知する（**確認済み**。5.3節）、(d) 画面の向きに応じたレイアウトの切り替えはしない＝縦並びのみ（**確認済み**。5.5節）、(e) 選択ボタンは「ファイルを選択」1つ（実機で複数選択できた。U1。**確認済み**）。動画の選択元の案内文は付けない（写真ライブラリ経由は使わない：ユーザーの決定。3.1節）、(f) **ファイルを選び直したら、選ばれた組で最初から作り直す**（旧プレーヤー・解析・絵文字をすべて破棄する。4.3節）。選ばれた組に動画かチャットが無ければ再生を始めず、不足を表示する（**既定の解釈。ユーザーの確認待ち**）。

本計画で追加する非機能要件（ユーザー指示「長時間・大容量動画のメモリ」）：

| # | 要件 |
|---|---|
| M1 | 数GB・数時間の動画を、JSヒープにファイル全体や大きな塊を載せずに再生できる |
| M2 | 163MB・22万件級（さらに50万件級）のチャットJSONを、ファイル全体を文字列にせず解析できる |
| M3 | 数百MB級のsqliteを、ファイル全体を読み込まずに引ける（メモリ使用量がファイルサイズに比例しない） |
| M4 | 長時間再生しても、DOM・オブジェクトURL・バッファが際限なく増えない |

## 2. 確認済みの一次情報

| 事実 | 出典 |
|---|---|
| iPhoneのSafariで使えるMSEは `ManagedMediaSource`（iOS 17.1以降）のみ。`video.disableRemotePlayback = true` を設定しないとiPhone Safariで `sourceopen` が発火しない。`<source>` 要素ではなく `video.src = URL.createObjectURL(mediaSource)` を使う。`startstreaming`・`endstreaming`・`bufferedchange` イベントがあり、UAがバッファを自動で追い出す | https://developer.mozilla.org/en-US/docs/Web/API/ManagedMediaSource |
| SafariはMKV（Matroska）をネイティブ再生できない。WebMはiOS 15以降で再生でき、Opus音声は17.4で安定した（**二次情報**。VP9/AV1のWebMをiOSの `<video>` で再生できるかは3節U9で確認する） | https://www.testmuai.com/learning-hub/webm-browser-support/ ほか |
| WebCodecsはSafari 26以降（iOS含む）で映像・音声とも利用可能 | https://webkit.org/blog/17333/webkit-features-in-safari-26-0/ |
| iPhone 16はAV1をハードウェア復号できる（iPhone 15 Pro以降。**二次情報**で、実機のAV1再生はU3・S2で確認する） | https://www.videoconverterfactory.com/multimedia-solution/apple-av1.html |
| Mediabunny（npm: `mediabunny`）は `.mkv .webm .mp4 .mov` 等の読み書きに対応。`BlobSource(file, { maxCacheSize })`（既定8MiB）で必要なバイトだけ遅延読み込みする。`EncodedPacketSink` で符号化済みパケットを列挙でき、`getKeyPacket(timestamp)` でシーク用のキーフレームを得られる。`track.getCodecParameterString()` でMSE用コーデック文字列相当を得られる。`Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration })` と `StreamTarget(writable, { chunked, chunkSize })` でフラグメントMP4をストリーム出力できる。`EncodedVideoPacketSource` で再エンコードなしにパケットを書き込める。`input.dispose()` で解放。`computeDuration()` はファイル全体を走査するため避け、`getDurationFromMetadata()` を使う | https://mediabunny.dev/guide/reading-media-files 、https://mediabunny.dev/guide/writing-media-files |
| iOS Safariには、大きなBlob（メモリ上のBlob）を `URL.createObjectURL` で `<video>` に渡すとクラッシュする既知の問題の報告がある（iOS 14.8・100MB級、iOS 16のblob URL動画の不具合報告）。いずれも古い版の報告で、`File` 参照のblob URLに当たるかは不明 | https://github.com/GoogleChrome/workbox/issues/3004 、https://developer.apple.com/forums/thread/721049 |
| 手元の `emoji_cache.sqlite`（PC版）は12,230,656バイト・275行・最大BLOB 6,291,456バイト（テスト用の巨大データを含む）。スキーマ `emoji_cache(url TEXT PRIMARY KEY, data BLOB NOT NULL)`、PC版は5MiB超のBLOBを無視する | `vlc-chat/Services/EmojiCacheService.cs`（MaxBlobSizeBytes = 5MiB）、実ファイルをPythonで集計 |

## 3. 未確認事項（Phase 0のスパイクで必ず確かめる。計画の前提にしない）

| ID | 未確認事項 | 確かめ方 | 外れたとき |
|---|---|---|---|
| U1 | iOSのファイル選択（`<input type=file multiple>`、`accept` 無し）が、`.mkv`・`.sqlite` を選べるか。複数選択できるか。ホーム画面PWAの単独表示モードでも動くか。**「ファイル」アプリから選んだ場合と、写真ライブラリから選んだ場合で、元のファイルのまま渡るか**（`file.size`・`file.type`・拡張子を比べる。写真ライブラリ経由は互換形式への変換・圧縮がかかる可能性があり、`.json`・`.sqlite` と同時にも選べない見込み。画面の案内に「動画は『ファイル』アプリから選ぶ」と書くかをここで決める） | S1 | **【解決済み：複数選択できた（3.1節）。以下は外れた場合の案で、実装しない】** **複数選択できなければ、「動画を選ぶ」「チャットを選ぶ」「絵文字を選ぶ（任意）」の3つのボタンに分ける**（Issueの要件2を更新する。5.5節）。`accept` は3つのボタンごとに別々に指定できる。動画のボタンの `accept`（なし／`video/*`／拡張子の列挙）で `.mkv` が選べるか、シートの出方（「写真ライブラリ」「ファイルを選択」）がどう変わるかもS1で比べる |
| U2 | 数GBのMP4/WebMを `URL.createObjectURL(file)` で `<video>` に渡して、1時間以上の連続再生・シークでタブが落ちないか。ファイル選択時のtmpコピーに要する時間 | S1 | 動画のサイズ上限を設けるか、`MediaSource` 経由（5.3節と同じ方式）で供給する |
| U3 | `ManagedMediaSource.isTypeSupported()` が、`video/mp4; codecs="vp09…, opus"`、`"av01…, opus"`、`"avc1…, mp4a.40.2"`、および `video/webm; codecs="vp9, opus"` で真になるか。MKV由来のVP9/AV1について、`getCodecParameterString()` の文字列で真になるか（偽なら `output.getMimeType()` の値も試す） | S2 | 真にならない組合せのうち `video/webm` が真なら、**WebMへの再パッケージ**（`WebMOutputFormat({ appendOnly: true })`。`onMoof` の代わりは `onCluster(data, position, timestamp)`。`mfra` に依存する手順は読み替える）を試す。それも偽なら、そのコーデックのMKVは非対応（D案に切替を相談） |
| U4 | Mediabunnyの `Output`（`fastStart: 'fragmented'`、`minimumFragmentDuration: 2`（秒））が、映像と音声を交互に書いたとき、**キーフレームごとにフラグメントを確定して `StreamTarget` へ書き出し、メモリが「max(2秒, GOP長)分」に収まるか**。背圧は二重に保証する：`AppendOnlyStreamTarget`（内部で `StreamTarget` を使う）は `desiredSize <= 0` のとき `writer.ready` を待つ（mediabunny 1.61.3 の `target.js` で確認済み）ので、`write` を `updateend` まで resolve しなければ `add()` まで伝わる。加えてポンプ側でも待つ（5.3節 手順4） | S2 | `onMoof` で時刻だけ受け取り、`BufferTarget` で受ける（`onMdat` は使わない。mdat全体を追加でコピーするため） |
| U5 | 任意の位置へのシーク（キーフレームからの再供給）で、A/Vがずれずに再開できるか。**`timestampOffset` は設定しない**（mediabunny 1.61.3 の fragmented 出力は元のタイムスタンプを保ち、先頭が負のときだけずらす：`isobmff-muxer.js` の `startTimestampOffset ??= Math.min(先頭, 0)`）。先頭パケットの時刻が負になる実ファイル（OpusのCodecDelay等）で、音声と映像の位置がずれないか。先頭が負のトラックがあると `moov` に `elst` も書かれ、シーク後の `Output` には `elst` が無いので、初期化セグメントが世代ごとに変わる。それでも再生位置がずれないか | S2 | 負の開始時刻のパケット（音声だけが負で始まると、mediabunnyはトラックごとにずらす）の扱いを、S2の結果で調整する（時刻が負のパケットは書かない、を既定にしてある：5.3節 手順2） |
| U6 | MKVのメタデータに再生時間がない場合があるか（yt-dlp・OBS由来の実ファイルで確認） | S2（実ファイルを `ffprobe` で確認） | `computeDuration()`（全体走査）に切り替える |
| U7 | `video.playbackRate` を2.0まで上げたとき、MSE経由でも音程が保たれ、A/Vが同期するか | S2 | 速度の上限を下げる |
| U8 | Service WorkerだけでiOSのホーム画面PWAが機内モードで起動するか | S5 | キャッシュ戦略を調整 |
| U9 | **WebM（VP9+Opus、AV1+Opus）が、iOSの `<video>` でネイティブ再生できるか**（Issueの受け入れ条件に関わる。MP4/MOVも同様に実ファイルで確認） | S1 | 再生できないWebMは、MKVと同じMSE経路（5.3節。MediabunnyはWebMも読める）へ回す |
| U10 | **`Output` のローテーション**（5.3節 手順2）の継ぎ目で、新しい初期化セグメント（`ftyp`＋`moov`）をMSEが受け付け、映像・音声が途切れずに続くか。**`mfra` を含む追加でエラーにならないこと**（WebKitが実際に無視するか）、3時間再生してもヒープ（診断表示の計数）が平らか | S2 | ローテーションの間隔を変える／継ぎ目の前後を重ねて書く |
| U11 | **iOSのSourceBufferの容量**（1回の `appendBuffer` の最大サイズ、合計の上限、`QuotaExceededError` が出る閾値）。4.4節の閾値（F ＞ 40MiB で再生を断る）の根拠にする | S2（4.4節のテスト動画を使う） | 閾値を下げる |

**U11の結果（実機）**：**1回の `appendBuffer` の上限は約4MiB**（8MiB・16MiB・分割なしは、空のバッファでも `QuotaExceededError`。4MiBは通る。5.0MB＝約4.77MiBのフラグメントの1回追加は通ったので、上限は約4.77〜8MiBの間）。合計の上限ではない（4MiBずつなら、20Mbpsで40秒ぶん＝約100MBが保持できた）。**対処：チャンクを4MiB以下に分けて追加する**（5.3節 手順2）。**SourceBufferの総容量は約100MiB**（b20_g60 で、`buffered=[0.0-41.7]`＝約100MiB の時点で4MiBの追加が `QuotaExceededError`）。容量を超えると、iPhoneは再生中のGOPごと追い出して止まる（b20_g30：GOP 30秒＝73MBの次のフラグメントを入れた時点で `bufferedchange -`、再生位置20.4秒で停止）。

### 3.1 Phase 0 の結果（iPhone 16・Safari 26.6.1、2026-10-07。スパイクは別リポジトリ vlc-chat-pwa-spike）

| ID | 結果 | 設計への反映 |
|---|---|---|
| U1 | **複数選択できる**（5本）。`accept` 無しで `.mkv` が選べる。サイズ・先頭バイトは元のまま（「ファイル」アプリ経由）。確定まで3〜14秒（453MB・3GBを含む）。写真ライブラリ経由は未確認 | 1つの「ファイルを選択」ボタンのまま（3ボタンへの分割は不要）。D7（`accept` を付けない）を確定 |
| U3 | **MP4内のOpusは `Opus`（先頭大文字）なら `isTypeSupported` が真、小文字 `opus` は偽**。avc1・vp09・av01・mp4a は真。WebM（vp9/av01＋opus）も真 | MIMEを組み立てるとき `opus` を `Opus` に直す（5.3節 手順1）。WebMへの再パッケージは不要 |
| U11 | 上記（1回の追加は約4MiBが上限） | チャンクを4MiB以下に分けて追加する（5.3節 手順2） |
| 容量 | **SourceBufferの総容量は約100MiB**。Mediabunnyはフラグメントを丸ごとしか出力しないので、**今のGOP（再生中で追い出せない）と次のGOPの両方が収まる（2F ≦ 総量）必要がある**（Chromeでの検証で、F＝73MBに総量80MiBを課すと、常駐73MB＋次の71MBで詰まることを確認） | 総量予算を80MiB（`SOURCEBUFFER_BUDGET_BYTES`）とし、F ≦ 40MiB だけを再生する（4.4節）。流量制御を、常駐バイト数の正確な計数＋「次にフラッシュされる分の予約」にする（5.3節 手順4） |
| U10 | **`Output` のローテーションは成功。** b20_g10 で回転20秒にして、2回の継ぎ目（新しい初期化セグメントの再追加）で途切れず、60秒を最後まで再生できた（`waiting` なし）。後方削除も動いた | 変更なし（5.3節 手順2） |
| U9 | WebM（AV1+Opus、288MB・49分）が**ネイティブ再生できる**（2倍速、大きなシークも） | WebMは `<video>` にそのまま渡す（5.3節 ネイティブ） |
| U2 | 2.9GB・約2時間のMP4が**ネイティブ再生できる**（2倍速、4000秒付近へのシークも）。開始まで約16秒かかり `stalled` が出た（`moov` が末尾の可能性）。**1時間以上の連続再生は確認済み**（下の「U2（1時間）」の行）。`stalled` は「開始が遅い」ことの証拠にならない（下の行） | 開始までの待ちの間、「準備中」を表示する |
| U6 | 再生時間はメタデータから取れる（0ms）。GOPの調査は8〜152ms | `getDurationFromMetadata()` で足りる |
| U7 | MSE経由でも2.0倍速で再生できた（AV1+Opus、b8_g5） | 変更なし |
| 実ファイル | AV1+Opus のWebM（1280x720・0.8Mbps）は、MSEで再生でき、GOPは3.2〜7.0秒、F＝0.7MB（通常の範囲）。シークからの再開は約0.4〜0.5秒 | 4.4節の方針が問題になるのは、合成した極端なGOPだけの可能性が高い |
| MSE（合成MKV） | b8_g5（GOP 5秒）は、再生・倍速・大量のシーク・後方削除・`endOfStream` 後の再オープンまで動いた。b20_g60（フラグメント144MB）は、開始と約40秒の先読みバッファ内でのシークは動いたが、**バッファ外へのシークの連発で、世代切替のたびに144MBのフラグメントを作り直し、何も追加されないまま止まった** | **シークを合流させる**（最後の `seeking` から250ms 後に1回だけ切り替える。5.3節 手順7） |
| 長いGOPのMP4 | **ネイティブ再生できる。** b20_g30.mp4（290MB・GOP 30秒）、b20_g60.mp4（433MB・GOP 60秒）とも、開始約1〜2秒、大きなシーク・先頭へ戻るシークも問題なし | 4.4節の「再生を断って `ffmpeg -c copy` でのMP4変換を案内する」が成り立つ（GOPが長い素材の逃げ道がある） |
| 流量制御（v7） | b20_g10（F＝24.9MB）：総量80MiBで最後まで再生。Quota 0、UA全追い出し 0。b20_g30.mkv（F＝73MB・総量100MiB）：**常駐推定101MB で UAが全追い出し**し、再生が止まった（2F ≦ 総量の条件を満たせない素材は再生できない、という予測どおり）。**常駐推定の最大が b20_g10 で95.7MB（予算80MiB超）。フラグメントの大きさが次の `moof` まで分からず、`remove` で減らせない分があるため、過大に見積もっている可能性がある（実際の使用量は未確認）** | 40MiB 超を断る方針は実機の結果と合う。24〜40MiB の警告帯は未検証。常駐バイト数の計数は、実装で `onMoof` 由来の大きさで厳密にする（5.3節 手順4） |
| U2（1時間） | 2.9GB・2時間6分（7594秒）・1280x720のMP4を、**約3670秒（61分）、`pause`・`waiting`・`error` なしで連続再生できた**（ページの再読み込みなし）。そのあと6037秒へシークして約1秒で再開。**`stalled` は再生中ずっと約6秒ごとに出続けた**（ファイル全体が `Blob` URL で、読み込みが進まない時間があるため）。再生位置の推移とメモリ使用量は、ログに記録していないので未確認 | **`stalled` はエラー扱いにしない**（ログにも出さない）。再生の中断の判定は `waiting`・`error` だけで行う（5.3節 ネイティブ） |
| 未確認 | U4（背圧）の詳細、U5（シーク後の A/V）、F＝24〜40MiB（GOP 15秒前後・20Mbps）の動作、**VP9+Opus（WebM・MKV）とH.264+AAC（MKV）の実ファイルの再生**（`isTypeSupported` が真なだけで、再生は未確認。Issueの受け入れ条件）。写真ライブラリ経由は対象外 | **実装の⑤（MKV再生）の実機確認で、実装と並行して確かめる**（8節）。外れたら、ステップ2〜4に戻る |

## 4. メモリ設計（最重要）

### 4.1 原則

1. **ファイルを丸ごと読まない。** 常に `Blob.slice(..).arrayBuffer()` で必要な範囲だけ読み、読んだ塊はすぐ捨てる（**`blob.stream()` は使わない**。WebKitには、大きなファイルでの失敗・iOSでのメモリの蓄積と再読み込みのループ・背圧下での停止の不具合があり、Mediabunny自身も WebKit では `arrayBuffer()` に切り替えている：mediabunny 1.61.3 の `src/source.ts` のコメント、https://github.com/Vanilagy/mediabunny/issues/184）。
2. **JSに保持するのは、固定の上限があるものだけ。** 上限が入力サイズに比例するのはチャットの圧縮済み配列（4.2節）だけで、それも1件あたり数十バイトに抑える。（例外として、(1) Mediabunnyの `Output` は、確定したフラグメントのメタデータ（サンプルの配列）を `finalize` まで保持する（`mfra` を書くため。再生時間に比例する）ので、5.3節の「Outputのローテーション」で一定時間ごとに作り直して上限を保つ、(2) Mediabunnyのマトロスカ読み取りは**クラスタを丸ごと読み込み**（`maxCacheSize` と無関係）、そのブロックのパケットがクラスタのバッファを参照し続ける（未確定のフラグメントにあるサンプルと、次に書くパケットが属するクラスタは、全体がヒープに残る。4.2節に計上）、(3) Mediabunnyのマトロスカ読み取りは、読んだクラスタの位置のキャッシュとCues全体を保持する。小さいが動画の長さに比例する。実害は小さいと見て許容し、S2で長い動画のヒープを確かめる。）
3. 上限は定数としてコードの1箇所（`src/limits.ts`）に集め、**単位**（秒・バイト・件数）と根拠をコメントに書く（例：Mediabunnyの `minimumFragmentDuration` は**秒**。ミリ秒と取り違えると約33分ぶんのパケットをメモリに溜める）。**`limits.ts` に置く定数**：`APPEND_SLICE_BYTES`（4MiB）、`SOURCEBUFFER_BUDGET_BYTES`（80MiB）、`GOP_WARN_BYTES`（24MiB）、`GOP_REFUSE_BYTES`（40MiB）、`FORWARD_BUFFER_SECONDS`（30）、`MIN_FORWARD_SECONDS`（2）、`BACK_BUFFER_SECONDS`（15。圧迫時は1）、`GAP_TOLERANCE_SECONDS`（0.5）、`BUDGET_WAIT_TIMEOUT_MS`（20000）、`SEEK_DEBOUNCE_MS`（250）、`OUTPUT_ROTATION_SECONDS`（300）、`CHAT_MAX_ITEMS`（200）、`CHAT_CHUNK_BYTES`（4MiB）、`FILE_READ_SLICE_BYTES`（1MiB）、`DETECT_PEEK_BYTES`（4096）、`EMOJI_CACHE_MAX_ITEMS`（1000）、`EMOJI_CACHE_MAX_BYTES`（32MiB）、`SQLITE_PAGE_CACHE_BYTES`（8MiB）、`MKV_SOURCE_CACHE_BYTES`（4MiB）、`MIN_FRAGMENT_SECONDS`（2。`minimumFragmentDuration`）、`QUOTA_RETRY_MAX`（3）、`SQLITE_MAX_BLOB_BYTES`（5MiB）、`CHAT_INDEX_CHUNK_ITEMS`（64Ki）。

### 4.2 メモリ予算（最悪ケースの見積り）

| 対象 | 方式 | 上限の見積り | 根拠・備考 |
|---|---|---|---|
| ネイティブ再生（MP4/MOV/WebM） | `video.src = URL.createObjectURL(file)`。JSはバイトに触れない | JSヒープ ≈ 0。デコード用のバッファはWebKitのメディアプロセス側 | Fileはディスク上の実体を参照するblob。U2で実機確認 |
| MKV再生（MSE） | 5.3節。BlobSource＋パケット単位のストリーム供給 | **8Mbps・GOP 5秒で約100MB、20Mbps・GOP 10秒で約180MB**（4.4節の実測表。GOPが長いと急増するので、断片が40MiBを超えるMKVは再生を断る）。内訳：SourceBuffer（総量予算80MiB以内。先読み30秒＋後方15秒）＋`Output` のピーク（**実測：最大フラグメント1個分の約3.2倍＋約30MB**）。`Output` のメタデータはローテーションで一定に保つ（実測：なしだと約15KB/秒で増え、3時間で約160MB） | 映像20Mbps（2.5MB/s）を最悪値として、先読みは**30秒と、「常駐バイト数＋次の断片 ≦ 総量予算80MiB」の両方**で打ち切る（5.3節 手順4）。UAによる自動追い出し（`bufferedchange`）にも従う。パケットは先読みせず1件ずつ読む |
| チャットJSON | Workerでストリーム解析し、圧縮済み配列で保持（5.2節） | **保持：22万件で約15MB（実測）、50万件で約34MB。解析中のピーク：昇順の入力なら保持量とほぼ同じ。昇順でない入力の並べ替え時だけ `records` の2倍（50万件で約64MB）** | 実測（合成した165MB・22万件のTwitch形式。Node・Windows）：`records` 13.3MB（1件あたり約60B）＋`times`・`offsets` 各約0.9MB。`records` はチャンクのまま連結せずに保持する（5.2節）。読み込みは1MiBずつ |
| チャット表示DOM | 最新200件だけを保持（PC版の `MaxItems = 200` と同じ） | 約200行 | 古い行は削除。シーク時は作り直し |
| 絵文字 | sqliteは5.4節の独自リーダー。画像は取得したものをオブジェクトURL化してLRUで保持（1000件（PC版の `EmojiImageCache` と同じ）**かつ合計32MiB以内**）、追い出し時に `URL.revokeObjectURL` | リーダーのページキャッシュ ≤ 8MiB（オーバーフロー本体は含めない）。画像 ≤ 1000件かつ ≤ 32MiB | sqliteのファイルサイズに依存しない（M3） |
| アプリ本体・Service Worker | Viteのビルド成果物（数百KB〜1MB台） | ― | 動画・JSON・sqliteは一切キャッシュしない |

合計（MKV再生中。**チャットの解析は再生と並行するので、解析中のピークも重ねる**）：8Mbps・GOP 5秒で約170〜240MB、20Mbps・GOP 10秒で約260〜320MB（MKV 約100〜185MB＋チャット解析のピーク（22万件〜50万件）約35〜100MB＋絵文字32MiB＋ページキャッシュ8MiB）を設計目標にする。**チャットの解析を待たずに再生を始める**（解析のピークが保持量とほぼ同じで小さいため。解析中はチャット欄に進捗（件数）を表示する。ユーザー確認済み（1節 (a)））。GOPの長いMKVは4.4節の三段階（通常／警告／再生を断る）の扱いにする。実機のタブ上限は公開されていないため、これは見積りであり、実機の長時間再生（S2）と、解析（S3）で落ちないことを確認する。

### 4.3 メモリを増やさないための具体策（実装が守ること）

- チャットのパースは **Web Worker**。メインスレッドにはパース結果の圧縮配列（`Transferable`）だけを渡し、Worker側は終了して解放する。
- `URL.createObjectURL` で作った動画のURLは、動画を切り替えるとき・ページを閉じるときに `revokeObjectURL` する。MKVの `MediaSource` も `endOfStream` → `removeSourceBuffer` → URL解放を行う。
- 動画を切り替えるときは、旧プレーヤー（`Input`・`Output`・イテレータ・`MediaSource`・チャット配列・絵文字リーダー）を**すべて破棄**してから新しいものを作る。`AbortController` で一括して止める。`emojiImageCache` は**全件 `revokeObjectURL` して空にする**（sqliteが選び直される可能性があるため）。`inFlight` の項目は、完了時（失敗時を含む）に必ず消す（PC版は `finally` で `TryRemove` している）。チャットの解析中に別のファイルが選ばれたら、解析Workerを `terminate()` してから新しいWorkerを作る（解析中のピークメモリを二重にしない）。
- **スパイクと診断**：長時間再生の確認用に、スパイク中だけ画面端に診断表示（`SourceBuffer` の保持秒数、追加済みバイト数、先読み秒数、エラー、`performance.now()` の経過）を出す。**診断表示は暫定コードであり、PR作成前に配線ごと削除する**（00 項目27）。

### 4.4 GOP（キーフレーム間隔）の長いMKVの試算と扱い（実測）

**方法**：ffmpeg（libx264、CBR、1080p30のノイズ入りテスト映像＋Opus 128kbps）で、GOPとビットレートを変えた合成MKVを作り、Mediabunnyで5.3節の手順どおりフラグメントMP4へ詰め替えた（映像と音声を交互に `add`、`minimumFragmentDuration: 2`、`AppendOnlyStreamTarget`、書き込み先は受け取ってすぐ捨てる）。`process.memoryUsage()` の `heapUsed + arrayBuffers` の増分の最大を記録した（Node 24・Windows。WebKitではなく、`appendBuffer` で保持される分とSourceBuffer内のデータは含まない）。測定スクリプトと動画の生成コマンドは `tools/measure/`（README・`gen-fixtures.sh`・`measure-output-memory.mjs`・`bench-twitch-parse.mjs`）にある。動画本体は大きいのでコミットしない（生成コマンドで作り直せる）。

| 条件 | 最大フラグメント | `Output` のピーク（実測） | 推定式 3.2×F＋30 | SourceBuffer（計算値） | MKV合計 | 今の方針での扱い |
|---|---|---|---|---|---|---|
| 8Mbps・GOP 5秒 | 5.0MB | 47MB | 46MB | 30＋20MB | 約97MB | 通常 |
| 8Mbps・GOP 30秒 | 29.2MB | 101MB | 123MB | 予算の上限 約84MB（先読み30秒＋後方15秒の計算値は104MBだが、予算が先に効く） | 約185MB | 警告（24MiB超） |
| 20Mbps・GOP 10秒 | 24.9MB | 99MB | 110MB | 予算の上限 約84MB（80MiB） | 約183MB | 通常（**実機で最後まで再生できた**） |
| 20Mbps・GOP 30秒 | 73.1MB | 226MB | 264MB | （再生しない） | （再生しない） | 再生を断る（**実機で再生が止まった**） |
| 20Mbps・GOP 60秒 | 144.4MB | 458MB | 491MB | （再生しない） | （再生しない） | 再生を断る |

SourceBuffer内の量は、設計上の上限から計算した値で、実測ではない（実機の総容量は約100MiB。3.1節）。GOP 30秒・60秒の行は、`Output` のピークの実測（Node）を、メモリがGOPにほぼ比例することの根拠として残している（実機でその素材は再生しない）。実機のタブの上限は公開されていないので、「約400MB以上は未検証で危険」というのは推測である。

**`Output` のローテーションの効果**（約99,000パケット＝900秒の低ビットレート動画）：ローテーションなしだとヒープが約3.4MB/225秒ずつ増えた（約15KB/秒、3時間で約160MB）。300秒ごとのローテーションでは4.5→3.6→2.7MBで一定だった。

**GOPが長いと、動作に何が起きるか**

1. **メモリ**：上表のとおり、GOPにほぼ比例して増える（20Mbpsで、GOP 10秒→60秒で `Output` のピークが99MB→458MB。このため断片40MiB超は再生しない）。
2. **1回の `appendBuffer` の上限（実測：約4MiB）**：フラグメントが73〜144MBでも、**4MiBずつに分けて追加すれば通る**（実測。合計の上限ではない）。分けずに追加すると `QuotaExceededError` になり、再試行しても通らず再生できない。
3. **容量（実測：総容量約100MiB）**：再生中のGOPは追い出せず、Mediabunnyはフラグメントを丸ごとしか出さないので、**今のGOPと次のGOPの両方が収まる（2F ≦ 総量）必要がある**。収まらないと、iPhoneが再生中のGOPごと追い出して止まる（b20_g30＝F 73MBで実測）。
4. **シークの待ち**：目標位置の前のキーフレームから目標まで、読み込んで追加する必要がある。最大でGOP1個分（20Mbps・GOP 60秒で約150MB）。Nodeの詰め替え速度は約250MB/s（433MBを1.7秒）なので、デスクトップで約0.6秒＋ハードウェアデコードの追いつき。iPhoneは未計測。

**方針（仮決定、2026-10-07。根拠：総容量の実測約100MiB → 総量予算80MiB → 2F ≦ 80MiB なので F ≦ 40MiB。警告は、実測で再生できた24MiBまで。実機の結果で見直す）**：`F`＝GOP長（秒）×ビットレート（MB/秒）＝最大フラグメントの大きさ。

| F | 扱い | 目安 |
|---|---|---|
| F ≦ 24MiB | 通常 | 20Mbpsで約10秒、8Mbpsで約25秒まで（実測：F＝24MiB の20Mbps・GOP 10秒は、ローテーション・後方削除を含めて最後まで再生できた） |
| 24MiB ＜ F ≦ 40MiB | 再生は続け、「キーフレーム間隔が長く、メモリ使用量が大きくなる可能性があります」と警告 | 20Mbpsで約17秒、8Mbpsで約42秒まで |
| F ＞ 40MiB | **再生を断る**。「キーフレーム間隔が長すぎるため、このアプリでは再生できません。PCで `ffmpeg -i 入力.mkv -c copy 出力.mp4` により、再エンコードなしでMP4に変換してください」と案内する | 20Mbpsで約17秒超、8Mbpsで約42秒超 |

MP4に変換するとiPhoneのネイティブ再生になり、JS側のメモリを使わない（長いGOPのMP4のシークは、実機で問題なかった：3.1節）。判定は再生前に行う：動画の長さの10%・50%・90%の位置で `getKeyPacket(t)` と `getNextKeyPacket` で隣り合うキーフレームの間隔を測り、最大値をGOPとする（Matroskaの索引（Cues）があれば安い。**無いと、ファイルの先頭からクラスタを丸ごと読みながら走査するので、数GBを読み、シークのたびにも同じ走査になる**（mediabunny 1.61.3 の `matroska-demuxer.ts`）。「準備中」を表示し、Cuesの無いMKV（OBSの異常終了など）の所要時間を⑤の実機確認で測る）。ビットレートは「ファイルサイズ÷再生時間」。再生中は、`pending`（5.3節 手順4）が40MiBを超えたら止める（再生前の判定が外れたときの保険。24〜40MiBなら警告を出す）。`onMoof` の位置差では、追加した後にしか大きさが分からない。

## 5. 設計

### 5.1 技術選定

| 項目 | 採用 | 理由・採らなかった案 |
|---|---|---|
| 言語・ビルド | TypeScript＋Vite（`base: '/vlc-chat-pwa/'`、GitHub Pagesの `/<repo>/` に合わせる） | フレームワーク（React等）は使わない。DOM操作はチャット欄と操作パネルだけで、依存を増やす利点が無い |
| PWA | `vite-plugin-pwa`（Workbox。`generateSW`、アプリ本体のプリキャッシュのみ） | 自前のService Workerは、ハッシュ付き成果物のプリキャッシュ一覧を手で管理することになり壊れやすい。動画等は対象外にする |
| MKV読み取り・MP4書き出し | `mediabunny`（npm、2026-10-06時点の最新 1.61.3、ライセンスMPL-2.0を `npm view` で確認済み。READMEに明記する） | `ffmpeg.wasm` は数十MBのWASMと2GB級のメモリ上限があり、M1に反する。WebCodecsでの自前デコードは音声の速度変更で音程が変わる（Issue本文の要件3「音程は保つ」に反する） |
| テスト | Vitest（Node環境）。sqliteの検証データ生成に `node:sqlite` を使う | |
| チャットパース | 自前の逐次スキャナ（5.2節） | `JSON.parse` は文字列全体が要る。Twitchの163MBを丸ごと文字列にしない（M2） |
| sqlite | 独自の読み取り専用リーダー（5.4節）。`sqlite-wasm` は採らない | `sqlite3_deserialize` はファイル全体のメモリ展開が必要で、M3に反する（ファイルの2倍近いメモリ）。契約のスキーマが固定なので、必要なBツリーページだけ読む実装（約200行）で足りる |

### 5.2 チャット（`src/chat/`）

#### 型・圧縮配列

`ChatMessage`（PC版 `Models/ChatMessage.cs` に対応）は論理モデルとしてのみ定義し、**保持するときは圧縮配列**にする。

```ts
type ChatRun = { kind: 'text'; text: string } | { kind: 'emoji'; url: string; alt: string };
type ChatMessage = { timeSeconds: number; author: string; isOwner: boolean; isModerator: boolean; runs: ChatRun[] };

// 保持形式（`times`・`offsets`・`records` は Transferable で渡す。`emojis` は構造化複製で渡る小さな配列。デコードは表示中の最大200件だけ）
type ChatStore = {
  times: Uint32Array;    // 昇順。floor済みの整数秒（PC版 TimeSeconds と同じ。整数なので4B）
  offsets: Uint32Array;  // 各レコードの位置＝チャンク番号×4MiB＋チャンク内の位置。長さ = 件数
  records: Uint8Array[]; // 4MiBのチャンクの配列。レコード: recordLen(varint) / flags(1B: bit0=owner, bit1=moderator) / authorLen(varint)+author(UTF-8) / runCount(varint) / 各run: kind(1B) + テキストrunはlen(varint)+text、絵文字runは emojis テーブルの添字(varint)
  emojis: { url: string; alt: string }[]; // 絵文字の (url, alt) の重複排除テーブル。同じ絵文字を何十万回も含むチャットで、URL文字列（約70B）を毎回保持しないため
};
```

- 時刻は**切り捨て整数秒**（PC版：YouTubeは `timestampText` を秒に、Twitchは `(int)content_offset_seconds`）。表示は「`timeSeconds <= floor(currentTime)` の最大インデックス」まで。
- **構築と並べ替え**（解析Worker内）：(1) `times`・`offsets` は固定長のチャンク（例：64Ki件ぶん）の連結リストで伸ばし、`records` は4MiBのチャンクの連結リスト（チャンクごとの使用長を持つ）で伸ばす。**レコードの位置は「チャンク番号×4MiB＋チャンク内の位置」の1つの数値**（`offsets` に入れる）で表し、1件のレコードはチャンクをまたがせない（収まらなければ次のチャンクの先頭へ送る。レコードの長さはレコード先頭の `recordLen`）。これで**`records` は連結せず、チャンクのまま保持・転送できる**（実測：22万件の `records` は13.3MB、1件あたり約60B）。新しい配列へコピーして倍々に伸ばす方式はしない。(2) 解析が終わったら、取り込み順に昇順かを調べる。**昇順なら** `times`・`offsets` だけを件数ぴったりの `Uint32Array` へ1回コピーする（各0.9MB程度）。(3) **昇順でなければ**、インデックス配列（`Uint32Array`）を `times` の値で**安定ソート**し（PC版の `List.Sort` は不安定ソートなので、同じ秒の並びがファイル順に保たれる分、PC版より正確。差として許容）、その順に `records` を新しいチャンク列へ詰め直して `offsets` を作り直す（旧チャンクは詰め直し後に解放。この間のピークは `records` の2倍＝50万件で約64MB）。(4) 完成した `times`・`offsets` と `records` のチャンク（`ArrayBuffer` の配列）を Transferable で渡し、Workerを終了する。
- 読み込みは `file.stream()` ではチャンクの大きさを指定できないので、**1MiBずつ `file.slice(offset, offset + 1MiB).arrayBuffer()` で読み**、`TextDecoder`（`stream: true`）で復号する。

#### 形式判定（`detect.ts`）

ファイル先頭の**固定バイト数（4096B）だけ**読み（`file.slice(0, 4096).text()`）、`"replayChatItemAction"` を含めばYouTube、そうでなければTwitch（PC版 `ChatFileLoader` は先頭4096**文字**を見る。PWAは4096**バイト**を見る。実データでは判定結果は変わらない（キーは1行目の先頭にある）。`ReadLine` 相当のことをしない：00 項目29）。UTF-8 BOMは読み飛ばす。

#### YouTube（`youtubeParser.ts`）

本節の「読み込みは1MiBずつ `file.slice(..).arrayBuffer()` で読み、`TextDecoder`（`stream: true`）で復号する」方式で、改行（`\n`、`\r\n` の両方）で行に分けて1行ずつ `JSON.parse`（1行は小さい）。解釈はPC版 `ChatParser.ParseJsonLinesAsync` と**同じ規則**（差がある箇所は個別に明記する）：

- `replayChatItemAction.actions[0].addChatItemAction.item` が `liveChatTextMessageRenderer`（本文無しも可）／`liveChatPaidMessageRenderer`・`liveChatMembershipItemRenderer`（本文が空なら捨てる）。それ以外の種別は捨てる（スーパーチャット・メンバー加入は、本文があれば通常のメッセージとして表示し、金額や装飾は付けない。PC版と同じ。Issueの非ゴール「スーパーチャットの表示」は、金額や装飾の表示を指すと解釈する）。
- `timestampText.simpleText`：`-` を含むものは捨てる。`:` で分割した各部分がすべて `/^\d+$/`（1桁以上の数字だけ）であり、部分が2つ（`MM:SS`）または3つ（`H:MM:SS`）のときだけ秒へ換算し、それ以外は捨てる（PC版の `int.Parse` は、空の部分（`":30"`）や数字以外で例外になり、その行が捨てられる。JSの `Number("")` は0になって食い違うので使わない。差：`int.Parse` は前後の空白と先頭の `+` を受け付けるが、PWAは受け付けない。実害が小さいので許容）。
- 投稿者：`authorName.simpleText`。バッジ：`authorBadges[].liveChatAuthorBadgeRenderer` の `icon.iconType` が `OWNER`／`MODERATOR`、または `tooltip` に `Owner`／`Moderator` を含む（大文字小文字を区別しない）。
- `message.runs[]`：`text` は連結して1つのテキストrunに、`emoji` が出たらそれまでのテキストを確定。`emoji.isCustomEmoji` が真（または、真偽値でない／欠けていて画像URLがある）なら `image.thumbnails[0].url` を**加工せず**絵文字run（`alt` は `emoji.shortcuts[0]`、無ければ `emoji.image.accessibility.accessibilityData.label`、無ければ空文字。**実データでのフィールド名は未確認**。サンプルJSONで確かめる）、そうでなければ（**`isCustomEmoji` が真でも画像URLが無いときを含む**）`emojiId` をテキストrunにする。`emojiId` が空なら何も追加しない（PC版 ChatParser.cs の同じ分岐）。
- 1行の解析に失敗しても継続する（PC版と同じ）。行の区切りは `\n`・`\r\n` だけ（PC版の `ReadLine` は単独の `\r` も区切るが、実データに無いので差として許容する）。

#### Twitch（`twitchParser.ts`）

本節の「読み込みは1MiBずつ `file.slice(..).arrayBuffer()` で読み、`TextDecoder`（`stream: true`）で復号する」方式で復号しながら、**ルートオブジェクトの `comments` 配列の各要素を、文字列とブレースの深さを追う逐次スキャナ**で切り出し、1要素ずつ `JSON.parse` して捨てる。ルートの他のプロパティ（`streamer`・`video` 等）は、同じスキャナで読み飛ばす（`comments` だけを対象にする）。**`comments` かどうかの判定は、ルート直下（深さ1）のプロパティ名だけで行う。読み飛ばすときは、値が文字列・数値・true/false/null（例：`"embeddedData": null`）でもオブジェクト・配列でも、文字列に溜めず、スカラーならそのトークンの終わりまで、入れ子なら深さが元に戻るまで読み捨てる**（TwitchDownloaderの `--embed-images` の出力はルートに数十MB級のbase64画像 `embeddedData` を持ち得る）。`comments` 配列が閉じた時点で、読み込みを打ち切る（PC版の `Finished` と同じ。残りを読まない）。解釈はPC版 `TwitchChatParser.ParseComment` と同じ規則：

- `content_offset_seconds`（数値、負は捨てる）を切り捨て。
- 投稿者：`commenter.display_name`、無ければ `commenter.name`。
- `message.body` が `^\S+\s+(?:subscribed|resubscribed|is gifting|gifted)\b` に一致したら捨てる（サブスク通知）。`\b` は.NETとJSで意味が違う（.NETはUnicodeの単語境界、JSはASCII）ので、JSでは `/^\S+\s+(?:subscribed|resubscribed|is gifting|gifted)(?![\p{L}\p{Mn}\p{Nd}\p{Pc}])/u` と書く（.NETの `\w` ＝ L・Mn・Nd・Pc とほぼ同じ判定になる。U+200C/U+200D の扱いの差は実害が無いので許容）。
- `message.user_badges[]._id` が `broadcaster`→オーナー、`moderator`→モデレーター（大文字小文字を区別する完全一致）。
- `message.fragments[]`：`emoticon.emoticon_id` があれば絵文字run（URLは `https://static-cdn.jtvnw.net/emoticons/v2/{id}/default/dark/2.0`、**一字一句加工しない**。`alt` はそのfragmentの `text`）。絵文字になるのは、`emoticon` がオブジェクトで、`emoticon_id` が**空でない文字列**のときだけ。そうでなければ `text`（**空文字なら捨てる**。PC版 TwitchChatParser.cs の `text.Length > 0`）をテキストrun。`fragments` が配列でない（無い・nullを含む）とき、`body` があれば `body` を1つのテキストrun。`fragments` の要素が `null`・オブジェクトでないときは、そのコメントごと捨てる（PC版は例外になり、そのコメントが捨てられる）。
- runが0件なら捨てる。個別コメントの失敗はスキップして継続する。ファイルが途中で壊れていたら、それまでの分を返す。
- スキャナの性質：文字列内のエスケープ（`\"`）と、チャンク境界での分断を正しく扱う。**テストの重点**（7節）。

#### 同期（`sync.ts`）

PC版 `ChatSyncService` と `MainWindow.SyncChatToTime`（MainWindow.xaml.cs 824-843行）と同じ規則：`indexAtOrBefore(t)`（二分探索。`floor(currentTime)` 以下の最大インデックス）を求め、**直前の位置 `lastIndex` と比べて分岐する**。(0) `target === -1`（先頭のメッセージより前）なら、チャット欄を空にして `lastIndex = -1` にする（PC版 `GetMessagesThrough(-1)` と同じ）。(1) `target === lastIndex` なら何もしない。(2) `target < lastIndex`（後退）なら、`messagesThrough(target)`（末尾から最大200件）でチャット欄を作り直す。(3) それ以外（前進）なら、`lastIndex+1..target` の差分を追加する。**差分が200件を超えるときは、デコードを200件に抑えるため(2)と同じ作り直しにする**（PC版は全件を追加してから200件に切り詰める。結果の表示は同じで、無駄なデコードをしない）。イベントの種類（`seeked`・速度変更）では分岐しない：MSEの再供給やUAの追い出しでも、`currentTime` が後退すれば(2)に入る。再生中は `timeupdate`（Safariでは約4Hz）で呼ぶ。一時停止中のシークでも `seeked` で呼ぶ。`requestAnimationFrame` による毎フレーム更新は使わない（00 項目7）。

### 5.3 動画（`src/media/`）

#### 分類（`classify.ts`）

選択された `File[]` を拡張子で振り分ける：動画（`.mp4 .mov .webm .mkv`）、チャット（`.json`）、絵文字（`.sqlite`）。（Issue要件2の列挙と同じ。拡張子を増やさない）複数ある場合は最初の1つを採用し、余りは画面に通知する。動画かチャットが無いときは再生を始めず、不足を表示する。ファイル名の一致は前提にしない。

#### ネイティブ（`nativePlayer.ts`）

MP4/MOV/WebMは `video.playsInline = true; video.preservesPitch = true`（要件3「音程は保つ」。既定値に頼らず明示する）`; video.src = URL.createObjectURL(file)`。**`stalled` は再生中も約6秒ごとに出る**（実機・U2：61分の連続再生で、`pause`・`waiting`・`error` は出なかった）ので、エラー扱いにもログにも出さない。再生の中断の判定は `waiting`・`error` だけで行う。ファイル選択の確定には数秒〜十数秒かかる（実機で3〜14秒）ので、選択後から再生が始まるまでは「準備中」を表示する（5.5節）。MKVでないのに再生できない（`error` イベント）ときは、エラー内容（コーデック名が分かれば）を表示する。WebMが再生できない場合は、エラーを表示する（MSE経路への振り分けは実装しない。U9ではAV1+Opusのみ確認済みで、VP9+Opusは⑤の実機確認で見る。再生できなければ計画を見直す）。

#### MKV（`mkvPlayer.ts`）— `ManagedMediaSource` ＋ Mediabunny

目的：MKVを**再エンコードなし**でフラグメントMP4にして `ManagedMediaSource` に供給し、通常の `<video>` で再生する（再生速度・音程維持・A/V同期はブラウザ標準のまま使える）。

1. **準備**：`new Input({ formats: ALL_FORMATS, source: new BlobSource(file, { maxCacheSize: 4 * 1024 * 1024 }) })`。映像・音声トラックの `getCodecParameterString()` から `video/mp4; codecs="<映像>, <音声>"` を組み立て（**音声が `opus` なら `Opus`（先頭大文字）に直す**。MP4内のOpusの正式な文字列で、iPhoneの `ManagedMediaSource` は小文字を偽にする：3.1節）、`ManagedMediaSource.isTypeSupported()` で確認。偽ならこのファイルは再生不可として、コーデック名を表示する。再生時間は `getDurationFromMetadata()`（`null` のときは `computeDuration()`（全体走査。遅いが稀。「準備中」を表示する）に切り替える）。**再生前にGOPを判定し、4.4節の三段階（通常／警告／再生を断る）で扱う**。`video.disableRemotePlayback = true`、`video.preservesPitch = true`、`video.src = URL.createObjectURL(mediaSource)`。**トラックの選び方**：`getPrimaryVideoTrack()`・`getPrimaryAudioTrack()` の1本ずつだけを使う（複数の音声トラック・字幕トラックは無視する）。映像トラックが無ければ再生不可として表示する。`track.codec` が `null`（Mediabunnyが知らないコーデック）のときも、`EncodedAudioPacketSource` の生成やMIMEの組み立ての前に、再生不可としてコーデックを表示する。**音声トラックが無ければ**、`codecs` を映像のみにし、`Output` に映像トラックだけを追加する（交互書き込みは1トラックになる）。`startstreaming`・`endstreaming` は `ManagedMediaSource` に、`bufferedchange` は `ManagedSourceBuffer`（`addSourceBuffer` の戻り値）に登録する。`sourceopen` のハンドラは**`{ once: true }`で登録**し、`addSourceBuffer` と `mediaSource.duration = duration` を行う（`endOfStream()` 後にシークで `appendBuffer` すると、仕様上 `readyState` が `'open'` へ戻り `sourceopen` が再発火する。そのたびに `addSourceBuffer` を重ねて呼ばないため）。
2. **供給（ポンプ）**：位置 `startTime`（初回は0）から供給する。
   - **開始位置**：映像は `getKeyPacket(startTime)` で得たキーフレーム（時刻 `k`）から。音声は `getPacket(k)`（開始時刻が `k` **以下**の最後のパケット。`k` より少し前から始まってよい）から。`getKeyPacket(startTime)` が `null`（最初のキーフレームが `startTime` より後）なら `getFirstKeyPacket()` から、`getPacket(k)` が `null`（音声が映像より遅れて始まる）なら `getFirstPacket()` から始める（音声が始まるまでの区間は映像だけを書く）。
   - **Outputの組み立て順**（mediabunny 1.61.3の仕様。順序を間違えると最初の `add` でassertに失敗する）：`new EncodedVideoPacketSource(videoTrack.codec)`・`new EncodedAudioPacketSource(audioTrack.codec)` → `output.addVideoTrack(..)`・`output.addAudioTrack(..)` → `await output.start()` → **各トラックの最初の `add` に `{ decoderConfig: await track.getDecoderConfig() }` を渡す**（2回目以降は不要）。`Output` は `new Output({ format: new Mp4OutputFormat({ fastStart: 'fragmented', minimumFragmentDuration: 2 }), target })`（**単位は秒**）、`target` は `new AppendOnlyStreamTarget(writable)`（`writable` は `WritableStream<Uint8Array>`。fragmentedの出力は追記のみで、このターゲットが内部で連続性を検査する。確定した分を即座に出力する）。
   - **交互に書く（先読みしない）**：`fastStart: 'fragmented'` はパケットのバッファリングが必要なので、映像・音声それぞれのトラックについて「次に書くパケット」を1つずつ持ち、2つのタイムスタンプを比べて、**小さい方を先に** `add` し、書いたトラックだけ `sink.getNextPacket(packet)` で次を取る（`sink.packets()` のイテレータは使わない。先読みのキューの上限が壁時計の直近1秒に消費した数で決まり、ポンプが速いときに数十MBが溜まるため）。片方を先に流しきるとバッファが際限なく溜まる。**時刻が負のパケットは書かない。ただし映像は、時刻0以上の最初のキーフレームから始める**（先頭のパケットがキーフレームでないと、mediabunnyが `First packet must be a key packet.` を投げる：`muxer.ts`）（mediabunnyは `Output` ごとに先頭の負の時刻ぶん音声をずらして `elst` も書くので、ローテーション・シーク後の `Output` とずれる。失うのは数十ms以下）。
   - **`Output` のローテーション**：`Output` は確定したフラグメントのメタデータを `finalize` まで保持する（再生時間に比例して増える）ので、メディア時間で5分（`limits.ts` の `OUTPUT_ROTATION_SECONDS = 300`、単位は秒）が経つたびに、**次に書く映像パケットがキーフレームの位置で**（判定するのは映像パケットを書く番になったとき。音声の次のパケットの時刻が映像のキーフレーム以上のとき）、**`await oldOutput.finalize()`（旧 `Output` の全チャンクが `updateend` まで済む）の後に**、新しい `Output`（同じ設定）と**新しいパケットSource（1つの `Output` にしかつなげられない：mediabunny `media-source.ts`）**を作って `start()` し、最初の `add` に `decoderConfig` を付け直して、**同じパケットから**書き始める（**順序：総量待ち（手順4）→ `finalize()` → `pending` を0にする → 新しい `Output`**。総量待ちの前に `finalize` すると、予算を確かめずに最後の断片が追加される）（待たずに新しい `Output` を始めると、新しい初期化セグメントが旧 `Output` の最後のフラグメントより先にキューへ入り得る）。新しい `Output` の最初のチャンクは新しい初期化セグメント（`ftyp`＋`moov`）で、MSEはこれを初期化セグメントの再追加として受け付ける（U10で確認）。`onMoof` の位置は `Output` ごとに0から数える。
   - **出力の受け取り**：`WritableStream<Uint8Array>` の `write(chunk)` が受け取るのは `Uint8Array`（出力の先頭からの追記。チャンクに時刻は付かず、最初のチャンクが `ftyp`＋`moov` とは限らない）。**チャンクを4MiB以下（`limits.ts` の `APPEND_SLICE_BYTES = 4 * 1024 * 1024`、単位はバイト）に分けて、順に `appendBuffer` する**（1回の追加の上限が約4MiB：3.1節。メディアセグメントを複数の `appendBuffer` に分けて渡すのはMSEの仕様で許されている）。各分割の `updateend` を待ち、**全部の分割が終わってから `write` のPromiseをresolveする**（resolveしないことで、内部の `StreamTarget` が `writer.ready` で待つので、背圧が `add()` まで伝わる。ただし `write` は投げっぱなしで次のチャンクの前にだけ待つので、1フラグメント分遅れて伝わる。実質の歯止めは手順4の総量待ち）。受け取ったものは順に追加する。
   - **フラグメントの時刻とバイト数**：`Mp4OutputFormat` の `onMoof(data, position, timestamp)`（`timestamp` はそのフラグメントのトラックごとのチャンク開始時刻の最小値、`position` はその `Output` の先頭からのバイト位置）で得る。**フラグメントのバイト数＝次の `onMoof` の `position` −この `position`**（最後のフラグメントは `finalize` 後の出力の末尾−この `position`。`data` は moof だけなので、mdat の大きさは分からない）。`onMdat` は使わない（mdat全体を追加でコピーするため）。`write` のチャンクとは `position` の範囲で対応付ける（チャンクは moof と mdat をまとめて、または分けて渡し得る）。手順4の常駐バイト数・`pending` の算出に使う。
3. **SourceBufferの操作は、1本の直列キュー（`SourceBufferQueue`）でだけ発行する**：`appendBuffer`・`remove`・`abort`・`endOfStream`・隙間の再供給の発行は、すべてこのキューを通し、**1つの操作の `updateend` を待ってから次を実行する**（MSEは `updating` 中の `appendBuffer`・`remove` で `InvalidStateError` を投げる）。キューの状態遷移は、偽の `SourceBuffer` を使った単体テストの対象にする（7節）。
4. **流量制御（背圧はポンプ側でも保証する）**：次のパケットを読む前に、次の3つがすべて偽になるまで待つ。(a) `mediaSource.streaming === false`（`endstreaming`。ただし先読みが2秒未満のときは無視して供給する）、(b) 先読み秒数 ≥ 30（**`currentTime` を含む `buffered` の区間**の末尾 − `currentTime`。最後の区間の末尾ではない）、(c) 未完了の操作がキューに残っている。`startstreaming`・`timeupdate`・`updateend` で再開する。さらに、**映像のキーフレームを `add` する直前**（＝直前までのフラグメントが `Output` から押し出されて追加される直前）に、**「常駐バイト数＋pending ≦ `SOURCEBUFFER_BUDGET_BYTES`（`limits.ts`、80MiB、単位バイト）」になるまで待つ**（4.4節。`pending`＝**次に出力される断片に入るパケットのバイト数**。キーフレームの `add` が、溜まっていた断片を押し出す（mediabunny `isobmff-muxer.ts` の `addSampleToTrack`・`interleaveSamples`）ので、総量待ちの時点では、押し出される断片の大きさが `pending` で、すでにSourceBufferにある最後の断片は常駐に入る。**更新は、総量待ちを抜けた直後、キーフレームを `add` する前に行う**：前回の更新以降に `onMoof` が来ていれば（断片が出力された）、`pending` を「直前のキーフレーム以降に `add` した分」に置き換える。来ていなければ（`minimumFragmentDuration: 2` なので、GOPが2秒未満だと1つの断片に複数のGOPが入り、キーフレームでは確定しない）置き換えず、積み増す。実機で、これを予約せずに追加すると、容量（約100MiB）を超えて、iPhoneが再生中のGOPごと追い出して止まった）。`pending` が 40MiB（4.4節の断る閾値）を超えるときは、再生を止めてエラー（GOPが長すぎる）を表示する。**待ちの時間切れ（`BUDGET_WAIT_TIMEOUT_MS`＝20秒）は、「再生中（`paused` でない）かつ `streaming` が真で、削除できる後方が残っていない」状態が続いた時間だけを数える**（一時停止中は `currentTime` が進まず `timeupdate` も来ないので、後方が削除されず総量待ちが解けない。これを時間切れにすると、通常のファイルを一時停止しただけで『GOPが長すぎる』と出る）。この判定は純粋関数に分けてテストする（`pumpPolicy.ts`）。
   - **常駐バイト数の算出**：**断片の記録（開始時刻・終了時刻・バイト数。`onMoof` から作る）を唯一の情報源にし、「`buffered` と区間が重なる記録のバイト数の合計」を常駐バイト数とする**（`appendBuffer`・`remove`・UAの追い出し・シークの `remove(0, Infinity)` のどの後でも、同じ式で求め直せる。足し引きの累計は持たない。累計方式は、実機（v7）で予算を超える推定が出た：3.1節「流量制御（v7）」の行）。新しい記録の区間に含まれる古い記録（隙間の再供給でMSEが上書きしたもの）は捨てる。区間の一部だけが `buffered` に残る記録も1個分として数える（過大に見積もる側）。最後に追加した断片は、次の `onMoof` が来るまで大きさが分からないので、その `Output` の**追加済みバイト位置−その記録の位置**で求める（`pending` は、まだ追加されていない次の断片の分なので、二重に数えない）。初期化セグメント（`ftyp`＋`moov`）は数えない（小さいので無視する。数えると、F＝40MiB で2F＋初期化が予算を超える）。**この計算は純粋関数に分け、単体テストの対象にする**（7節）。
   - **`QuotaExceededError`**：`appendBuffer` がこれを投げたら、**その操作の中で `sb.remove()` を直接呼んで**後方（手順5の削除）を実行し（キューに積むと、自分の後ろに並んで互いに待ち、止まる。偽の `SourceBuffer` で「Quota→削除→再試行」が止まらないことをテストする）、`updateend` を待ってから、同じチャンクを再試行する。それでも超えるなら、**総量上限（`SOURCEBUFFER_BUDGET_BYTES`）を半分にして**（以後、このファイルの再生中はずっと半分のまま。Fが新しい予算の半分を超えるなら、「この端末では再生できません」のエラーにする）再試行する。分割（手順2）が効いていれば、通常は起きない。**再試行は最大3回**で、超えたら再生を止めてエラーを表示する（無限に繰り返さない）。
5. **後方の削除（追い出し）**：`timeupdate` で、**削除の終点を「手順4で記録したフラグメントの開始時刻（`onMoof` の `timestamp`。キーフレームの時刻以前になり得る）のうち、`currentTime − 15秒` 以下で最大のもの」**にする（MSEのcoded frame removalは、終点以降の最初のキーフレームまで削除範囲を延ばす。キーフレームでない位置を終点にすると、`currentTime` を含むGOPや以降の全データまで消えて再生が止まる）。そのようなフラグメントが無い、または終点が `buffered.start(0)` 以下なら、削除しない。`sourceBuffer.remove(buffered.start(0), 終点)` をキューに積む。この終点の計算も純粋関数に含め、単体テストする。**常駐バイト数が総量予算の半分を超えているときは、後方の保持を1秒（再生中のGOPの手前まで）に詰める**（実機で、15秒のままだと、GOPが長いときに前のGOPが残って総量を圧迫する）。
6. **世代の切替（手順7のシークと、隙間の再供給で共通）**：(1) 世代番号を進め、旧ポンプを停止する（`AbortController`）。(2) `SourceBufferQueue` に残っている旧世代の**未実行の操作は捨てるが、捨てる `write` 操作のPromiseは必ず resolve する**（resolve しないと、その `write` を待つ旧 `Output` の `add()` が `writer.ready` を待ったまま `Output` の排他を握り続け、`output.cancel()` が永久に終わらず、旧 `Output` とMatroskaのクラスタが解放されない。mediabunny 1.61.3 の `output.ts`・`target.ts` で確認）。(3) `output.cancel()` は **await せず**に次の世代を始める（完了は後で拾い、失敗はログに出す）。(4) 実行中の `appendBuffer` があれば完了を待つ。(5) `mediaSource.readyState === 'open'` なら、実行中の操作が終わった後に `abort()` をキュー経由で呼び、SourceBufferのパーサーの状態をリセットする（moof だけ追加して mdat を捨てた状態のまま新しい初期化セグメントを追加すると append error になる）。`'ended'` のときは `abort()` を呼ばない（`InvalidStateError` になる）。(6) 新しい `Output` を `start()` して手順2から始める。
   - **隙間の再供給**（`bufferedchange` による）：**書き込み位置＝最後に `updateend` まで終えたフラグメントの終了時刻**（記録の終了時刻は、次の記録の開始時刻。最後に追加した記録は、まだ出力されていない次の断片の先頭のキーフレームの時刻とする（ポンプが `add` したキーフレームの時刻を控えておき、`onMoof` の `timestamp` と突き合わせる）。「ポンプが次に読むパケットの時刻」ではない。Muxerは最大1フラグメント分を内部に溜めるので、常に `buffered` の末尾より先になり、毎回「隙間あり」と誤判定して世代切替を繰り返す）。**（書き込み位置 − `currentTime` を含む区間の末尾）が0.5秒より大きい**とき（絶対値で比べない。区間の末尾が書き込み位置より先にあるのは隙間ではない）、または書こうとしているパケットが追い出された範囲にあるときだけ、`getKeyPacket(隙間の先頭)`（`null` なら `getFirstKeyPacket()`）から上の共通手順で供給し直す（`remove` はしない。重複する区間はMSEが上書きする）。`buffered` は映像と音声の積集合で端にわずかなずれが出るので、許容誤差を設ける。**隙間の判定は純粋関数に分けてテストする**。**`currentTime` を含む `buffered` の区間が無いとき**（シーク直後、UAが再生位置のGOPを追い出した後）は、先読みを0秒として扱う。世代切替の最中（合流待ちの250msを含む）は隙間判定をしない。切替中でなければ、`getKeyPacket(currentTime)` から供給し直す（切替が2回起きないよう、判定は世代番号つきで行う）。
7. **シーク**：`seeking` で `currentTime` がバッファ内なら何もしない（保留中のシークも取り消す）。範囲外なら、**`limits.ts` の `SEEK_DEBOUNCE_MS = 250`（ミリ秒）のあいだ新しい `seeking` が来なければ**、1回だけ以下を行う（つまみのドラッグで `seeking` が連発しても、世代切替を連発しない。GOPが長いと1世代の供給に数秒かかり、連発のたびに作り直すと何も追加されないまま止まる：実測）。手順6の共通手順を行ったうえで、**SourceBufferを空にする**：`remove(0, Infinity)` を、**新しい世代の最初の `write` より前に**キューに積む（mediabunnyは最初の断片を確定するまで `ftyp`＋`moov` を書かないので、この順序が守られる）（`'ended'` のときは `remove` が `'open'` に戻す。`remove` が実行中なら `updateend` を待ってから積む）。新しい `Output` は `getKeyPacket(currentTime)` から。**`timestampOffset` は設定しない**（U5。mediabunnyは元のタイムスタンプを保つ）。**古い世代の `append` は結果を捨てる**（PC版CLAUDE.mdの `_loadGeneration` と同じ考え方）。
8. **終了**：最後のパケットまで書いたら、**総量待ち（手順4）をしてから**、`await output.finalize()`（**最後のフラグメントはここで書き出される**。これを呼ばないと末尾が失われる）→ 最後の `appendBuffer` の `updateend` を待つ → `mediaSource.endOfStream()`。`finalize` が末尾に書く `mfra` ボックスは、MSEのISO BMFFバイトストリーム仕様（https://www.w3.org/TR/mse-byte-stream-format-isobmff/ ）で `ftyp`・`moov`・`styp`・`moof`・`mdat` 以外の有効なトップレベルボックスは「受け入れて無視する」ことになっているので、そのまま追加してよい。
9. **破棄**：`AbortController` を中止し、`output.cancel()`、`Input.dispose()`、`MediaSource`・URLを解放（4.3節）。

実装は、まずMediabunnyの高水準な `Conversion`（変換）でも同じことができるかをS2で試し、背圧・トリミング・シーク位置の指定が不足なら、上の手動のパケット駆動にする。どちらにしても**メモリの上限（4.2節）は手順3〜6が担う**。

**フォールバック**：S2でMKV再生が実機で不安定な場合、実装は止めてユーザーに相談する（Issue記載の通り、PCでの事前変換 `ffmpeg -c copy` に切り替える）。

### 5.4 絵文字（`src/emoji/sqliteReader.ts`）

契約：`CREATE TABLE emoji_cache (url TEXT PRIMARY KEY, data BLOB NOT NULL)`（PC版 `EmojiCacheService.cs`）。**ファイル全体を読み込まず**、`file.slice(start, end).arrayBuffer()` で必要なページだけ読む読み取り専用のSQLiteリーダー。

- **ヘッダ**（先頭100B）：先頭16Bが `SQLite format 3\0`、ページサイズ（16-17B、値1は65536）、予約領域サイズ（20B）、テキストエンコーディング（56-59Bが1＝UTF-8でなければ非対応）。**WALモードのファイル（18-19Bが2）は、-walが無いと最新状態が欠ける可能性があるので、警告を出す**（読めるものは読む）。
- **Bツリー**：テーブルとインデックスの2種類のページを読む。`sqlite_master`（1ページ目のルート）から `emoji_cache` のルートページと、自動インデックス `sqlite_autoindex_emoji_cache_1`（url→rowid）のルートページを得る。ページ種別 0x02（インデックス内部）／0x0A（インデックス葉）／0x05（テーブル内部）／0x0D（テーブル葉）。
- **検索**：`url` を **UTF-8のバイト列として辞書順に比較**（SQLiteの既定のBINARY照合順序）しながらインデックスを二分探索し、rowidを得て、テーブルのBツリーをrowidで引いてレコードを読む。**SQLiteのインデックスはB+木ではない**：内部ページのセルも（左の子ページ番号に加えて）キー本体（url, rowid）を持つので、内部ページのセルとキーが一致したら、そこでrowidを得て、葉まで降りない。内部ページ（0x02・0x05）のヘッダは12バイトで、**オフセット8に右端の子ページ番号**がある。テーブルの内部セルは「左の子ページ番号4B＋rowid（varint）」、インデックスの内部セルは「左の子ページ番号4B＋ペイロード長（varint）＋ペイロード（オーバーフローするときは末尾に4Bの最初のオーバーフローページ番号）」。`sqlite_autoindex_emoji_cache_1` や `emoji_cache` が `sqlite_master` に見つからないときは `OpenError` にする。1ページ目（`sqlite_master`）のBツリーヘッダは、ファイル先頭から**100バイト後**に始まる（ただし**セルポインタ配列の値は、1ページ目でも「ページ先頭（＝ファイル先頭）からのオフセット」であり、100を足さない**。実装者がよく誤る点）。インデックスのセル（長いURL）もオーバーフローし得るので、比較の前にオーバーフローを連結してキーを完成させる。
- **オーバーフロー**：ローカルペイロード長は、SQLite公式のファイル形式仕様（Bツリーセル形式）の式 `U=ページサイズ−予約領域`、テーブル葉 `X=U−35`、インデックス `X=((U−12)×64÷255)−23`、`M=((U−12)×32÷255)−23`（`M` はテーブル葉・インデックス共通）、`K=M+((P−M) mod (U−4))` で決める（Pはペイロード全体のバイト数。式の `÷` は**整数除算**（切り捨て）。SQLiteの実装は整数演算）。**P ≤ X なら全部をページ内に置く。そうでなければ K ≤ X なら K バイト、K > X なら M バイトをページ内に置き**、残りは続きのオーバーフローページの鎖（各ページの先頭4バイトが次のページ番号）をたどって読む。**BLOB長はレコードヘッダのシリアル型から先に求め、5MiB（PC版 `MaxBlobSizeBytes`）を超えるなら本体を読まずに「無し」を返す**。5MiB級のBLOBは約1,280ページになる。S4で所要時間が問題になったら、連続するオーバーフローページをまとめて読む余地がある。
- **キャッシュ**：Bツリーのページ（葉・内部）だけをLRUで保持する（合計 ≤ 8MiB）。**オーバーフローページはキャッシュに入れず**、その場で組み立てて渡す（5MiB級を1回読んだだけで、キャッシュが押し流されないように）。
- **上位のキャッシュ `emojiImageCache.ts`**（PC版 `EmojiImageCache` に対応）：URL→オブジェクトURLのLRU。**件数1000件かつ合計32MiB以内**で追い出し、追い出し時に `URL.revokeObjectURL`。**同じURLの同時の読み込みは1つに合流させる**（`inFlight` のMap。追い出しで `revokeObjectURL` したURLを、DOM上の `<img>` がまだ参照していると壊れ得るが、表示中の絵文字は直近に使われたURLなのでLRUでは追い出されにくく、追い出されても次の再描画で再取得するだけなので許容する。PC版 `EmojiImageCache._inFlight` と同じ。チャット欄の作り直しで、同じURLを並行して引くため）。
- **インターフェース**：`openEmojiDb(file): Promise<EmojiDb | OpenError>`、`EmojiDb.get(url): Promise<Blob | null>`（`Blob` の `type` は先頭のマジックバイトでPNG・GIF・WebP・JPEGを判定して付け、不明なら型なし。型なしで `<img>` に表示できるかはS4で確認する）、`close()`。非対応・破損は `OpenError`（理由つき）として返し、アプリは絵文字を代替表示（`alt`）にして継続する。
- 仕様の一次情報：https://www.sqlite.org/fileformat2.html （実装時に最新版の記述と突き合わせる）。

### 5.5 画面（`src/ui/`）

- レイアウト：縦に、上=動画（幅いっぱい、16:9またはファイルのアスペクト比）、中=操作パネル、下=チャット欄（残り全域）。添付スクリーンショットの構成。`env(safe-area-inset-*)` を考慮する。画面の向きに応じたレイアウトの切り替えはしない（横画面でも同じ縦並び。Issueと添付スクリーンショットは縦画面のみ）。
- 本文・投稿者名は `textContent` で挿入する（`innerHTML` を使わない。チャットJSONは外部データ）。リンクのクリック対応は非ゴール（PC版にあるリンク化は移植しない）。
- 操作パネル：再生／一時停止、シークバー（`input[type=range]`、`aria-label`）、現在位置／長さ、再生速度（PC版と同じ7段階：0.5・0.75・1.0・1.25・1.5・1.75・2.0。動画を切り替えるたびに1.0へ戻し、値は保存しない）。アイコンだけのボタンには `aria-label` を付ける（00 項目9）。ネイティブの全画面は使わない（`playsinline`）。
- チャット欄：新着を下に追加し、**ユーザーが上へスクロール中でなければ**最下部へ自動スクロール。オーナー・モデレーターは名前に装飾（色以外の記号も併用）。投稿者の色付けはしない。絵文字は `<img>`（`alt` 付き、高さは行高に合わせる）。画像の取得は非同期なので、**チャット欄を作り直した（シーク・動画の切り替え）後に古い `get(url)` の結果が届いたら捨てる**（チャット欄の世代番号を持ち、取得を始めたときの世代と比べる。5.3節の世代番号と同じ考え方）。上へスクロール中かどうかの判定（`isNearBottom`）は、DOMに触れない純粋関数に分けてテストする。
- 状態：初期画面は「ファイルを選択」ボタン（複数選択。実機で複数選択できたので、ボタンは1つ）と、選ばれたファイルの内訳（動画／チャット／絵文字）と不足の表示。**動画とチャットがそろったら再生を始められ、チャットの解析は再生を妨げない**：チャット欄に「チャットを読み込み中（N件）」を表示し、解析が終わったら再生位置に合わせて表示する（解析中にシークされたら、完了後に再生位置へ同期する）。ファイルを選んでから再生が始まるまでは「準備中」を表示する。エラー（再生不可のコーデック、GOPが長すぎるMKV等）を表示する。動画の選択元の案内文は出さない（1節 (e)）。チャットの解析結果が0件のとき（形式の取り違えを含む）は「チャットを読み取れませんでした」と表示し、再生は続ける。

### 5.6 PWA・配信

- マニフェストは `vite-plugin-pwa` の `manifest` オプションで生成する（`manifestFilename: 'manifest.json'`。`public/` に別に置かない＝二重にしない）：`display: standalone`、`start_url`・`scope` は `/vlc-chat-pwa/`、アイコン（192・512。`apple-touch-icon` は `vite-plugin-pwa` が自動では挿入しないので、`index.html` に `<link rel="apple-touch-icon">` を書く）。
- Service Worker：アプリ本体（HTML・JS・CSS・アイコン）だけをプリキャッシュ。動画・JSON・sqliteは取り扱わない（4.2節）。**プリキャッシュの漏れに注意**：Workboxの既定の `globPatterns` は js・css・html だけだが、マニフェストのアイコンは `includeManifestIcons`（既定で真。2.0.0の型定義）で自動的にプリキャッシュに入る。`apple-touch-icon` はマニフェストのアイコンではないので `includeAssets` が要る。2MiBを超える成果物は `maximumFileSizeToCacheInBytes` で除外されて警告になるので、Mediabunnyを含むバンドルの大きさを確かめ、必要なら上限を上げる。更新は、PWAを完全に終了した後の次回起動時に反映する（新しいService Workerは、全クライアントが閉じるまで待機状態のまま。再生中のリロードを避けるため、これを許容する）。**再生中のリロードを避けるため、`registerType: 'prompt'`（既定。`'autoUpdate'` は自動でリロードする）にし、更新を促すコードも入れない**。`injectRegister: 'script'`（登録コードをインラインではなく外部スクリプトにする。CSPの `script-src 'self'` と矛盾しない）。`manifestFilename`・`injectRegister`・`registerType` は vite-plugin-pwa 2.0.0 の型定義で存在を確認済み。
- `index.html` に CSP の `<meta>` を置く：`default-src 'self'; img-src 'self' blob: data:; media-src blob:; connect-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'`（`connect-src` を自オリジンに限り、チャット内の外部画像URLを取りに行かない＝オフライン要件を機械的に守る。`img-src` に外部オリジンを含めない）。`media-src` や `worker-src` の実際に必要な値は、ビルド後にSafariのコンソールで違反が出ないことで確認する。
- 配信：GitHub Pages（GitHub Actionsで `vite build` → `actions/deploy-pages`）。**ユーザーの手作業が要る**：(1) リポジトリの Settings → Pages で Source を「GitHub Actions」にする、(2) Settings → Environments → `github-pages` の「Deployment branches」は既定で既定ブランチだけが許可されることがある。featureブランチからプレビューを出すなら、許可するブランチを追加する（設定変更なので、実装時にユーザーに依頼する。Phase 0 のスパイクは別リポジトリ `vlc-chat-pwa-spike` の `main` から出すので、この変更は要らない）。

## 6. ファイル構成

```
vlc-chat-pwa/
  index.html
  vite.config.ts            # base, vite-plugin-pwa
  package.json / tsconfig.json
  public/                   # icons（マニフェストはvite-plugin-pwaが生成）
  src/
    main.ts                 # 起動、ファイル選択、全体の配線
    limits.ts               # メモリ上限の定数（根拠コメント付き）
    chat/  detect.ts youtubeParser.ts twitchParser.ts jsonArrayScanner.ts chatStore.ts sync.ts parseWorker.ts
    emoji/ sqliteReader.ts emojiImageCache.ts
    media/ classify.ts nativePlayer.ts mkvPlayer.ts sourceBufferQueue.ts bufferAccounting.ts（常駐バイト数・後方削除の終点・隙間判定の純粋関数）pumpPolicy.ts（書く順序・ローテーション・負の時刻の除外・総量待ちと時間切れの判定の純粋関数）gopPolicy.ts（GOPの測定結果から通常／警告／断るを決める純粋関数）
    ui/    app.ts controls.ts chatView.ts isNearBottom.ts sessionState.ts（ファイルの選び直しで旧Worker・プレーヤーを破棄する状態遷移の純粋な部分） style.css
  test/                     # Vitest（chat/*, emoji/*, media/*, ui/isNearBottom）
  tools/measure/            # 測定スクリプト（コミット済み。動画は生成コマンドで作り直す）
  .github/workflows/pages.yml
  README.md                 # 使い方、MPL-2.0の記載、メモリ設計の要約
```

## 7. テスト方針（Vitest。ビジネスロジックをUIから分離して単体テストできる構造にする）

雛形の作成（①）の時点で、**Vitestから `node:sqlite` をimportできるか**を確かめる（Viteが `node:` の接頭辞を落として解決に失敗する既知の問題の報告があり、未検証）。失敗するなら `createRequire` 経由か、`test.server.deps.external` の設定で回避する。

| 対象 | 観点 |
|---|---|
| `jsonArrayScanner`・`twitchParser` | 文字列内の `{}[]`・`\"`・`\\`・日本語・サロゲートペア、チャンク境界（1バイトずつ／ランダム長で分割した入力と一括入力の結果が一致）、`comments` 以外のプロパティの読み飛ばし、壊れたファイル（途中打ち切り）、サブスク通知・空本文の除外、バッジ判定、`text` が空のfragmentだけのコメントが除外されること、`comments` 以外の巨大なプロパティ（`embeddedData` 相当）を読み飛ばしても溜め込まないこと、`comments` が閉じたら読み込みを打ち切ること、`content_offset_seconds` が数値でない／負／小数（切り捨て）、`display_name` が無いとき `name` を使う、`emoticon_id` が空文字・数値のときはテキストになる、`fragments` が配列でない（null）とき `body` を使う、`comments` の要素がオブジェクトでないとき読み飛ばす、ルートに `comments` が無い、サブスク通知の判定のUnicode単語境界（`foo subscribedだ` は除外しない、`foo gifted` は除外する） |
| `youtubeParser` | PC版のコードコメントにある各規則（`-` を含む時刻、`H:MM:SS`、時刻の不正入力（`":30"`・`"1:2:3:4"`・`""`・`"a:b"` は捨てる）、投げ銭の空本文除外、絵文字run分割、`isCustomEmoji` 欠落時のフォールバック、`isCustomEmoji` が真で画像URLが無い場合に `emojiId` へ回ること、バッジ判定（`tooltip` による判定を含む）、`isCustomEmoji` が真偽値でない（文字列など）場合、対象外のrendererは捨てる、本文のある投げ銭・メンバー加入は残る、本文の無い通常メッセージは（runs 0件で）残る、壊れた行の後も解析を続ける、CRLFの行区切り、**行分割の境界（`\r` と `\n` が1MiBチャンクの境界で分かれる／マルチバイト文字が境界で切れる／BOM付き／最終行に改行が無い。1バイトずつ分割した入力と一括入力の結果が一致）**） |
| 両パーサー共通 | 同じ内容の**テキストのみ**のチャットを両形式で作り、同じ `ChatStore` になること（絵文字のURL・alt・`emojiId` の扱いが形式ごとに違うので、絵文字を含む比較はしない）／昇順でない入力の整列／5万件〜50万件の合成データでのメモリ・処理時間の測定は、結果が不安定なのでVitestに入れず `tools/measure/bench-twitch-parse.mjs` で行う（Node上のヒープ差分。実機の代替ではない） |
| `detect` | UTF-8 BOMあり、`"replayChatItemAction"` が4096バイトの境界をまたぐ／ちょうど収まる／収まらない場合 |
| `chatStore`・`sync` | エンコード→デコードの往復、二分探索（同時刻が複数・先頭より前・末尾より後）、差分追加、**`target === -1` でチャット欄を空にして `lastIndex = -1`**、`lastIndex` との比較による分岐（後退＝作り直し、前進＝差分、同じ＝何もしない、**前進でも差分が200件超なら作り直し**）、シーク時の再構築で最大200件、昇順でない入力の並べ替え（`records` の詰め直し後も全件が正しくデコードでき、同じ秒の順序がファイル順のまま）、チャンクの切れ目をまたぐレコードの位置（`offsets`）と `recordLen` の整合 |
| `sqliteReader` | `node:sqlite` で生成した多様なDB（ページサイズ512／4096／65536、1万行以上でBツリーが2階層以上、BLOBが数ページに渡るオーバーフロー、5MiB超のBLOB、空のテーブル、URLが日本語・長文、存在しないURL、非UTF-8エンコーディング、テーブル無し、壊れたヘッダ、**探すキーがインデックスの内部ページのセルにある場合**、キー自体がオーバーフローする長大なURL、`sqlite_master` が1ページに収まらないほど多数の表・インデックスがあるDB、`PRAGMA journal_mode=WAL` で作ったDBで警告が出ること）に対し、**予約領域が0でないDBは `node:sqlite` では作りにくいので未テストと明記する**。**全URLを1件ずつ引いて** `node:sqlite` の結果と一致すること。ページ読み込み回数・保持バイトの上限が守られること |
| `emojiImageCache` | 追い出し時に `revokeObjectURL` が呼ばれること、件数と合計バイトの両方の上限、同じURLの同時の読み込みが1回の取得に合流すること、**Blobの型（先頭のマジックバイトでPNG・GIF・WebP・JPEG、不明は型なし）**、**チャット欄の世代番号で古い `get(url)` の結果を捨てること**、**取得に失敗したときも `inFlight` から消えること** |
| チャット欄の自動スクロール判定 | `isNearBottom` の純粋関数（境界値） |
| `classify` | 拡張子の大文字小文字、複数ファイル、不足の判定、**ファイルを選び直したとき、解析中のWorkerを `terminate()` してから新しいWorkerを作ること**（`ui/sessionState.ts` の純粋な状態遷移をテストする） |
| `mkvPlayer` | ポンプの流量制御・世代破棄の**状態遷移だけ**を、偽の `MediaSource`／`SourceBuffer` で単体テスト（`QuotaExceededError` の再試行と回数の上限、`bufferedchange` による隙間の再供給、常駐バイト数と後方削除の終点（どちらも純粋関数。**一時停止中の時間切れ判定**、**書く順序・ローテーション・負の時刻の除外の判定**も純粋関数にして対象に含める。フラグメント記録と `buffered` から算出。**終点が（キーフレーム以前の）フラグメント開始時刻に合うこと**を含む）、**`Output` のローテーション境界でパケットが欠けない・重複しないこと**、**世代切替で捨てた `write` のPromiseが settle し、`cancel()` が完了すること**、**チャンクの4MiB分割（境界、端数、4MiBちょうど）**、**シークの合流（連発する `seeking` が1回の世代切替になる。バッファ内に戻ったら取り消す）**、**GOPと閾値の判定**（F＝GOP×ビットレートから、通常／警告／断る。境界値）、`getKeyPacket` が `null` のとき最初のパケットから始めること、`onMoof` の位置からのフラグメントのバイト数の算出、**`SourceBufferQueue` の直列化**、**`ended` 状態からのシーク（`abort()` を呼ばない）**、**`remove` 実行中のシーク**、音声トラックが無い場合、複数の音声・字幕トラックがある場合を含む）。テスト用のMKVは、テストの中で Mediabunny の `MkvOutputFormat` に合成パケット（映像はVP9・音声はOpus（H.264は `decoderConfig` に avcC が要るので避ける）。映像・音声とも数十個。先頭の負の時刻、キーフレームの位置を変えたもの）を書いて作る（動画ファイルはコミットしない）。実際の再生・デコードは実機の手順（8節）で確認する |

## 8. 動作確認手順（読み替え：iPhone実機。配信URLを開く）

Phase 0（スパイク）は、実装前に**S1・S2だけ**を行う。**検証専用の別リポジトリ `vlc-chat-pwa-spike`（ローカル `C:/Users/owner/source/repos/vlc-chat-pwa-spike`、使い捨て。本実装には持ち込まない）の GitHub Pages に出す**（`main` から公開するので、環境のブランチ許可の変更は要らない。ユーザーの手作業は Pages の有効化だけ）。スパイクの作り方・手順・デスクトップChromeでの確認結果は、そのリポジトリの README にある（S3〜S5は、対象の実装ができてから行うので、作業の順序の中に置く）。結果は計画書の3節に追記する。**外れたときの対応は3節の表に従う**。ただし、U2〜U5のどれかが外れて、3節の「外れたとき」の列が**ユーザーから見える挙動を変える**場合（動画サイズの上限、MKV非対応など）は、実装に進まずユーザーに相談する。

| ID | 内容 |
|---|---|
| S1 | 選択UIの検証（U1）：`accept` 無しで `.mkv`・`.sqlite`・`.json`・動画を複数選択できるか／単独表示モードのPWAでも可か。数GB・2〜3時間のMP4とWebMで1時間連続再生・何度もシーク（U2）。WebM（VP9+Opus、AV1+Opus）のネイティブ再生の可否（U9）。**長いGOPのMP4**（4.4節の20Mbps・GOP 60秒のMKVを `ffmpeg -c copy` でMP4にしたもの）のネイティブ再生、シーク、メモリ（4.4節の「事前変換を案内する」が成り立つか） |
| S2 | MKVの検証（U3〜U7）：VP9+Opus、AV1+Opus、H.264+AACの各実ファイルを `ffprobe`（`E:\tube\ffprobe.exe`）で確認したうえで（**キーフレーム間隔（GOP長）の最大値も測る**：`ffprobe -v error -select_streams v:0 -skip_frame nokey -show_entries frame=pts_time -of csv=p=0 <file>`。**クラスタの大きさも測る**（`mkvinfo`、または `ffprobe -show_packets` の `pos` から推定）。4.2節のフラグメントのメモリは max(2秒, GOP長) で決まる）、`isTypeSupported`、再生、シーク、2.0倍速、1時間以上の連続再生。診断表示で保持秒数・バイト数を記録。**テスト動画**：4.4節で作った合成MKV（8Mbps・GOP 5秒／8Mbps・GOP 30秒／20Mbps・GOP 10秒／20Mbps・GOP 30秒／20Mbps・GOP 60秒。H.264＋Opus。`tools/measure/gen-fixtures.sh` で作る。コミットしない）をiPhoneに入れ、再生・シーク・連続再生で、SourceBufferの容量（U11）とタブの落ちる条件を確かめる。不安定だったときの切り分け項目：`getKeyPacket` の `verifyKeyPackets`（キーフレームのフラグが誤っているMKV）（`AppendOnlyStreamTarget` は5.3節で採用済み）。**受け入れ条件の実ファイル**：VP9+Opus（WebM・MKV）、AV1+Opus（MKV）、H.264+AAC（MKV）の再生・シーク・2倍速も確かめる |
| S3（②の後） | チャット：163MB級のTwitch JSONと大きなYouTube JSONをWorkerで解析し、時間と圧縮配列のサイズを記録。**再生を始めたまま解析しても落ちないこと**（解析と再生は並行する：4.2節）、解析後にWorkerを終了してメモリが解放されていること、iPhoneでの解析時間（Node・デスクトップの実測は165MB・22万件で約2.7秒）を記録する |
| S4（③の後） | sqlite：実物（`vlc-chat/bin/Debug/net10.0-windows/emoji_cache.sqlite` 12,230,656B・275行・最大BLOB 6,291,456B と、より実態に近い `vlc-chat/publish/VLC-Chat-Replay-win-x64-single-20261006/emoji_cache.sqlite` 32,968,704B（2026-10-07時点。行数・最大BLOBは実装時に再計測）。いずれもページサイズ4096・予約0・UTF-8・ロールバックジャーナル）と、Pythonで作った数百MB〜1GBの合成DBで、検索の所要時間とページ読み込み回数を記録 |
| S5（⑥の後） | PWA：ホーム画面に追加→**アイコンからオンラインのうちに一度起動してプリキャッシュを作る**（ホーム画面のWebアプリはSafariとストレージが別になるのが一般的な挙動。実機で確認する）→機内モード→起動→ファイル選択→再生（U8） |

**作業の順序**（実装セッション）：Phase 0（S1・S2。**完了**。3.1節）→ ①雛形（Vite・TypeScript・Vitest・Pagesのワークフロー）→ ②チャット（`chat/`とテスト）→ **S3** → ③sqliteリーダー（`emoji/`とテスト）→ **S4** → ④ネイティブ再生とUI → ⑤MKV再生（**ここで、3.1節の未確認（U4・U5・F＝24〜40MiB・VP9/H.264の実ファイル）を実機で確かめる**）→ ⑥PWA化・CSP → **S5** → ⑦暫定コード（診断表示）の撤去と最終確認。②③は互いに独立で、④以降は②③に依存する。

最終確認（人の手）：Issueの受け入れ条件4つを、機内モードのホーム画面アイコンから順に確認する（機内モードにする前に、アイコンからオンラインで一度起動しておく）。依頼文には配信URLと、確認に使うファイルの置き場所を書く。

## 9. 品質管理

`npm run build`（`tsc --noEmit` を含む）・`npm test` が0警告0エラー。`tsconfig` は `strict`。Lintは導入しない（`tsc --noEmit` の0警告0エラーを品質ゲートとする）。ビルドしたうえで、Workerとメインのバンドル分割を確認する。

## 10. 設計判断の記録（採用案・理由・採らなかった案）

| # | 判断 | 理由 | 採らなかった案 |
|---|---|---|---|
| D1 | MKVは再エンコードなしのフラグメントMP4を `ManagedMediaSource` に供給 | 標準の `<video>`（音程維持の倍速・A/V同期）を使える。メモリは供給量で制御できる | WebCodecsの自前プレーヤー（音程・同期・シークを自前で実装）／ffmpeg.wasm（メモリ） |
| D2 | チャットは圧縮配列＋Worker | 22万件でJSオブジェクトを作ると数百MBになり得る（M2） | 件数ぶんのオブジェクト配列 |
| D3 | Twitch JSONは自前の逐次スキャナ | 163MBを文字列にしない | `JSON.parse`（全体展開）／外部の逐次JSONライブラリ（依存の追加。スキャナは約80行で、テストで挙動を固定できる） |
| D4 | sqliteは独自の読み取り専用リーダー | ファイルサイズに依存しないメモリ（M3）。依存と巨大なWASMが不要 | `sqlite-wasm`＋`deserialize`（全体展開）／OPFSへ取り込み（ディスクを使い、初回に時間がかかる） |
| D5 | 絵文字の見つからない場合は `alt` テキスト表示 | Issue要件2（sqlite省略時は代替表示） | PC版の「非表示」 |
| D6 | チャットの時刻は切り捨て整数秒 | PC版と同じ表示タイミング | 小数秒（PC版との差が出る） |
| D7 | `accept` を付けない（U1で確定） | `.mkv`・`.sqlite` がiOSのピッカーで選べない可能性 | `accept="video/*,.json"` |
| D8 | Service Workerはアプリ本体だけをキャッシュ | 数GBの動画をCache Storageに入れるとクォータ超過・クラッシュの報告がある（workbox#3004） | 動画のキャッシュ |

## 11. リスク

- 実機のメモリ使用量は直接計測できない（Mac無し）。Macを借りられるならWeb Inspectorの「タイムライン」で確認する。借りられなければ、長時間再生でタブが再読み込みされないことと、診断表示の計数で代替する。
- iOSのファイル選択がtmpへ数GBをコピーする場合、選択に時間がかかり、空き容量も要る（U2で所要時間を測り、画面に「準備中」を表示する）。
- sqliteがWALモードで書かれていると、`-wal` の内容は読めない（5.4節。警告で対処）。
- Mediabunnyは更新が活発なライブラリで、APIが変わり得る。`package-lock.json` で版を固定し、アップデート時はS2をやり直す。
- 一次情報で未確認の項目（3節）が外れた場合は、計画を作り直す（ステップ2〜4に戻る）。
