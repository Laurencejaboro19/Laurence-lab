import { CHANNEL_LIMITS, type ListRow, type OutboundList, type OutboundMessage } from './types.js';

/**
 * Checks an outbound message against the cross-platform limits. The core runs
 * this in tests (every message a flow can emit must pass) and adapters run it
 * defensively before rendering, so an oversized message is a logged bug rather
 * than a platform 400 at 7 pm on a Friday.
 */
export function outboundLimitViolations(message: OutboundMessage): string[] {
  const problems: string[] = [];
  const checkLabel = (label: string, where: string): void => {
    if (label.length > CHANNEL_LIMITS.maxChoiceLabelChars) {
      problems.push(
        `${where} label "${label}" exceeds ${CHANNEL_LIMITS.maxChoiceLabelChars} chars`,
      );
    }
  };
  const checkBody = (text: string): void => {
    if (text.length > CHANNEL_LIMITS.maxBodyChars) {
      problems.push(`body exceeds ${CHANNEL_LIMITS.maxBodyChars} chars (${text.length})`);
    }
    if (text.trim().length === 0) problems.push('body is empty');
  };

  switch (message.kind) {
    case 'text':
      checkBody(message.body.text);
      break;
    case 'buttons':
      checkBody(message.body.text);
      // The tuple type already caps this at 3; the runtime check guards JSON from other processes.
      if ((message.choices as readonly unknown[]).length > CHANNEL_LIMITS.maxPrimaryChoices) {
        problems.push(`more than ${CHANNEL_LIMITS.maxPrimaryChoices} primary choices`);
      }
      for (const c of message.choices) checkLabel(c.label, 'button');
      break;
    case 'quick_replies':
      checkBody(message.body.text);
      for (const c of message.choices) checkLabel(c.label, 'quick reply');
      break;
    case 'list':
      checkBody(message.body.text);
      checkLabel(message.openLabel, 'list open');
      if (message.rows.length > CHANNEL_LIMITS.maxListRows) {
        problems.push(`list has ${message.rows.length} rows, max ${CHANNEL_LIMITS.maxListRows}`);
      }
      if (message.rows.length === 0) problems.push('list has no rows');
      for (const r of message.rows) {
        if (r.title.length > CHANNEL_LIMITS.maxListRowTitleChars) {
          problems.push(
            `list row title "${r.title}" exceeds ${CHANNEL_LIMITS.maxListRowTitleChars}`,
          );
        }
        if (
          r.description !== undefined &&
          r.description.length > CHANNEL_LIMITS.maxListRowDescriptionChars
        ) {
          problems.push(
            `list row description for "${r.title}" exceeds ${CHANNEL_LIMITS.maxListRowDescriptionChars}`,
          );
        }
      }
      break;
    case 'url_button':
      checkBody(message.body.text);
      checkLabel(message.label, 'url button');
      if (!message.url.startsWith('https://')) problems.push('url button must be https');
      break;
    case 'location_request':
    case 'contact_request':
      checkBody(message.body.text);
      break;
    case 'image':
      if (message.caption) checkBody(message.caption.text);
      for (const c of message.choices ?? []) checkLabel(c.label, 'image button');
      break;
    case 'edit':
      checkBody(message.body.text);
      break;
    case 'typing':
      break;
  }
  return problems;
}

/**
 * Splits rows into pages of at most `maxListRows` and builds the list message
 * for one page. Action ids for paging are derived from `baseActionId` so the
 * conversation engine can route them with a prefix match.
 */
export function paginatedList(
  args: {
    body: OutboundList['body'];
    openLabel: string;
    rows: readonly ListRow[];
    page: number;
    baseActionId: string;
    sectionTitle?: string;
    replaces?: OutboundList['replaces'];
  },
  pageSize: number = CHANNEL_LIMITS.maxListRows,
): OutboundList {
  const size = Math.min(Math.max(1, pageSize), CHANNEL_LIMITS.maxListRows);
  const pageCount = Math.max(1, Math.ceil(args.rows.length / size));
  const page = Math.min(Math.max(1, args.page), pageCount);
  const start = (page - 1) * size;
  const rows = args.rows.slice(start, start + size);
  const list: OutboundList = {
    kind: 'list',
    body: args.body,
    openLabel: args.openLabel,
    rows,
    page,
    pageCount,
  };
  if (args.sectionTitle !== undefined) list.sectionTitle = args.sectionTitle;
  if (args.replaces !== undefined) list.replaces = args.replaces;
  if (page < pageCount) list.nextActionId = `${args.baseActionId}:p${page + 1}`;
  if (page > 1) list.prevActionId = `${args.baseActionId}:p${page - 1}`;
  return list;
}
