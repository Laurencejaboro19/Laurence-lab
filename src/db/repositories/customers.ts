import type { Channel } from '../../core/channel/types.js';
import { notFound } from '../../core/domain/errors.js';
import type {
  Address,
  ChannelIdentity,
  Customer,
  CustomerRepository,
  Tx,
} from '../../core/ports/index.js';
import { pgOf } from '../client.js';

interface CustomerRow {
  id: string;
  display_name: string | null;
  phone_e164: string | null;
  phone_verified_at: Date | null;
  language: 'en' | 'pcm';
  order_count: number;
  blocked_until: Date | null;
  anonymised_at: Date | null;
}

interface IdentityRow {
  id: string;
  customer_id: string;
  channel: Channel;
  external_user_id: string;
  external_chat_id: string;
  handle: string | null;
  unreachable_at: Date | null;
}

interface AddressRow {
  id: string;
  customer_id: string;
  label: string;
  text_address: string | null;
  latitude: number | null;
  longitude: number | null;
  zone_id: string | null;
  is_default: boolean;
}

const customerOf = (r: CustomerRow): Customer => ({
  id: r.id,
  displayName: r.display_name,
  phoneE164: r.phone_e164,
  phoneVerifiedAt: r.phone_verified_at,
  language: r.language,
  orderCount: r.order_count,
  blockedUntil: r.blocked_until,
  anonymisedAt: r.anonymised_at,
});

const identityOf = (r: IdentityRow): ChannelIdentity => ({
  id: r.id,
  customerId: r.customer_id,
  channel: r.channel,
  externalUserId: r.external_user_id,
  externalChatId: r.external_chat_id,
  handle: r.handle,
  unreachableAt: r.unreachable_at,
});

const addressOf = (r: AddressRow): Address => ({
  id: r.id,
  customerId: r.customer_id,
  label: r.label,
  textAddress: r.text_address,
  point:
    r.latitude !== null && r.longitude !== null
      ? { latitude: r.latitude, longitude: r.longitude }
      : null,
  zoneId: r.zone_id,
  isDefault: r.is_default,
});

const CUSTOMER_COLS =
  'id, display_name, phone_e164, phone_verified_at, language, order_count, blocked_until, anonymised_at';
const IDENTITY_COLS =
  'id, customer_id, channel, external_user_id, external_chat_id, handle, unreachable_at';
const ADDRESS_COLS =
  'id, customer_id, label, text_address, latitude, longitude, zone_id, is_default';

export class PgCustomerRepository implements CustomerRepository {
  async findById(tx: Tx, id: string): Promise<Customer | null> {
    const r = await pgOf(tx).query<CustomerRow>(
      `SELECT ${CUSTOMER_COLS} FROM app.customers WHERE id = $1`,
      [id],
    );
    return r.rows[0] ? customerOf(r.rows[0]) : null;
  }

  async findByPhone(tx: Tx, phoneE164: string): Promise<Customer | null> {
    const r = await pgOf(tx).query<CustomerRow>(
      `SELECT ${CUSTOMER_COLS} FROM app.customers WHERE phone_e164 = $1`,
      [phoneE164],
    );
    return r.rows[0] ? customerOf(r.rows[0]) : null;
  }

  async findIdentity(
    tx: Tx,
    channel: Channel,
    externalUserId: string,
  ): Promise<ChannelIdentity | null> {
    const r = await pgOf(tx).query<IdentityRow>(
      `SELECT ${IDENTITY_COLS} FROM app.channel_identities WHERE channel = $1 AND external_user_id = $2`,
      [channel, externalUserId],
    );
    return r.rows[0] ? identityOf(r.rows[0]) : null;
  }

  async createWithIdentity(
    tx: Tx,
    input: {
      displayName?: string;
      language?: 'en' | 'pcm';
      identity: Omit<ChannelIdentity, 'id' | 'customerId' | 'unreachableAt'>;
    },
  ): Promise<{ customer: Customer; identity: ChannelIdentity }> {
    const c = await pgOf(tx).query<CustomerRow>(
      `INSERT INTO app.customers (display_name, language) VALUES ($1, $2) RETURNING ${CUSTOMER_COLS}`,
      [input.displayName ?? null, input.language ?? 'en'],
    );
    const customer = customerOf(c.rows[0]!);
    const i = await pgOf(tx).query<IdentityRow>(
      `INSERT INTO app.channel_identities (customer_id, channel, external_user_id, external_chat_id, handle, last_inbound_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING ${IDENTITY_COLS}`,
      [
        customer.id,
        input.identity.channel,
        input.identity.externalUserId,
        input.identity.externalChatId,
        input.identity.handle,
      ],
    );
    await pgOf(tx).query(
      `INSERT INTO app.conversations (channel_identity_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [i.rows[0]!.id],
    );
    return { customer, identity: identityOf(i.rows[0]!) };
  }

  async update(
    tx: Tx,
    id: string,
    patch: Partial<
      Pick<Customer, 'displayName' | 'phoneE164' | 'phoneVerifiedAt' | 'language' | 'blockedUntil'>
    >,
  ): Promise<Customer> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (col: string, v: unknown): void => {
      values.push(v);
      sets.push(`${col} = $${values.length}`);
    };
    if (patch.displayName !== undefined) push('display_name', patch.displayName);
    if (patch.phoneE164 !== undefined) push('phone_e164', patch.phoneE164);
    if (patch.phoneVerifiedAt !== undefined) push('phone_verified_at', patch.phoneVerifiedAt);
    if (patch.language !== undefined) push('language', patch.language);
    if (patch.blockedUntil !== undefined) push('blocked_until', patch.blockedUntil);
    if (sets.length === 0) {
      const existing = await this.findById(tx, id);
      if (!existing) throw notFound('customer', id);
      return existing;
    }
    values.push(id);
    const r = await pgOf(tx).query<CustomerRow>(
      `UPDATE app.customers SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING ${CUSTOMER_COLS}`,
      values,
    );
    if (!r.rows[0]) throw notFound('customer', id);
    return customerOf(r.rows[0]);
  }

  async incrementOrderCount(tx: Tx, id: string, at: Date): Promise<void> {
    await pgOf(tx).query(
      `UPDATE app.customers SET order_count = order_count + 1,
         first_order_at = coalesce(first_order_at, $2) WHERE id = $1`,
      [id, at],
    );
  }

  /** NDPA deletion: strip PII, keep the row so orders and payments stay consistent. */
  async anonymise(tx: Tx, id: string): Promise<void> {
    const client = pgOf(tx);
    await client.query(
      `UPDATE app.customers SET display_name = NULL, phone_e164 = NULL, phone_verified_at = NULL,
         anonymised_at = now() WHERE id = $1`,
      [id],
    );
    await client.query(
      `UPDATE app.addresses SET deleted_at = now(), text_address = '[deleted]',
         latitude = NULL, longitude = NULL WHERE customer_id = $1`,
      [id],
    );
    await client.query(
      `UPDATE app.channel_identities SET handle = NULL, external_chat_id = '0',
         external_user_id = 'deleted:' || id::text WHERE customer_id = $1`,
      [id],
    );
    await client.query(
      `DELETE FROM app.messages WHERE channel_identity_id IN
         (SELECT id FROM app.channel_identities WHERE customer_id = $1)`,
      [id],
    );
  }

  async listAddresses(tx: Tx, customerId: string): Promise<Address[]> {
    const r = await pgOf(tx).query<AddressRow>(
      `SELECT ${ADDRESS_COLS} FROM app.addresses WHERE customer_id = $1 AND deleted_at IS NULL
       ORDER BY is_default DESC, created_at`,
      [customerId],
    );
    return r.rows.map(addressOf);
  }

  async findAddress(tx: Tx, customerId: string, addressId: string): Promise<Address | null> {
    // REVIEW: customer_id in the WHERE clause is the IDOR guard — never drop it.
    const r = await pgOf(tx).query<AddressRow>(
      `SELECT ${ADDRESS_COLS} FROM app.addresses WHERE id = $1 AND customer_id = $2 AND deleted_at IS NULL`,
      [addressId, customerId],
    );
    return r.rows[0] ? addressOf(r.rows[0]) : null;
  }

  async addAddress(tx: Tx, input: Omit<Address, 'id'>): Promise<Address> {
    const client = pgOf(tx);
    if (input.isDefault) {
      await client.query(`UPDATE app.addresses SET is_default = false WHERE customer_id = $1`, [
        input.customerId,
      ]);
    }
    const r = await client.query<AddressRow>(
      `INSERT INTO app.addresses (customer_id, label, text_address, latitude, longitude, zone_id, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${ADDRESS_COLS}`,
      [
        input.customerId,
        input.label,
        input.textAddress,
        input.point?.latitude ?? null,
        input.point?.longitude ?? null,
        input.zoneId,
        input.isDefault,
      ],
    );
    return addressOf(r.rows[0]!);
  }

  async deleteAddress(tx: Tx, customerId: string, addressId: string): Promise<boolean> {
    const r = await pgOf(tx).query(
      `UPDATE app.addresses SET deleted_at = now(), is_default = false
       WHERE id = $1 AND customer_id = $2 AND deleted_at IS NULL`,
      [addressId, customerId],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async identitiesOf(tx: Tx, customerId: string): Promise<ChannelIdentity[]> {
    const r = await pgOf(tx).query<IdentityRow>(
      `SELECT ${IDENTITY_COLS} FROM app.channel_identities WHERE customer_id = $1`,
      [customerId],
    );
    return r.rows.map(identityOf);
  }
}
