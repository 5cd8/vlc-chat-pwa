/** 最下部の近くにいるか（上へスクロール中でなければ、新着で自動スクロールする）。DOMに触れない純粋関数。 */
export function isNearBottom(scrollTop: number, clientHeight: number, scrollHeight: number, threshold = 24): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}
