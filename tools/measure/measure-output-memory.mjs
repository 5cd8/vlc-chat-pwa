// 長いGOPのMKVを、5.3節の手順どおりフラグメントMP4へ詰め替えたときの、JSメモリの実測。
// 使い方: node --expose-gc measure.mjs <mkv> [rotateSeconds]
import { openAsBlob } from 'node:fs';
import { Input, ALL_FORMATS, BlobSource, EncodedPacketSink, Output, Mp4OutputFormat,
  AppendOnlyStreamTarget, EncodedVideoPacketSource, EncodedAudioPacketSource } from './dist/bundles/mediabunny.mjs';

const file = process.argv[2];
const rotateSeconds = process.argv[3] ? Number(process.argv[3]) : Infinity;
const MB = 1024 * 1024;
const memparts = () => { const m = process.memoryUsage(); return { heap: m.heapUsed, ab: m.arrayBuffers }; };
const mem = () => { const m = memparts(); return m.heap + m.ab; };
let baseParts;

const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(await openAsBlob(file), { maxCacheSize: 4 * 1024 * 1024 }) });
const vTrack = await input.getPrimaryVideoTrack();
const aTrack = await input.getPrimaryAudioTrack();
const vSink = new EncodedPacketSink(vTrack);
const aSink = new EncodedPacketSink(aTrack);
const vCfg = await vTrack.getDecoderConfig();
const aCfg = await aTrack.getDecoderConfig();

let outBytes = 0;
const fragments = [];     // { start, size }
let lastMoofPos = null;
let peakDelta = 0, peakLabel = '';
let base;

async function newOutput() {
  const state = { moofs: [], total: 0 };
  const target = new AppendOnlyStreamTarget(new WritableStream({
    write(chunk) { state.total += chunk.byteLength; outBytes += chunk.byteLength; },
  }));
  const output = new Output({
    format: new Mp4OutputFormat({
      fastStart: 'fragmented', minimumFragmentDuration: 2,
      onMoof: (data, position, timestamp) => { state.moofs.push({ position, timestamp }); },
    }),
    target,
  });
  const vSrc = new EncodedVideoPacketSource(vTrack.codec);
  const aSrc = new EncodedAudioPacketSource(aTrack.codec);
  output.addVideoTrack(vSrc);
  output.addAudioTrack(aSrc);
  await output.start();
  return { output, vSrc, aSrc, state, firstV: true, firstA: true, startMediaTime: null };
}

function sample(label) {
  const d = mem() - base;
  if (d > peakDelta) { peakDelta = d; peakLabel = label; }
}

global.gc(); base = mem(); baseParts = memparts();
let cur = await newOutput();
let vp = await vSink.getFirstPacket();
let ap = await aSink.getFirstPacket();
let n = 0, rotations = 0;
const marks = [];
const t0 = Date.now();
const total = await input.computeDuration();
let nextMark = total / 4;

while (vp || ap) {
  const useV = vp && (!ap || vp.timestamp <= ap.timestamp);
  const pkt = useV ? vp : ap;
  if (pkt.timestamp < 0) { if (useV) vp = await vSink.getNextPacket(vp); else ap = await aSink.getNextPacket(ap); continue; }
  // ローテーション：次が映像キーフレームのとき
  if (useV && pkt.type === 'key' && cur.startMediaTime !== null && pkt.timestamp - cur.startMediaTime >= rotateSeconds) {
    await cur.output.finalize();
    cur = await newOutput(); rotations++;
  }
  if (cur.startMediaTime === null) cur.startMediaTime = pkt.timestamp;
  if (useV) { await cur.vSrc.add(pkt, cur.firstV ? { decoderConfig: vCfg } : undefined); cur.firstV = false; vp = await vSink.getNextPacket(vp); }
  else { await cur.aSrc.add(pkt, cur.firstA ? { decoderConfig: aCfg } : undefined); cur.firstA = false; ap = await aSink.getNextPacket(ap); }
  n++;
  if (n % 50 === 0) sample('t=' + pkt.timestamp.toFixed(1));
  if (pkt.timestamp >= nextMark) { global.gc(); { const p = memparts(); marks.push({ at: pkt.timestamp.toFixed(0) + 's', heapMB: ((p.heap - baseParts.heap) / MB).toFixed(1), arrayBufMB: ((p.ab - baseParts.ab) / MB).toFixed(1) }); } nextMark += total / 4; }
}
await cur.output.finalize();
global.gc();
const finalRetained = (mem() - base) / MB;
// フラグメントの大きさ（moofのposition差）
const allMoofs = cur.state.moofs;
let maxFrag = 0;
for (let i = 0; i < allMoofs.length; i++) {
  const end = i + 1 < allMoofs.length ? allMoofs[i + 1].position : cur.state.total;
  maxFrag = Math.max(maxFrag, end - allMoofs[i].position);
}
console.log(JSON.stringify({
  file: file.split(/[\\/]/).pop(), durationSec: total, rotateSeconds, rotations,
  packets: n, outputMB: (outBytes / MB).toFixed(0),
  maxFragmentMB_lastOutput: (maxFrag / MB).toFixed(1),
  peakDeltaMB: (peakDelta / MB).toFixed(1), peakAt: peakLabel,
  retainedAtQuarters: marks, retainedAfterFinalizeMB: finalRetained.toFixed(1),
  elapsedMs: Date.now() - t0,
}));
input.dispose();
