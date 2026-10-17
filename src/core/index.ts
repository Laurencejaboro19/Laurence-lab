/**
 * Composition root for the core. Everything the HTTP layer, the chat adapters
 * and the jobs need is created here from ports — no I/O library is imported.
 */
import type {
  AuditRepository,
  CartRepository,
  Clock,
  CustomerRepository,
  EventBus,
  IdempotencyRepository,
  InventoryRepository,
  MenuRepository,
  OrderRepository,
  PaymentGateway,
  PaymentRepository,
  PromoRepository,
  SettingsRepository,
  UnitOfWork,
  ZoneRepository,
} from './ports/index.js';
import { systemClock } from './ports/index.js';
import { CartService } from './services/cart.js';
import { CatalogService } from './services/catalog.js';
import { CustomerService } from './services/customers.js';
import { OrderService } from './services/orders.js';
import { PaymentService } from './services/payments.js';
import { SettingsService } from './services/settings.js';

export interface CoreRepositories {
  customers: CustomerRepository;
  zones: ZoneRepository;
  menu: MenuRepository;
  inventory: InventoryRepository;
  carts: CartRepository;
  orders: OrderRepository;
  payments: PaymentRepository;
  promos: PromoRepository;
  settings: SettingsRepository;
  audit: AuditRepository;
  idempotency: IdempotencyRepository;
}

export interface CoreDeps {
  uow: UnitOfWork;
  repos: CoreRepositories;
  gateway: PaymentGateway;
  events: EventBus;
  clock?: Clock;
}

export interface Core {
  uow: UnitOfWork;
  repos: CoreRepositories;
  events: EventBus;
  clock: Clock;
  settings: SettingsService;
  customers: CustomerService;
  catalog: CatalogService;
  cart: CartService;
  orders: OrderService;
  payments: PaymentService;
}

export function createCore(deps: CoreDeps): Core {
  const clock = deps.clock ?? systemClock;
  const { repos } = deps;
  const settings = new SettingsService(repos.settings, repos.audit, clock);
  const customers = new CustomerService(repos.customers, repos.zones, repos.audit);
  const catalog = new CatalogService(repos.menu, repos.inventory, repos.audit, deps.events);
  const cart = new CartService(
    repos.carts,
    repos.menu,
    repos.customers,
    repos.zones,
    repos.promos,
    settings,
  );
  const orders = new OrderService(
    deps.uow,
    repos.orders,
    repos.payments,
    repos.inventory,
    repos.customers,
    repos.promos,
    cart,
    settings,
    deps.gateway,
    repos.audit,
    deps.events,
    clock,
  );
  const payments = new PaymentService(
    deps.uow,
    repos.payments,
    repos.orders,
    orders,
    deps.gateway,
    repos.audit,
    deps.events,
    clock,
  );
  return {
    uow: deps.uow,
    repos,
    events: deps.events,
    clock,
    settings,
    customers,
    catalog,
    cart,
    orders,
    payments,
  };
}
