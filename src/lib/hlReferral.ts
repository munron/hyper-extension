// Resolves whether the connected HL user has already redeemed any referral
// code. The wallet address is surfaced by the content script
// (src/content/hlWallet.ts) into chrome.storage.local["hlWalletAddress"].

const INFO_ENDPOINT = "https://api.hyperliquid.xyz/info";

export type ReferralState =
  | { kind: "unknown" } // no address yet
  | { kind: "unreferred"; address: string }
  | { kind: "referred"; address: string; code?: string };

type ReferralResponse = {
  referredBy: { referrer?: string; code?: string } | null;
};

export async function readStoredAddress(): Promise<string | null> {
  const out = await chrome.storage.local.get("hlWalletAddress");
  const v = out.hlWalletAddress;
  return typeof v === "string" ? v : null;
}

export function subscribeStoredAddress(
  cb: (addr: string | null) => void,
): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName,
  ) => {
    if (area !== "local") return;
    if (!("hlWalletAddress" in changes)) return;
    const v = changes.hlWalletAddress.newValue;
    cb(typeof v === "string" ? v : null);
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

export async function fetchReferralState(address: string): Promise<ReferralState> {
  const res = await fetch(INFO_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "referral", user: address }),
  });
  if (!res.ok) throw new Error(`HL referral ${res.status}`);
  const json = (await res.json()) as ReferralResponse;
  // Key on `referredBy` presence, not `code` — a referred user is referred
  // whether or not the code field is populated (keeps this in lockstep with
  // the content-script redirect guard).
  if (json.referredBy) {
    return { kind: "referred", address, code: json.referredBy.code };
  }
  return { kind: "unreferred", address };
}
