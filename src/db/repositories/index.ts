import { PgCartRepository } from './carts.js';
import { PgConversationRepository } from './conversations.js';
import { PgCustomerRepository } from './customers.js';
import { PgInventoryRepository } from './inventory.js';
import { PgMenuRepository, PgZoneRepository } from './menu.js';
import {
  PgAuditRepository,
  PgIdempotencyRepository,
  PgPromoRepository,
  PgSettingsRepository,
} from './misc.js';
import { PgOrderRepository } from './orders.js';
import { PgPaymentRepository } from './payments.js';

/** All repositories, instantiated once. They are stateless; the Tx carries the connection. */
export function createRepositories(): Repositories {
  return {
    customers: new PgCustomerRepository(),
    zones: new PgZoneRepository(),
    menu: new PgMenuRepository(),
    inventory: new PgInventoryRepository(),
    carts: new PgCartRepository(),
    orders: new PgOrderRepository(),
    payments: new PgPaymentRepository(),
    promos: new PgPromoRepository(),
    settings: new PgSettingsRepository(),
    audit: new PgAuditRepository(),
    idempotency: new PgIdempotencyRepository(),
    conversations: new PgConversationRepository(),
  };
}

export interface Repositories {
  customers: PgCustomerRepository;
  zones: PgZoneRepository;
  menu: PgMenuRepository;
  inventory: PgInventoryRepository;
  carts: PgCartRepository;
  orders: PgOrderRepository;
  payments: PgPaymentRepository;
  promos: PgPromoRepository;
  settings: PgSettingsRepository;
  audit: PgAuditRepository;
  idempotency: PgIdempotencyRepository;
  conversations: PgConversationRepository;
}
