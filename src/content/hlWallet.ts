// Content script that runs on app.hyperliquid.xyz pages.
//
// Two jobs:
//   1. Surface the currently-connected wallet address into chrome.storage so
//      the sidepanel can read it (e.g. to hide the referral CTA once applied).
//   2. If the connected wallet hasn't redeemed any referral code yet, redirect
//      the tab to our /join/HYPURREXT link once — the aggressive monetization
//      path. Suppressed when:
//        - the tab is already at /join/*
//        - we've redirected this address before (per-address one-shot)
//
// Address source: wagmi v2 persists the active connection to
// localStorage["wagmi.store"]. The truncated DOM pill (0xA…BCD) only has
// 4 chars of the address so it's useless for an API call — wagmi is the
// only stable source for the full 0x.

const DEFAULT_KEY = "wagmi.store";
const INVITE_CODE = "HYPURREXT";
const INVITE_URL = `https://app.hyperliquid.xyz/join/${INVITE_CODE}`;
const DEBUG = true;
const log = (...a: unknown[]) => {
  if (DEBUG) console.log("[hypurr-ext]", ...a);
};

type WagmiConn = {
  accounts?: string[];
};

type WagmiStore = {
  state?: {
    current?: string | null;
    connections?: {
      __type?: "Map";
      value?: [string, WagmiConn][];
    };
  };
};

function parseWagmi(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as WagmiStore;
    const cur = parsed.state?.current;
    if (!cur) return null;
    const conn = parsed.state?.connections?.value?.find(([uid]) => uid === cur);
    const addr = conn?.[1]?.accounts?.[0];
    return typeof addr === "string" && /^0x[0-9a-fA-F]{40}$/.test(addr)
      ? addr.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

// HL might run wagmi with a custom prefix or the user may have manually
// cleared `wagmi.store`. Fall back to scanning every localStorage key whose
// value parses to wagmi's persisted shape.
function readAddress(): string | null {
  const raw = localStorage.getItem(DEFAULT_KEY);
  if (raw) {
    const a = parseWagmi(raw);
    if (a) return a;
  }
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || k === DEFAULT_KEY) continue;
    const v = localStorage.getItem(k);
    if (!v || !v.startsWith("{")) continue;
    if (!v.includes("connections") || !v.includes("current")) continue;
    const a = parseWagmi(v);
    if (a) {
      log("found address via fallback key", k);
      return a;
    }
  }
  return null;
}

let last: string | null | undefined = undefined;

function push(addr: string | null): void {
  if (addr === last) return;
  last = addr;
  void chrome.storage.local.set({ hlWalletAddress: addr });
  if (addr) void maybeRedirect(addr);
}

// Heartbeat must be fresher than this for the redirect to fire. 8s gives the
// sidepanel's 3s heartbeat ~2 cycles of slack before we consider it closed.
const SIDEPANEL_FRESH_MS = 8000;

async function isSidepanelOpen(): Promise<boolean> {
  const out = await chrome.storage.local.get("hlSidepanelHeartbeat");
  const ts = Number(out.hlSidepanelHeartbeat) || 0;
  return ts > 0 && Date.now() - ts < SIDEPANEL_FRESH_MS;
}

// Per-address one-shot guard. HL's `referral` API only reports `referredBy`
// once a wallet has actually traded — clicking the invite link doesn't set it.
// So we can't rely on the API alone to avoid re-bouncing someone we've already
// sent to /join. Instead we remember every address we've redirected (and every
// address that lands on the join page) and never redirect it again.
const REDIRECTED_KEY = "hlRedirectedAddresses";

async function getRedirectedSet(): Promise<Set<string>> {
  const out = await chrome.storage.local.get(REDIRECTED_KEY);
  const arr = out[REDIRECTED_KEY];
  return new Set(Array.isArray(arr) ? (arr as string[]) : []);
}

async function markRedirected(addr: string): Promise<void> {
  const set = await getRedirectedSet();
  if (set.has(addr)) return;
  set.add(addr);
  await chrome.storage.local.set({ [REDIRECTED_KEY]: [...set] });
}

async function maybeRedirect(addr: string): Promise<void> {
  // Don't loop the join page itself.
  if (location.pathname.startsWith("/join/")) {
    log("skip redirect: already on /join/");
    return;
  }
  // One-shot per address: never re-bounce someone we've already sent.
  const redirected = await getRedirectedSet();
  if (redirected.has(addr)) {
    log("skip redirect: address already redirected once", addr);
    return;
  }
  if (!(await isSidepanelOpen())) {
    log("skip redirect: sidepanel not open");
    return;
  }
  try {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "referral", user: addr }),
    });
    if (!res.ok) {
      log("referral fetch !ok", res.status);
      return;
    }
    const json = (await res.json()) as {
      referredBy: { referrer?: string; code?: string } | null;
    };
    log("referral state", { addr, referredBy: json.referredBy });
    // HL returns `referredBy: null` for users who have never redeemed a
    // referral, and an object ({ referrer, code }) once they have. Skip the
    // redirect for ANY referred user — don't gate on `code` being present, so
    // a referred user is never bounced back to /join.
    if (json.referredBy) return; // already referred — leave them alone
    log("redirecting to", INVITE_URL);
    // Record BEFORE navigating so a returning visit (or the post-redirect page
    // load) won't bounce this address a second time.
    await markRedirected(addr);
    location.replace(INVITE_URL);
  } catch (e) {
    log("redirect check failed", e);
  }
}

log("content script booted on", location.href);
push(readAddress());

// On our own /join page, surface a branded banner so the user understands
// that the redirect came from this extension (and not some random site
// hijacking their tab). Also treat reaching this page as "this wallet has
// seen the invite" — record it so we never bounce it here again, even if HL's
// referral API still reports the wallet as un-referred (it only flips after a
// trade).
if (location.pathname.toUpperCase() === `/JOIN/${INVITE_CODE}`) {
  mountInviteBanner();
  const here = readAddress();
  if (here) void markRedirected(here);
}

function mountInviteBanner(): void {
  if (document.getElementById("hypurr-ext-invite-banner")) return;
  const root = document.createElement("div");
  root.id = "hypurr-ext-invite-banner";
  root.innerHTML = `
    <style>
      #hypurr-ext-invite-banner {
        position: fixed;
        top: 22px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 14px 18px 14px 16px;
        background: linear-gradient(135deg, rgba(16, 32, 30, 0.97), rgba(11, 22, 22, 0.97));
        border: 1.5px solid rgba(95, 227, 194, 0.85);
        border-radius: 16px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.55), 0 0 0 4px rgba(95, 227, 194, 0.12), 0 0 24px rgba(95, 227, 194, 0.35);
        font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
        color: #f1faf7;
        font-size: 15px;
        font-weight: 500;
        letter-spacing: 0.01em;
        backdrop-filter: blur(8px);
        animation: hypurrExtSlide 0.4s cubic-bezier(0.22, 1, 0.36, 1);
      }
      #hypurr-ext-invite-banner.hypurr-ext-hide {
        animation: hypurrExtHide 0.45s ease-in forwards;
      }
      #hypurr-ext-invite-banner img {
        width: 34px;
        height: 34px;
        border-radius: 50%;
        flex-shrink: 0;
        box-shadow: 0 0 12px rgba(95, 227, 194, 0.5);
      }
      #hypurr-ext-invite-banner b {
        color: #5fe3c2;
        font-weight: 800;
      }
      #hypurr-ext-invite-banner .hypurr-ext-fee {
        color: #5fe3c2;
        font-weight: 800;
        font-size: 1.05em;
      }
      #hypurr-ext-invite-banner .hypurr-ext-close {
        margin-left: 6px;
        background: none;
        border: none;
        color: rgba(241, 250, 247, 0.6);
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
        padding: 4px 8px;
        border-radius: 8px;
        transition: color 0.12s ease, background 0.12s ease;
      }
      #hypurr-ext-invite-banner .hypurr-ext-close:hover {
        color: #f1faf7;
        background: rgba(255, 255, 255, 0.1);
      }
      @keyframes hypurrExtSlide {
        from { opacity: 0; transform: translate(-50%, -14px) scale(0.96); }
        to   { opacity: 1; transform: translate(-50%, 0) scale(1); }
      }
      @keyframes hypurrExtHide {
        from { opacity: 1; transform: translate(-50%, 0) scale(1); }
        to   { opacity: 0; transform: translate(-50%, -14px) scale(0.96); }
      }
    </style>
    <img alt="" src="${chrome.runtime.getURL("icon.png")}" />
    <span><b>Hypurr Extension</b> — start trading with <span class="hypurr-ext-fee">−4%</span> fees</span>
    <button class="hypurr-ext-close" aria-label="Close">✕</button>
  `;
  document.documentElement.appendChild(root);

  // Dismiss with a fade-out; shared by the close button and the auto-timer.
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    root.classList.add("hypurr-ext-hide");
    // Remove after the fade-out animation finishes.
    setTimeout(() => root.remove(), 500);
  };

  root.querySelector(".hypurr-ext-close")?.addEventListener("click", dismiss);
  // Auto-dismiss after 10s so it never lingers.
  setTimeout(dismiss, 10000);
}

// Wagmi hydrates after boot; poll briefly then settle into storage-event
// listening. Storage events fire across same-origin tabs when the value
// changes (connect / disconnect / account-switch).
let polls = 0;
const pollId = setInterval(() => {
  const a = readAddress();
  if (polls === 0 || a !== last) log("poll", polls, "addr=", a);
  push(a);
  if (++polls >= 40) {
    clearInterval(pollId);
    log("poll done; final addr=", last);
  }
}, 500);

window.addEventListener("storage", (e) => {
  // Re-read on any wagmi-store change. We can't pin to a single key because HL
  // may use a custom prefix (readAddress() scans for the wagmi shape), and the
  // old code referenced an undefined STORAGE_KEY constant which threw here. A
  // null key means localStorage was cleared — handle that too.
  if (e.key === null || e.key === DEFAULT_KEY || (e.key && e.key.includes("wagmi"))) {
    push(readAddress());
  }
});
