/**
 * HTTP client for the Laurence Lab mobile API (`/app/v1` on the bot server).
 * Thin on purpose: every call is one fetch, errors become ApiError with the
 * server's code/message, and the bearer token is injected from storage.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';

import type {
  Address,
  ApiErrorBody,
  AppConfig,
  CartQuote,
  CheckoutResult,
  Customer,
  LaurenceApi,
  MenuCategory,
  Order,
  OrderDetail,
  Page,
  Session,
  Zone,
} from './types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

const extra = (Constants.expoConfig?.extra ?? {}) as { apiBaseUrl?: string };
export const API_BASE_URL: string =
  process.env.EXPO_PUBLIC_API_BASE_URL ?? extra.apiBaseUrl ?? 'https://laurence-lab-bot.vercel.app';

export const platform: 'ios' | 'android' | 'web' =
  Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';

let tokenProvider: () => string | null = () => null;
export function setTokenProvider(fn: () => string | null): void {
  tokenProvider = fn;
}

let idemCounter = 0;
const idempotencyKey = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${++idemCounter}`;

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = tokenProvider();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (method !== 'GET') headers['Idempotency-Key'] = idempotencyKey();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/app/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new ApiError(0, 'NETWORK', err instanceof Error ? err.message : 'network error');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const e = (json as ApiErrorBody | null)?.error;
    throw new ApiError(
      res.status,
      e?.code ?? `HTTP_${res.status}`,
      e?.message ?? `request failed (${res.status})`,
      e?.details,
    );
  }
  return json as T;
}

export const liveApi: LaurenceApi = {
  mode: 'live',
  config: () => request<AppConfig>('GET', '/config', undefined, { timeoutMs: 8000 }),
  menu: async () => (await request<{ categories: MenuCategory[] }>('GET', '/menu')).categories,
  zones: () => request<Zone[]>('GET', '/zones'),
  session: (input) => request<Session>('POST', '/session', { ...input, platform }),
  me: () => request<Customer>('GET', '/me'),
  updateMe: (input) => request<Customer>('PATCH', '/me', input),
  addresses: () => request<Address[]>('GET', '/me/addresses'),
  addAddress: (input) => request<Address>('POST', '/me/addresses', input),
  deleteAddress: (id) => request<void>('DELETE', `/me/addresses/${id}`),
  cart: () => request<CartQuote>('GET', '/me/cart'),
  addToCart: (input) => request<CartQuote>('POST', '/me/cart/items', input),
  setLineQuantity: (lineId, quantity) =>
    request<CartQuote>('PATCH', `/me/cart/items/${lineId}`, { quantity }),
  clearCart: () => request<CartQuote>('DELETE', '/me/cart'),
  setFulfilment: (input) => request<CartQuote>('PUT', '/me/cart/fulfilment', input),
  applyPromo: (code) => request<CartQuote>('PUT', '/me/cart/promo', { code }),
  checkout: () => request<CheckoutResult>('POST', '/me/cart/checkout', {}, { timeoutMs: 45_000 }),
  orders: (cursor) =>
    request<Page<Order>>('GET', `/me/orders?limit=20${cursor ? `&cursor=${cursor}` : ''}`),
  order: (id) => request<OrderDetail>('GET', `/me/orders/${id}`),
  cancelOrder: async (id, reason) =>
    (await request<{ order: Order }>('POST', `/me/orders/${id}/cancel`, { reason })).order,
};
