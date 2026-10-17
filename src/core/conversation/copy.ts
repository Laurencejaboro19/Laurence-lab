/**
 * Every customer-facing string, in English and Nigerian Pidgin. Short on
 * purpose: cheap phones, patchy data. Variables are {name}. No Markdown/HTML —
 * adapters escape and format for their platform.
 */
export type Lang = 'en' | 'pcm';

const en = {
  welcome:
    'Welcome to {brand}! 🍔\nFresh food, delivered to your door in Benin City.\n\nFirst, pick your language.',
  pick_language: 'Choose a language',
  lang_en: 'English',
  lang_pcm: 'Pidgin',
  language_set: 'Language set to English.',
  privacy_short:
    'We keep your phone and delivery address only to fulfil orders. You can export or delete your data any time with /privacy and /delete_my_data.',
  ask_phone:
    'What phone number can the rider reach you on?\nTap the button to share your number, or type it.',
  share_phone: '📱 Share my number',
  phone_invalid: 'That does not look like a Nigerian number. Try 0803 123 4567.',
  phone_saved: 'Thanks! Your number is saved.',
  phone_linked_elsewhere:
    'That number is already on another account with us. Reply YES to link this chat to it, or send a different number.',
  main_hint:
    'What would you like to do?\nYou can also just type your order, e.g. "2 jollof and 1 chicken".',
  qr_menu: '🍽 Menu',
  qr_cart: '🛒 Cart',
  qr_track: '📦 Track',
  qr_help: '❓ Help',
  menu_title: 'Our menu 🍽\nPick a category:',
  menu_empty: 'The menu is empty right now. Please check back soon.',
  category_items: '{category}',
  open_list: 'See items',
  item_detail: '{name} — {price}\n{description}',
  item_sold_out: 'Sold out',
  add_one: 'Add 1',
  add_two: 'Add 2',
  add_three: 'Add 3',
  back_to_menu: '◀️ Menu',
  added: 'Added {qty} × {name} to your cart.',
  cart_title: 'Your cart 🛒',
  cart_empty: 'Your cart is empty. Tap Menu or type what you want.',
  cart_line: '{qty} × {name} — {total}',
  cart_subtotal: 'Subtotal: {subtotal}',
  cart_delivery: 'Delivery: {fee}',
  cart_discount: 'Discount: −{discount}',
  cart_total: 'Total: {total}',
  cart_problem: '⚠️ {problem}',
  checkout: '✅ Checkout',
  clear_cart: '🗑 Clear',
  cart_cleared: 'Cart cleared.',
  ask_fulfilment: 'Delivery or pickup?',
  delivery: '🛵 Delivery',
  pickup: '🏪 Pickup',
  ask_address: 'Where should we deliver?',
  share_location: '📍 Share my location',
  type_address: '✍️ Type an address',
  saved_address: '📌 {label}',
  new_address: '➕ New address',
  ask_address_text: 'Type the delivery address (street, landmark, area):',
  ask_zone: 'Which area is that in?',
  outside_area: 'Sorry, we do not deliver to that location yet. We cover: {zones}.',
  address_saved: 'Saved: {label} ({zone}).',
  confirm_order:
    'Order summary\n\n{lines}\n\n{subtotal}\n{delivery}{discount}\n{total}\n\n{fulfilment}\nETA about {eta} min.',
  pay_now: 'Pay {total}',
  payment_sent:
    'Tap the button to pay securely with Paystack (card, transfer or USSD).\nThis link expires in {minutes} minutes.\nOrder {ref}.',
  cancel_order: '✖️ Cancel order',
  order_cancelled: 'Order {ref} cancelled.',
  cannot_cancel: 'This order can no longer be cancelled from here. Message support with /help.',
  store_closed: 'We are closed right now. Opening hours: 9am–9pm daily.',
  busy: 'The kitchen is very busy right now. Please try again in a few minutes.',
  paid: '💚 Payment received! Order {ref} is with the kitchen. We will tell you at every step.',
  accepted: '👩‍🍳 The kitchen has accepted order {ref}. ETA about {eta} min.',
  preparing: '🔥 Order {ref} is being prepared.',
  ready: '✅ Order {ref} is ready.',
  ready_pickup: '✅ Order {ref} is ready for pickup.',
  dispatched: '🛵 Order {ref} is on the way!',
  dispatched_rider: '🛵 Order {ref} is on the way with {rider} ({phone}).',
  delivered: '🎉 Order {ref} delivered. Enjoy your meal! Reply with any feedback.',
  rejected: '😔 We could not take order {ref}: {reason}. A full refund is on its way.',
  cancelled_notice: 'Order {ref} was cancelled. {refund}',
  expired: '⌛ Order {ref} expired because payment was not completed. Tap Menu to order again.',
  refunded:
    '💸 A refund of {amount} for order {ref} has been sent to your card/bank. It can take 5–7 working days.',
  partially_refunded: '💸 A partial refund of {amount} for order {ref} has been sent.',
  track_title: 'Your recent orders:',
  track_none: 'No orders yet. Tap Menu to place your first one!',
  order_line: '{ref} · {status} · {total}',
  order_detail: 'Order {ref}\n{lines}\nTotal: {total}\nStatus: {status}\nPlaced: {placed}',
  reorder: '🔁 Reorder',
  reordered: 'Added your previous order to the cart.',
  parsed_confirm: 'Add these to your cart?\n{lines}',
  parsed_unmatched: "I couldn't find: {items}. Tap Menu to see what we have.",
  yes: '✅ Yes',
  no: '❌ No',
  help: 'How it works:\n• Tap Menu or type your order\n• Pay securely with Paystack\n• Track every step here\n\nCommands: /menu /cart /track /orders /language /privacy\nSupport: {support}',
  support_default: 'reply here and a human will join',
  privacy_full:
    'Your data: phone number, saved addresses, orders and chat messages (kept 90 days).\nWe use them only to fulfil and support your orders.\n/export_my_data sends you a copy. /delete_my_data removes your personal details (financial records are kept as the law requires).',
  delete_confirm:
    'Delete your personal data? Your saved addresses and phone will be removed and this chat will start fresh. This cannot be undone.',
  deleted:
    'Done. Your personal data has been removed. Send /start whenever you want to order again.',
  export_sent: 'Here is everything we hold about you:',
  stale_button: 'That menu has expired. Here is a fresh one.',
  group_decline: 'I only take orders in a private chat. Message me directly!',
  unsupported: "I can't read that kind of message yet. Please type your order or tap Menu.",
  unknown: 'Sorry, I didn\'t get that. Tap Menu, or type your order like "2 jollof and 1 chicken".',
  cancel_flow: 'Cancelled. What next?',
  error_generic: 'Something went wrong on our side. Please try again in a moment.',
  need_phone_first: 'We need a phone number for the rider first.',
  min_order: 'The minimum order for your area is {min}.',
  out_of_stock: 'Sorry, {names} just sold out. Please adjust your cart.',
  unpaid_pending: 'You already have an unpaid order. Pay or cancel it first (tap Track).',
  rate_limited: 'Too many orders in a short time. Please wait a little.',
} as const;

export type CopyKey = keyof typeof en;

const pcm: Record<CopyKey, string> = {
  ...en,
  welcome:
    'Welcome to {brand}! 🍔\nCorrect food, we go bring am reach your door for Benin.\n\nFirst, choose your language.',
  pick_language: 'Choose language',
  language_set: 'Oya, Pidgin e be.',
  privacy_short:
    'We dey keep your phone and address only to deliver your order. You fit collect or delete your data anytime with /privacy and /delete_my_data.',
  ask_phone: 'Which number rider go fit call you?\nPress the button to share am, or type am.',
  share_phone: '📱 Share my number',
  phone_invalid: 'That number no correct. Try 0803 123 4567.',
  phone_saved: 'Thank you! We don save your number.',
  phone_linked_elsewhere:
    'This number dey another account already. Reply YES make we join this chat to am, or send another number.',
  main_hint: 'Wetin you wan do?\nYou fit just type your order, like "2 jollof and 1 chicken".',
  menu_title: 'Our menu 🍽\nChoose wetin you want:',
  menu_empty: 'Menu empty for now. Check back small time.',
  item_sold_out: 'E don finish',
  added: 'We don add {qty} × {name} to your cart.',
  cart_empty: 'Your cart empty. Press Menu or type wetin you want.',
  cart_cleared: 'Cart don clear.',
  ask_fulfilment: 'Delivery or pickup?',
  ask_address: 'Where we go deliver am?',
  share_location: '📍 Share my location',
  type_address: '✍️ Type address',
  ask_address_text: 'Type the address (street, landmark, area):',
  ask_zone: 'Which area be that?',
  outside_area: 'Sorry, we never dey deliver reach that side. We dey cover: {zones}.',
  address_saved: 'We don save am: {label} ({zone}).',
  payment_sent:
    'Press the button to pay with Paystack (card, transfer or USSD).\nThis link go expire in {minutes} minutes.\nOrder {ref}.',
  order_cancelled: 'Order {ref} don cancel.',
  cannot_cancel: 'You no fit cancel this order from here again. Message support with /help.',
  store_closed: 'We don close for now. We dey open 9am–9pm every day.',
  busy: 'Kitchen busy well well now. Try again small time.',
  paid: '💚 We don see your payment! Order {ref} dey kitchen. We go gist you every step.',
  accepted: '👩‍🍳 Kitchen don accept order {ref}. E go ready in about {eta} min.',
  preparing: '🔥 Dem dey cook order {ref}.',
  ready: '✅ Order {ref} don ready.',
  ready_pickup: '✅ Order {ref} don ready make you come carry am.',
  dispatched: '🛵 Order {ref} don dey road!',
  dispatched_rider: '🛵 Order {ref} don dey road with {rider} ({phone}).',
  delivered: '🎉 Order {ref} don land. Enjoy! Tell us how e be.',
  rejected: '😔 We no fit do order {ref}: {reason}. Your money go come back full.',
  expired: '⌛ Order {ref} don expire because payment no complete. Press Menu to order again.',
  refunded:
    '💸 We don send refund of {amount} for order {ref} to your card/bank. E fit take 5–7 working days.',
  track_none: 'You never order before. Press Menu make you start!',
  parsed_confirm: 'Make we add these ones to your cart?\n{lines}',
  parsed_unmatched: 'I no see: {items}. Press Menu to see wetin we get.',
  help: 'How e dey work:\n• Press Menu or type your order\n• Pay with Paystack\n• Follow your order for here\n\nCommands: /menu /cart /track /orders /language /privacy\nSupport: {support}',
  support_default: 'reply here, person go answer you',
  delete_confirm:
    'Delete your personal data? We go remove your phone and addresses and this chat go start fresh. No going back o.',
  deleted: 'Done. We don remove your personal data. Send /start anytime you wan order.',
  stale_button: 'That menu don old. See fresh one.',
  group_decline: 'I dey take order only for private chat. Message me direct!',
  unsupported: 'I no fit read that kind message yet. Type your order or press Menu.',
  unknown: 'Sorry, I no understand. Press Menu, or type your order like "2 jollof and 1 chicken".',
  error_generic: 'Something spoil for our side. Try again small time.',
  need_phone_first: 'We need your phone number for rider first.',
  min_order: 'Minimum order for your area na {min}.',
  out_of_stock: 'Sorry, {names} don finish. Adjust your cart.',
  unpaid_pending: 'You get one order wey you never pay. Pay am or cancel am first (press Track).',
};

const DICT: Record<Lang, Record<CopyKey, string>> = { en, pcm };

export function t(lang: Lang, key: CopyKey, vars: Record<string, string | number> = {}): string {
  const template = DICT[lang][key];
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    vars[k] !== undefined ? String(vars[k]) : '',
  );
}

/** Reply-keyboard labels that the engine recognises as commands, in both languages. */
export const QUICK_REPLY_COMMANDS: Record<string, string> = {
  [en.qr_menu]: 'menu',
  [en.qr_cart]: 'cart',
  [en.qr_track]: 'track',
  [en.qr_help]: 'help',
};
