// Coinglass HYPE-ETF data. Their public REST surface is open and CORS-clean,
// but the response payload is AES-128-ECB + gzip encrypted. The client
// derives keys from request path + a server-sent header. We replicate that
// here so we can read the data from the extension sidepanel.
//
// Header pipeline (key derivation uses only the path + `user` header — NOT the
// rotating `v` nonce or the `ev` version header):
//   firstKey = base64(path).slice(0, 16)          // 16-byte AES key
//   dataKey  = gunzip(AES_ECB_dec(b64(user), firstKey)).slice(0, 16)
//   payload  = JSON.parse(gunzip(AES_ECB_dec(b64(body.data), dataKey)))

import aesjs from "aes-js";

const HEADERS: HeadersInit = {
  Accept: "application/json",
  Referer: "https://www.coinglass.com/",
  // encryption: "true" opts into the encrypted-data response.
  encryption: "true",
};

type Envelope<T = unknown> = {
  code: string;
  msg?: string;
  success: boolean;
  data?: string | T;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8ToB64(s: string): string {
  const bytes = enc.encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function aesEcbDecrypt(ciphertext: Uint8Array, key: Uint8Array): Uint8Array {
  const cipher = new aesjs.ModeOfOperation.ecb(key);
  const out = cipher.decrypt(ciphertext);
  // Strip PKCS7 padding.
  const pad = out[out.length - 1];
  if (pad > 0 && pad <= 16) return out.subarray(0, out.length - pad);
  return out;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function pathOf(url: string): string {
  const u = new URL(url);
  return u.pathname; // no query for the v=1 key derivation
}

async function fetchCoinglass<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { ...HEADERS, "cache-ts-v2": String(Date.now()) },
  });
  if (!res.ok) throw new Error(`coinglass ${res.status} ${url}`);
  const userHdr = res.headers.get("user");
  // Coinglass returns a per-request random `v` header (observed 66, 77, ...)
  // plus an `ev` (encryption version) header. `v` is a nonce, NOT a cipher
  // selector — pinning it to "1" broke the moment they started rotating it.
  // The key derivation depends only on the request path + the `user` header,
  // so we no longer gate on `v`; we keep both for error context.
  const vHdr = res.headers.get("v") ?? "?";
  const evHdr = res.headers.get("ev") ?? "?";
  if (!userHdr) throw new Error("coinglass: missing 'user' response header");
  const env = (await res.json()) as Envelope;
  if (typeof env.data !== "string") {
    throw new Error(`coinglass: missing encrypted data`);
  }

  try {
    const firstKey = enc.encode(utf8ToB64(pathOf(url)).slice(0, 16));
    const dataKeyZipped = aesEcbDecrypt(b64ToBytes(userHdr), firstKey);
    const dataKeyRaw = dec.decode(await gunzip(dataKeyZipped));
    const dataKey = enc.encode(dataKeyRaw.replace(/^"|"$/g, "").slice(0, 16));

    const payloadBytes = await gunzip(
      aesEcbDecrypt(b64ToBytes(env.data), dataKey),
    );
    return JSON.parse(dec.decode(payloadBytes)) as T;
  } catch (e) {
    // Decryption/parse only fails if the cipher itself changed (ev bump),
    // not the rotating `v`. Surface that distinctly from the old v-guard error.
    throw new Error(
      `coinglass: decrypt failed (v=${vHdr} ev=${evHdr}) for ${url}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

// --- Public ---------------------------------------------------------------

export type EtfFlowDay = {
  date: string; // YYYY-MM-DD (derived from ms timestamp)
  netFlowUsd: number; // daily net inflow (negative = outflow)
  perTicker: Record<string, number>; // ticker -> USD net flow that day
};

export type EtfStockDay = {
  date: string;
  priceUsd: number;
  inflowUsd: number;
};

// /api/etf/hype/flow returns a plain array (no wrapper); each row has a ms
// timestamp under `date`, an aggregated `changeUsd`, and per-issuer breakdown
// in `list[]` (items missing their own change field on zero-flow days).
type RawFlowRow = {
  date?: number;
  changeUsd?: number;
  list?: { ticker?: string; changeUsd?: number }[];
};

function msToDate(ms?: number): string {
  if (typeof ms === "number" && Number.isFinite(ms)) {
    return new Date(ms).toISOString().slice(0, 10);
  }
  return "";
}

export async function fetchHypeEtfFlow(): Promise<EtfFlowDay[]> {
  const rows = await fetchCoinglass<RawFlowRow[]>(
    "https://capi.coinglass.com/api/etf/hype/flow",
  );
  return rows
    .map((r) => {
      const perTicker: Record<string, number> = {};
      for (const item of r.list ?? []) {
        if (item.ticker && typeof item.changeUsd === "number") {
          perTicker[item.ticker] = item.changeUsd;
        }
      }
      return {
        date: msToDate(r.date),
        netFlowUsd: Number(r.changeUsd) || 0,
        perTicker,
      };
    })
    .filter((d) => d.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}

type RawStock = { data?: { date?: string; price?: number; change?: number }[] };

export async function fetchHypeEtfStock(ticker: string): Promise<EtfStockDay[]> {
  const raw = await fetchCoinglass<RawStock>(
    `https://capi.coinglass.com/api/stock/hype/spot/inFlow?ticker=${encodeURIComponent(ticker)}`,
  );
  const rows = raw.data ?? [];
  return rows
    .map((r) => ({
      date: r.date ?? "",
      priceUsd: Number(r.price) || 0,
      inflowUsd: Number(r.change) || 0,
    }))
    .filter((d) => d.date)
    .sort((a, b) => a.date.localeCompare(b.date));
}
