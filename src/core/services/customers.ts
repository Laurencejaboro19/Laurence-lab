import type { Channel, GeoPoint } from '../channel/types.js';
import { DomainError, forbidden, notFound, validation } from '../domain/errors.js';
import { findZone, isValidPoint } from '../domain/geo.js';
import type {
  Actor,
  Address,
  AuditRepository,
  ChannelIdentity,
  Customer,
  CustomerRepository,
  Tx,
  ZoneRepository,
} from '../ports/index.js';

function nonEmpty(s: string | undefined): string | undefined {
  const t = s?.trim();
  return t === undefined || t === '' ? undefined : t;
}

/** Normalise Nigerian numbers to E.164 digits: 0803… → 234803…, +234… → 234… */
export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  let d = digits.startsWith('+') ? digits.slice(1) : digits;
  if (d.startsWith('0') && d.length === 11) d = `234${d.slice(1)}`;
  if (d.startsWith('234') && d.length === 13) return d;
  // Other countries: accept 8–15 digits as given.
  if (/^[1-9]\d{7,14}$/.test(d)) return d;
  return null;
}

export class CustomerService {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly zones: ZoneRepository,
    private readonly audit: AuditRepository,
  ) {}

  /** Idempotent: the chat adapter calls this on every inbound event. */
  async identify(
    tx: Tx,
    input: {
      channel: Channel;
      externalUserId: string;
      externalChatId: string;
      displayName?: string;
      handle?: string;
      languageHint?: string;
    },
  ): Promise<{ customer: Customer; identity: ChannelIdentity; isNew: boolean }> {
    const existing = await this.customers.findIdentity(tx, input.channel, input.externalUserId);
    if (existing) {
      const customer = await this.customers.findById(tx, existing.customerId);
      if (!customer) throw notFound('customer', existing.customerId);
      return { customer, identity: existing, isNew: false };
    }
    const language = input.languageHint === 'pcm' ? 'pcm' : 'en';
    const created = await this.customers.createWithIdentity(tx, {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      language,
      identity: {
        channel: input.channel,
        externalUserId: input.externalUserId,
        externalChatId: input.externalChatId,
        handle: input.handle ?? null,
      },
    });
    await this.audit.append(tx, {
      actor: { type: 'customer', id: created.customer.id },
      action: 'customer.create',
      entityType: 'customer',
      entityId: created.customer.id,
      after: { channel: input.channel },
    });
    return { ...created, isNew: true };
  }

  async get(tx: Tx, actor: Actor, customerId: string): Promise<Customer> {
    this.assertCanAccess(actor, customerId);
    const c = await this.customers.findById(tx, customerId);
    if (!c) throw notFound('customer', customerId);
    return c;
  }

  /**
   * Records a phone number. If another customer already owns it (same person on the
   * other channel), we do NOT merge silently: the caller gets a CONFLICT with the
   * other customer id so the conversation can run an explicit confirmation step.
   */
  async setPhone(
    tx: Tx,
    actor: Actor,
    customerId: string,
    rawPhone: string,
    verified: boolean,
  ): Promise<Customer> {
    this.assertCanAccess(actor, customerId);
    const phone = normalisePhone(rawPhone);
    if (!phone) throw validation('that does not look like a valid phone number');
    const owner = await this.customers.findByPhone(tx, phone);
    if (owner && owner.id !== customerId) {
      throw new DomainError('CONFLICT', 'phone number already linked to another account', {
        code: 'PHONE_LINKED_ELSEWHERE',
        otherCustomerId: owner.id,
      });
    }
    const updated = await this.customers.update(tx, customerId, {
      phoneE164: phone,
      phoneVerifiedAt: verified ? new Date() : null,
    });
    await this.audit.append(tx, {
      actor,
      action: 'customer.phone',
      entityType: 'customer',
      entityId: customerId,
      after: { verified, last4: phone.slice(-4) },
    });
    return updated;
  }

  async setLanguage(
    tx: Tx,
    actor: Actor,
    customerId: string,
    language: 'en' | 'pcm',
  ): Promise<Customer> {
    this.assertCanAccess(actor, customerId);
    return this.customers.update(tx, customerId, { language });
  }

  async listAddresses(tx: Tx, actor: Actor, customerId: string): Promise<Address[]> {
    this.assertCanAccess(actor, customerId);
    return this.customers.listAddresses(tx, customerId);
  }

  /**
   * Adds an address from a pin and/or text and resolves its zone. A pin outside every
   * active zone is rejected with OUTSIDE_DELIVERY_AREA so the customer learns early,
   * before building a cart.
   */
  async addAddress(
    tx: Tx,
    actor: Actor,
    customerId: string,
    input: { label?: string; textAddress?: string; point?: GeoPoint; makeDefault?: boolean },
  ): Promise<Address & { zoneName: string | null }> {
    this.assertCanAccess(actor, customerId);
    if (!input.point && !input.textAddress?.trim())
      throw validation('share a location pin or type an address');
    if (input.point && !isValidPoint(input.point)) throw validation('invalid coordinates');
    let zoneId: string | null = null;
    let zoneName: string | null = null;
    if (input.point) {
      const zone = findZone(input.point, await this.zones.listActive(tx));
      if (!zone) {
        throw new DomainError('OUTSIDE_DELIVERY_AREA', 'we do not deliver to that location yet');
      }
      zoneId = zone.id;
      zoneName = zone.name;
    }
    const existing = await this.customers.listAddresses(tx, customerId);
    const address = await this.customers.addAddress(tx, {
      customerId,
      label: nonEmpty(input.label) ?? `Address ${existing.length + 1}`,
      textAddress: nonEmpty(input.textAddress) ?? null,
      point: input.point ?? null,
      zoneId,
      isDefault: input.makeDefault ?? existing.length === 0,
    });
    return { ...address, zoneName };
  }

  async deleteAddress(tx: Tx, actor: Actor, customerId: string, addressId: string): Promise<void> {
    this.assertCanAccess(actor, customerId);
    const ok = await this.customers.deleteAddress(tx, customerId, addressId);
    if (!ok) throw notFound('address', addressId);
  }

  /** NDPA: everything we hold about the person, as JSON they can keep. */
  async exportData(tx: Tx, actor: Actor, customerId: string): Promise<Record<string, unknown>> {
    this.assertCanAccess(actor, customerId);
    const customer = await this.customers.findById(tx, customerId);
    if (!customer) throw notFound('customer', customerId);
    return {
      customer,
      identities: (await this.customers.identitiesOf(tx, customerId)).map((i) => ({
        channel: i.channel,
        handle: i.handle,
      })),
      addresses: await this.customers.listAddresses(tx, customerId),
      exportedAt: new Date().toISOString(),
    };
  }

  /** NDPA deletion: anonymise PII, keep financial records. Irreversible. */
  async deleteData(tx: Tx, actor: Actor, customerId: string): Promise<void> {
    this.assertCanAccess(actor, customerId);
    await this.customers.anonymise(tx, customerId);
    await this.audit.append(tx, {
      actor,
      action: 'customer.anonymise',
      entityType: 'customer',
      entityId: customerId,
    });
  }

  // REVIEW: the IDOR guard for everything customer-scoped. Customers may only touch
  // their own id; staff and system may touch any. Tested in test/core/idor.test.ts.
  private assertCanAccess(actor: Actor, customerId: string): void {
    if (actor.type === 'customer' && actor.id !== customerId) {
      throw forbidden('you can only access your own account');
    }
  }
}
