export const PLAYBACK_RATES = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0] as const;

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 操作パネル：再生／一時停止、シークバー、現在位置／長さ、再生速度。 */
export class Controls {
  private readonly playButton: HTMLButtonElement;
  private readonly seek: HTMLInputElement;
  private readonly timeLabel: HTMLElement;
  private readonly rateSelect: HTMLSelectElement;
  private dragging = false;

  constructor(
    root: HTMLElement,
    private readonly video: HTMLVideoElement,
  ) {
    root.innerHTML = '';
    this.playButton = document.createElement('button');
    this.playButton.type = 'button';
    this.playButton.className = 'play';
    this.playButton.setAttribute('aria-label', '再生');
    this.playButton.textContent = '▶';

    this.seek = document.createElement('input');
    this.seek.type = 'range';
    this.seek.className = 'seek';
    this.seek.min = '0';
    this.seek.max = '0';
    this.seek.step = '1';
    this.seek.value = '0';
    this.seek.setAttribute('aria-label', 'シーク');

    this.timeLabel = document.createElement('span');
    this.timeLabel.className = 'time';

    this.rateSelect = document.createElement('select');
    this.rateSelect.className = 'rate';
    this.rateSelect.setAttribute('aria-label', '再生速度');
    for (const rate of PLAYBACK_RATES) {
      const option = document.createElement('option');
      option.value = String(rate);
      option.textContent = `${rate.toFixed(2).replace(/0$/, '')}x`;
      this.rateSelect.appendChild(option);
    }
    this.rateSelect.value = '1';

    root.append(this.playButton, this.seek, this.timeLabel, this.rateSelect);
    this.setEnabled(false);
    this.bind();
    this.refresh();
  }

  setEnabled(enabled: boolean): void {
    this.playButton.disabled = !enabled;
    this.seek.disabled = !enabled;
    this.rateSelect.disabled = !enabled;
  }

  /** 動画を切り替えるたびに、速度を 1.0 へ戻す（値は保存しない）。 */
  resetRate(): void {
    this.video.defaultPlaybackRate = 1;
    this.video.playbackRate = 1;
    this.rateSelect.value = '1';
  }

  /** timeupdate などから呼ぶ。 */
  refresh(): void {
    const duration = this.video.duration;
    const hasDuration = Number.isFinite(duration) && duration > 0;
    this.seek.max = String(hasDuration ? Math.floor(duration) : 0);
    if (!this.dragging) this.seek.value = String(Math.floor(this.video.currentTime));
    const shown = this.dragging ? Number(this.seek.value) : this.video.currentTime;
    this.timeLabel.textContent = `${formatTime(shown)} / ${hasDuration ? formatTime(duration) : '--:--'}`;
    const playing = !this.video.paused;
    this.playButton.textContent = playing ? '⏸' : '▶';
    this.playButton.setAttribute('aria-label', playing ? '一時停止' : '再生');
    const rate = String(this.video.playbackRate);
    if (this.rateSelect.value !== rate && PLAYBACK_RATES.some((r) => String(r) === rate)) this.rateSelect.value = rate;
  }

  private bind(): void {
    const v = this.video;
    // 再生は再生ボタンの click で始める（iOS はユーザー操作の外の play() を拒否することがある）
    this.playButton.addEventListener('click', () => {
      if (v.paused) void v.play().catch(() => this.refresh());
      else v.pause();
    });
    // つまみの移動中は表示だけ更新し、離したときに1回だけシークする（シークの連発を避ける）
    this.seek.addEventListener('input', () => {
      this.dragging = true;
      this.refresh();
    });
    this.seek.addEventListener('change', () => {
      this.dragging = false;
      v.currentTime = Number(this.seek.value);
      this.refresh();
    });
    this.rateSelect.addEventListener('change', () => {
      v.playbackRate = Number(this.rateSelect.value);
    });
    for (const type of ['timeupdate', 'play', 'pause', 'ratechange', 'durationchange', 'loadedmetadata', 'seeked', 'emptied']) {
      v.addEventListener(type, () => this.refresh());
    }
  }
}
