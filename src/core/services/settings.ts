/**
 * Settings the business controls without a deploy. Every key has a Zod schema,
 * so a typo in the admin bot cannot write garbage, and every change is written
 * to settings_history and the audit log.
 */
import { z } from 'zod';

import { validation } from '../domain/errors.js';
import type { Actor, AuditRepository, Clock, SettingsRepository, Tx } from '../ports/index.js';

const time = z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM');
const dayRange = z.tuple([time, time]).nullable();

export const SETTING_SCHEMAS = {
  'brand.name': z.string().min(1).max(60),
  'brand.default_language': z.enum(['en', 'pcm']),
  'store.open': z.boolean(),
  'store.hours': z.object({
    timezone: z.literal('Africa/Lagos'),
    days: z.object({
      mon: dayRange,
      tue: dayRange,
      wed: dayRange,
      thu: dayRange,
      fri: dayRange,
      sat: dayRange,
      sun: dayRange,
    }),
  }),
  'store.busy_mode': z.object({
    enabled: z.boolean(),
    max_orders_per_15m: z.number().int().min(1).max(500),
    extra_eta_minutes: z.number().int().min(0).max(120),
  }),
  'store.default_prep_minutes': z.number().int().min(0).max(180),
  'orders.payment_timeout_minutes': z.number().int().min(5).max(120),
  'orders.daily_cap': z.number().int().min(0).max(100_000),
  'orders.max_unpaid_pending_per_customer': z.number().int().min(1).max(10),
  'orders.max_quantity_per_line': z.number().int().min(1).max(50),
  'payments.provider': z.enum(['paystack']),
  'payments.enabled': z.boolean(),
  'delivery.provider': z.enum(['manual', 'kwik', 'mock']),
  'delivery.enabled': z.boolean(),
  'delivery.pickup_enabled': z.boolean(),
  'support.hours': z.object({ timezone: z.literal('Africa/Lagos'), from: time, to: time }),
  'support.phone': z.string().max(20),
  'refunds.policy_text': z.string().max(1000),
  'fraud.max_orders_per_hour': z.number().int().min(1).max(100),
  'fraud.max_failed_payments_per_day': z.number().int().min(1).max(100),
  'inventory.low_stock_threshold_default': z.number().int().min(0).max(1000),
  'ai.enabled': z.boolean(),
  'privacy.policy_url': z.string().max(300),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_SCHEMAS)[K]>;
export const SETTING_KEYS = Object.keys(SETTING_SCHEMAS) as SettingKey[];

export const SETTING_DEFAULTS: { [K in SettingKey]: SettingValue<K> } = {
  'brand.name': 'Laurence Lab',
  'brand.default_language': 'en',
  'store.open': true,
  'store.hours': {
    timezone: 'Africa/Lagos',
    days: {
      mon: ['09:00', '21:00'],
      tue: ['09:00', '21:00'],
      wed: ['09:00', '21:00'],
      thu: ['09:00', '21:00'],
      fri: ['09:00', '21:00'],
      sat: ['09:00', '21:00'],
      sun: ['09:00', '21:00'],
    },
  },
  'store.busy_mode': { enabled: false, max_orders_per_15m: 20, extra_eta_minutes: 15 },
  'store.default_prep_minutes': 25,
  'orders.payment_timeout_minutes': 15,
  'orders.daily_cap': 50,
  'orders.max_unpaid_pending_per_customer': 2,
  'orders.max_quantity_per_line': 20,
  'payments.provider': 'paystack',
  'payments.enabled': true,
  'delivery.provider': 'manual',
  'delivery.enabled': true,
  'delivery.pickup_enabled': true,
  'support.hours': { timezone: 'Africa/Lagos', from: '09:00', to: '21:00' },
  'support.phone': '',
  'refunds.policy_text': '',
  'fraud.max_orders_per_hour': 5,
  'fraud.max_failed_payments_per_day': 5,
  'inventory.low_stock_threshold_default': 5,
  'ai.enabled': false,
  'privacy.policy_url': '',
};

type DayKey = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

/** Local wall-clock parts in Africa/Lagos (fixed UTC+1, no DST — but we still use Intl to be safe). */
export function lagosParts(date: Date): { day: DayKey; minutes: number } {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const day = (parts['weekday'] ?? 'Mon').slice(0, 3).toLowerCase() as DayKey;
  const hour = Number(parts['hour']) % 24;
  return { day, minutes: hour * 60 + Number(parts['minute']) };
}

export function isWithinHours(date: Date, hours: SettingValue<'store.hours'>): boolean {
  const { day, minutes } = lagosParts(date);
  const range = hours.days[day];
  if (!range) return false;
  const toMin = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const [from, to] = range.map(toMin) as [number, number];
  // Overnight ranges (e.g. 18:00–02:00) wrap past midnight.
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

export class SettingsService {
  constructor(
    private readonly repo: SettingsRepository,
    private readonly audit: AuditRepository,
    private readonly clock: Clock,
  ) {}

  async get<K extends SettingKey>(tx: Tx, key: K): Promise<SettingValue<K>> {
    const raw = await this.repo.get(tx, key);
    if (raw === undefined) return SETTING_DEFAULTS[key];
    const parsed = SETTING_SCHEMAS[key].safeParse(raw);
    // A stored value that no longer matches the schema (after a code change) falls back to
    // the default rather than crashing every request. It is logged by the caller's health check.
    return (parsed.success ? parsed.data : SETTING_DEFAULTS[key]) as SettingValue<K>;
  }

  async getAll(tx: Tx): Promise<{ [K in SettingKey]: SettingValue<K> }> {
    const stored = await this.repo.getAll(tx);
    const out = { ...SETTING_DEFAULTS };
    for (const key of SETTING_KEYS) {
      const raw = stored[key];
      if (raw === undefined) continue;
      const parsed = SETTING_SCHEMAS[key].safeParse(raw);
      if (parsed.success) (out as Record<string, unknown>)[key] = parsed.data;
    }
    return out;
  }

  async set<K extends SettingKey>(
    tx: Tx,
    key: K,
    value: unknown,
    actor: Actor,
  ): Promise<SettingValue<K>> {
    const schema = SETTING_SCHEMAS[key] as z.ZodType | undefined;
    if (!schema) throw validation(`unknown setting ${key}`);
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw validation(`invalid value for ${key}`, {
        issues: parsed.error.issues.map((i) => i.message),
      });
    }
    const { old } = await this.repo.set(tx, key, parsed.data, `${actor.type}:${actor.id}`);
    await this.audit.append(tx, {
      actor,
      action: 'setting.update',
      entityType: 'setting',
      entityId: key,
      before: old,
      after: parsed.data,
    });
    return parsed.data as SettingValue<K>;
  }

  /** Open toggle AND opening hours must both allow ordering. */
  async isOpenNow(tx: Tx): Promise<{ open: boolean; reason?: 'toggle' | 'hours' }> {
    if (!(await this.get(tx, 'store.open'))) return { open: false, reason: 'toggle' };
    const hours = await this.get(tx, 'store.hours');
    return isWithinHours(this.clock.now(), hours)
      ? { open: true }
      : { open: false, reason: 'hours' };
  }
}
