export function formatTokens(n: number): string {
  const sign = n < 0 ? '-' : '';
  return sign + Math.abs(n).toLocaleString('en-US');
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(text.length - half)}`;
}

export function previewLine(content: string, max = 96): string {
  const lines = content.split('\n');
  const line = lines.find((l) => l.trim().length > 0) ?? lines[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
