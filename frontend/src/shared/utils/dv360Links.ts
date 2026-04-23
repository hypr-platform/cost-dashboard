/** Deep links aproximados — a UI do DV360 muda; use os IDs na busca interna se o link não abrir direto. */

export function dv360AdvertiserRootUrl(advertiserId: string): string {
  return `https://displayvideo.google.com/?advertiserId=${encodeURIComponent(advertiserId.trim())}`;
}

export function dv360LineItemUrlGuess(advertiserId: string, lineItemId: string): string {
  return `${dv360AdvertiserRootUrl(advertiserId)}#/lineitem/${encodeURIComponent(lineItemId.trim())}`;
}
