# 測定スクリプト（計画書 4.4節・5.2節の実測の再現用）

- `gen-fixtures.sh`：テスト用の合成MKVを作る（ffmpeg）。動画本体はコミットしない。
- `measure-output-memory.mjs`：MKV→フラグメントMP4の詰め替え中のJSメモリを測る。`node --expose-gc measure-output-memory.mjs <mkv> [ローテーション秒]`。`mediabunny@1.61.3` を `./dist/bundles/mediabunny.mjs` から読む前提（`npm pack mediabunny@1.61.3` で展開したパッケージ内に置いて実行した）。
- `bench-twitch-parse.mjs`：Twitch形式JSONの逐次スキャナ＋圧縮配列の試作の速度・保持量を測る（合成データを生成して測る）。`node --expose-gc bench-twitch-parse.mjs twitch_synth.json 220000 [scan]`。

測定環境：Node 24.20.0、Windows。WebKit・iPhoneでの値ではない。
