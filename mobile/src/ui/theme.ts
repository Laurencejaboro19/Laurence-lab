import type { OrderStatus } from '@/api/types';

export const colors = {
  bg: '#120F0B',
  surface: '#1C1712',
  surface2: '#26201A',
  border: '#332A22',
  text: '#F6EFE4',
  muted: '#A89F91',
  faint: '#6E655A',
  accent: '#F2A341',
  accentInk: '#1A1308',
  green: '#5BC28A',
  red: '#E5655C',
  blue: '#7FB3F5',
  amberSoft: 'rgba(242,163,65,0.14)',
};

export const radius = { sm: 10, md: 14, lg: 20, pill: 999 };
export const space = (n: number) => n * 4;

export const type = {
  display: { fontSize: 28, fontWeight: '800' as const, letterSpacing: -0.5, color: colors.text },
  h1: { fontSize: 22, fontWeight: '700' as const, letterSpacing: -0.3, color: colors.text },
  h2: { fontSize: 17, fontWeight: '700' as const, color: colors.text },
  body: { fontSize: 15, color: colors.text, lineHeight: 21 },
  small: { fontSize: 13, color: colors.muted, lineHeight: 18 },
  tiny: { fontSize: 11, color: colors.muted, letterSpacing: 0.6, textTransform: 'uppercase' as const, fontWeight: '600' as const },
};

export function naira(kobo: number): string {
  const n = Math.round(kobo) / 100;
  const whole = Math.floor(n);
  const frac = Math.round((n - whole) * 100);
  const s = whole.toLocaleString('en-NG');
  return frac ? `₦${s}.${String(frac).padStart(2, '0')}` : `₦${s}`;
}

export const STATUS_LABEL: Record<OrderStatus, string> = {
  PLACED: 'Awaiting payment',
  PAID: 'Paid',
  ACCEPTED: 'Accepted',
  PREPARING: 'Preparing',
  READY: 'Ready',
  DISPATCHED: 'On the way',
  DELIVERED: 'Delivered',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  REFUNDED: 'Refunded',
  PARTIALLY_REFUNDED: 'Partly refunded',
  FAILED: 'Failed',
};

export function statusColor(s: OrderStatus): string {
  switch (s) {
    case 'DELIVERED':
    case 'PAID':
    case 'ACCEPTED':
      return colors.green;
    case 'PREPARING':
    case 'READY':
    case 'DISPATCHED':
      return colors.accent;
    case 'PLACED':
      return colors.blue;
    case 'REJECTED':
    case 'CANCELLED':
    case 'EXPIRED':
    case 'FAILED':
      return colors.red;
    default:
      return colors.muted;
  }
}

export const ACTIVE_STATUSES: OrderStatus[] = ['PLACED', 'PAID', 'ACCEPTED', 'PREPARING', 'READY', 'DISPATCHED'];
export const CANCELLABLE: OrderStatus[] = ['PLACED', 'PAID', 'ACCEPTED'];
