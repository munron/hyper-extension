export const HYPERLIQUID_HOSTS = ["app.hyperliquid.xyz"] as const;

export function extractCoinFromUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!HYPERLIQUID_HOSTS.includes(url.hostname as (typeof HYPERLIQUID_HOSTS)[number])) {
    return null;
  }
  const match = url.pathname.match(/^\/trade\/([^/]+)(?:\/[^/]+)?\/?$/);
  if (!match) return null;
  return decodeURIComponent(match[1]);
}
