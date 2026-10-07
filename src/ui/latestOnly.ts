/**
 * 非同期の結果が「まだ有効な世代のものか」を判定する。チャット欄を作り直した（シーク・動画の切り替え）後に、
 * 古い世代で始めた絵文字の取得結果が届いたら捨てるために使う（5.3節の世代番号と同じ考え方）。
 */
export class LatestOnly {
  private generation = 0;

  /** 新しい世代を始める。以前に取った token はすべて無効になる。 */
  advance(): void {
    this.generation++;
  }

  /** 今の世代の token を取る。非同期処理の開始時に呼ぶ。 */
  token(): number {
    return this.generation;
  }

  isCurrent(token: number): boolean {
    return token === this.generation;
  }
}
