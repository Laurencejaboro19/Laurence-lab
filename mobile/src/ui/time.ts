export function when(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })} ${time}`;
}
