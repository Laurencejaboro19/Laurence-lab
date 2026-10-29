/** The seed menu has no photos yet; a glyph keeps the list scannable until it does. */
export function emojiFor(item: { slug: string; photoRef: string | null; name: string }): string {
  if (item.photoRef && /\p{Extended_Pictographic}/u.test(item.photoRef)) return item.photoRef;
  const k = `${item.slug} ${item.name}`.toLowerCase();
  if (k.includes('jollof')) return '🍛';
  if (k.includes('fried rice')) return '🍚';
  if (k.includes('rice')) return '🍲';
  if (k.includes('chicken') || k.includes('turkey')) return '🍗';
  if (k.includes('beef') || k.includes('goat')) return '🥩';
  if (k.includes('fish')) return '🐟';
  if (k.includes('plantain')) return '🍌';
  if (k.includes('slaw') || k.includes('salad')) return '🥗';
  if (k.includes('moi')) return '🫘';
  if (k.includes('water')) return '💧';
  if (k.includes('malt')) return '🍺';
  if (k.includes('juice') || k.includes('chivita')) return '🧃';
  if (k.includes('drink') || k.includes('coke') || k.includes('soda')) return '🥤';
  return '🍽️';
}
