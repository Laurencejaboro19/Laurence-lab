/**
 * Channel adapter contract.
 *
 * The core never sees a Telegram Update or a WhatsApp webhook payload. Each
 * platform adapter converts its native events into exactly one `InboundEvent`
 * and renders `OutboundMessage`s into native API calls. Everything in this file
 * is deliberately platform-neutral and sized to the *strictest* platform
 * (WhatsApp: 3 reply buttons, 10 list rows) so the core can never ask an adapter
 * for something it cannot deliver. See docs/ARCHITECTURE.md §3.
 */

export type Channel = 'telegram' | 'whatsapp';

/** Who sent the event, in platform-neutral terms. */
export interface ChannelIdentity {
  channel: Channel;
  /** Telegram user id or WhatsApp phone number (E.164, no plus). Opaque to the core. */
  externalUserId: string;
  /** Where replies go. Telegram chat id; WhatsApp phone number. */
  externalChatId: string;
  displayName?: string;
  /** Telegram @username or similar, if the platform exposes one. */
  handle?: string;
  /** ISO 639-1 language hint from the platform, if any. */
  languageHint?: string;
}

/** Geographic point. Used for delivery pins and zone checks. */
export interface GeoPoint {
  latitude: number;
  longitude: number;
}

/**
 * One normalised inbound event. `platformEventId` must be unique per channel
 * (Telegram update_id, WhatsApp message id) — the core dedupes on
 * `${channel}:${platformEventId}`.
 */
export type InboundEvent =
  | InboundText
  | InboundCommand
  | InboundButton
  | InboundLocation
  | InboundContact
  | InboundMedia
  | InboundUnsupported
  | InboundDeliveryStatus;

interface InboundBase {
  channel: Channel;
  platformEventId: string;
  identity: ChannelIdentity;
  /** When the platform says the user sent it. */
  occurredAt: Date;
  /** Chat kind. The core politely declines anything that is not a private chat. */
  chatKind: 'private' | 'group' | 'channel' | 'unknown';
  /** True when the platform marks the message as forwarded or edited. */
  forwarded?: boolean;
  edited?: boolean;
}

export interface InboundText extends InboundBase {
  kind: 'text';
  text: string;
}

/** A slash command (Telegram) or a reserved keyword the adapter maps to one (WhatsApp "menu"). */
export interface InboundCommand extends InboundBase {
  kind: 'command';
  /** Lower-case, without the leading slash: "start", "menu", "privacy", ... */
  command: string;
  /** Deep-link payload, e.g. a promo or referral code after /start. */
  payload?: string;
}

/**
 * The user tapped a button we rendered. `actionId` is the short opaque id we
 * put in the button (≤ 32 bytes so it fits Telegram's 64-byte callback budget
 * with a nonce); `messageRef` lets the core ask the adapter to edit that message.
 */
export interface InboundButton extends InboundBase {
  kind: 'button';
  actionId: string;
  messageRef?: MessageRef;
  /** The visible label, for logging and for stale-button messages. */
  label?: string;
}

export interface InboundLocation extends InboundBase {
  kind: 'location';
  point: GeoPoint;
  /** Human address string if the platform supplied one (WhatsApp sometimes does). */
  address?: string;
}

export interface InboundContact extends InboundBase {
  kind: 'contact';
  /** E.164 digits only, normalised by the adapter (e.g. 2348059827250). */
  phoneE164: string;
  /** Whether the shared contact is the sender themselves (Telegram tells us). */
  isSelf: boolean;
  name?: string;
}

export interface InboundMedia extends InboundBase {
  kind: 'media';
  mediaKind: 'image' | 'audio' | 'video' | 'document' | 'sticker';
  /** Platform file id; the adapter can fetch it through the authenticated media endpoint. */
  mediaRef: string;
  caption?: string;
}

export interface InboundUnsupported extends InboundBase {
  kind: 'unsupported';
  /** What the platform sent, for the "I can't read that" reply and for logs. */
  description: string;
}

/** WhatsApp delivery receipts (sent/delivered/read/failed). Telegram has none. */
export interface InboundDeliveryStatus extends InboundBase {
  kind: 'delivery_status';
  /** Our outbound message id the receipt refers to. */
  messageRef: MessageRef;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  errorCode?: string;
  errorDetail?: string;
}

/** Platform handle for a message we sent, so we can edit or reference it. */
export interface MessageRef {
  channel: Channel;
  externalChatId: string;
  externalMessageId: string;
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/**
 * Text is plain. Adapters escape for their own parse mode; the core never
 * emits Markdown or HTML. Light emphasis is expressed structurally.
 */
export interface RichText {
  text: string;
  /** Optional spans the adapter may render in bold where supported. */
  bold?: readonly string[];
}

/** A tappable choice. `actionId` comes back verbatim in `InboundButton`. */
export interface Choice {
  /** ≤ 20 chars (WhatsApp reply-button title limit), enforced by adapters with truncation + log. */
  label: string;
  actionId: string;
}

/** A row in a paginated list (menu items, saved addresses, past orders). */
export interface ListRow {
  /** ≤ 24 chars on WhatsApp list rows. */
  title: string;
  /** ≤ 72 chars on WhatsApp list rows. */
  description?: string;
  actionId: string;
}

export type OutboundMessage =
  | OutboundText
  | OutboundButtons
  | OutboundQuickReplies
  | OutboundList
  | OutboundUrlButton
  | OutboundLocationRequest
  | OutboundContactRequest
  | OutboundImage
  | OutboundEdit
  | OutboundTyping;

export interface OutboundText {
  kind: 'text';
  body: RichText;
}

/**
 * Up to three primary choices. Three is the WhatsApp reply-button ceiling; the
 * core must use `list` for anything bigger. Adapters MAY add a fourth "Back"
 * where the platform allows it, but the core never relies on that.
 */
export interface OutboundButtons {
  kind: 'buttons';
  body: RichText;
  choices: readonly [Choice] | readonly [Choice, Choice] | readonly [Choice, Choice, Choice];
  /** If set, replace this earlier message instead of sending a new one (Telegram edits in place). */
  replaces?: MessageRef;
}

/** Persistent shortcuts (Menu, Cart, Track, Help). Telegram: reply keyboard. WhatsApp: a list. */
export interface OutboundQuickReplies {
  kind: 'quick_replies';
  body: RichText;
  choices: readonly Choice[];
}

/**
 * A page of a longer list. `page`/`pageCount` let the adapter draw "‹ 2/5 ›"
 * controls; `nextActionId`/`prevActionId` are what those controls send back.
 * Rows per page ≤ 10 (WhatsApp list ceiling); the core's paginator enforces it.
 */
export interface OutboundList {
  kind: 'list';
  body: RichText;
  /** Button label that opens the list on WhatsApp (≤ 20 chars). Ignored on Telegram. */
  openLabel: string;
  sectionTitle?: string;
  rows: readonly ListRow[];
  page: number;
  pageCount: number;
  nextActionId?: string;
  prevActionId?: string;
  replaces?: MessageRef;
}

/** The Paystack checkout link. Telegram: URL button. WhatsApp: CTA-URL message, plain-link fallback. */
export interface OutboundUrlButton {
  kind: 'url_button';
  body: RichText;
  label: string;
  url: string;
}

export interface OutboundLocationRequest {
  kind: 'location_request';
  body: RichText;
  /** Optional typed-address alternative the user can tap instead of sharing a pin. */
  typedAlternative?: Choice;
}

export interface OutboundContactRequest {
  kind: 'contact_request';
  body: RichText;
}

export interface OutboundImage {
  kind: 'image';
  /** Platform-specific media reference or an https URL. Adapters resolve it. */
  imageRef: string;
  caption?: RichText;
  choices?: readonly Choice[];
}

/** Edit a message we sent earlier to plain text (e.g. "✓ Order confirmed" replacing buttons). */
export interface OutboundEdit {
  kind: 'edit';
  target: MessageRef;
  body: RichText;
}

/** Typing indicator / mark-as-read where the platform supports it. Harmless elsewhere. */
export interface OutboundTyping {
  kind: 'typing';
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface SendResult {
  ok: boolean;
  messageRef?: MessageRef;
  /** Platform said the user blocked us / is unreachable. Core marks the identity unreachable. */
  unreachable?: boolean;
  /** Platform asked us to back off for this many milliseconds (Telegram 429 retry_after). */
  retryAfterMs?: number;
  error?: string;
}

/**
 * Implemented once per platform. `normalise` must be pure (no I/O) so it is
 * trivially unit-tested with recorded payloads. `send` is the only method that
 * talks to the network, and it is called from the rate-limited outbound queue,
 * never directly from request handlers.
 */
export interface ChannelAdapter {
  readonly channel: Channel;
  /** Convert a raw platform payload into zero or more events (one webhook body may carry several). */
  normalise(rawPayload: unknown): InboundEvent[];
  /** Render and deliver one message. Must never throw for user-caused failures; return SendResult. */
  send(identity: ChannelIdentity, message: OutboundMessage): Promise<SendResult>;
  /** Answer a button tap so the client stops its spinner (Telegram requires this; WhatsApp no-op). */
  acknowledgeButton?(event: InboundButton): Promise<void>;
}

/** Hard limits every adapter must respect; the core's paginator uses the same numbers. */
export const CHANNEL_LIMITS = {
  /** WhatsApp reply buttons; Telegram allows more but the core never exceeds this. */
  maxPrimaryChoices: 3,
  /** WhatsApp list rows per message. */
  maxListRows: 10,
  /** WhatsApp reply-button / list-button title. */
  maxChoiceLabelChars: 20,
  /** WhatsApp list row title. */
  maxListRowTitleChars: 24,
  /** WhatsApp list row description. */
  maxListRowDescriptionChars: 72,
  /** Telegram callback_data budget in bytes; actionId + nonce must fit. */
  telegramCallbackDataBytes: 64,
  /** Keep bodies short for cheap phones and patchy data. Telegram max is 4096, WhatsApp 4096 (interactive body 1024). */
  maxBodyChars: 1024,
} as const;

/** Build the dedupe key the core stores for every inbound event. */
export function inboundEventKey(event: Pick<InboundEvent, 'channel' | 'platformEventId'>): string {
  return `${event.channel}:${event.platformEventId}`;
}
