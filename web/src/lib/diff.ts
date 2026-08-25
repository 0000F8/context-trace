export type DiffLineType = 'equal' | 'add' | 'remove';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/**
 * LCS-based line diff. Pure, no dependencies. Used to render prev/current
 * content as a line-level diff (section drawer, inspector "Changes" tab).
 */
export function diffLines(prev: string, next: string): DiffLine[] {
  const a = prev.length > 0 ? prev.split('\n') : [];
  const b = next.length > 0 ? next.split('\n') : [];
  const n = a.length;
  const m = b.length;

  // dp[i][j] = length of LCS of a[i..] and b[j..]
  const dp: number[][] = [];
  for (let i = 0; i <= n; i++) {
    dp.push(new Array<number>(m + 1).fill(0));
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      result.push({ type: 'equal', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      result.push({ type: 'remove', text: a[i]! });
      i++;
    } else {
      result.push({ type: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < n) {
    result.push({ type: 'remove', text: a[i]! });
    i++;
  }
  while (j < m) {
    result.push({ type: 'add', text: b[j]! });
    j++;
  }
  return result;
}
