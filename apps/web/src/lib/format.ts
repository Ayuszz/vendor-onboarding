const rtf = new Intl.RelativeTimeFormat('en-IN', { numeric: 'auto' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

export function timeAgo(iso: string) {
  const secs = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, s] of UNITS) if (Math.abs(secs) >= s) return rtf.format(Math.round(secs / s), unit);
  return 'just now';
}

export const dateTime = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

export const fileSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
