// Live Yahoo Finance price stream via their WebSocket. This is the same feed
// finance.yahoo.com itself uses; it's the only public source that exposes the
// **Overnight** (Blue Ocean ATS, ~20:00–04:00 ET) session. Yahoo's REST
// endpoints — quoteSummary, /v7/quote, /v8/chart — all stop at the post-market
// close at 8 PM ET. The streamer keeps pushing through the overnight window.
//
// Wire protocol:
//   - Connect to wss://streamer.finance.yahoo.com/
//   - Send `{"subscribe":["MU","..."]}` as plain text
//   - Receive base64-encoded protobuf strings; one per tick
//   - Decode to extract price / change / changePercent / marketHours
//
// We hand-roll a tiny protobuf decoder (≈40 lines) for the only message type
// we care about (PricingData). Adding google-protobuf as a dep would balloon
// the bundle by ~80 KB for what amounts to parsing 5 numeric fields.

const STREAMER_URL = "wss://streamer.finance.yahoo.com/";

// MarketHoursType enum from Yahoo's pricing proto:
//   0 PRE_MARKET   — ~04:00–09:30 ET
//   1 REGULAR      — 09:30–16:00 ET
//   2 POST_MARKET  — 16:00–20:00 ET
//   3 EXTENDED_HOURS_MARKET — legacy after-hours bucket (now mostly unused)
//   4 OVERNIGHT_MARKET — Blue Ocean ATS, ~20:00–04:00 ET   ← the new one
export const MARKET_HOURS = {
  PRE_MARKET: 0,
  REGULAR: 1,
  POST_MARKET: 2,
  EXTENDED_HOURS: 3,
  OVERNIGHT: 4,
} as const;

export type PricingTick = {
  symbol: string;
  price: number;
  change?: number;
  changePercent?: number; // already in percent (e.g. -1.58 = -1.58%)
  time?: number; // ms
  marketHours?: number;
  exchange?: string;
};

// PricingData fields we read (others are skipped):
//   1 id (string)               2 price (float32)
//   3 time (varint, ms)          5 exchange (string)
//   7 marketHours (varint)       8 changePercent (float32, already %)
//  12 change (float32)
function decodeTick(b64: string): PricingTick | null {
  let bin: Uint8Array;
  try {
    bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  let off = 0;
  const out: Partial<PricingTick> = {};

  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    while (off < bin.length) {
      const b = bin[off++];
      // Use multiplication instead of <<; varints can exceed 32-bit (Yahoo's
      // timestamps overflow ms in <<28 territory).
      result += (b & 0x7f) * Math.pow(2, shift);
      if (!(b & 0x80)) return result;
      shift += 7;
    }
    return result;
  };
  const readFloat32 = (): number => {
    if (off + 4 > bin.length) return NaN;
    const v = new DataView(bin.buffer, bin.byteOffset + off, 4).getFloat32(
      0,
      true,
    );
    off += 4;
    return v;
  };
  const readString = (len: number): string => {
    const s = new TextDecoder().decode(bin.subarray(off, off + len));
    off += len;
    return s;
  };

  while (off < bin.length) {
    const tag = readVarint();
    const field = tag >>> 3;
    const wire = tag & 0x7;

    if (wire === 0) {
      const v = readVarint();
      if (field === 3) out.time = v;
      else if (field === 7) out.marketHours = v;
    } else if (wire === 5) {
      const v = readFloat32();
      if (field === 2) out.price = v;
      else if (field === 8) out.changePercent = v;
      else if (field === 12) out.change = v;
    } else if (wire === 2) {
      const len = readVarint();
      if (field === 1) out.symbol = readString(len);
      else if (field === 5) out.exchange = readString(len);
      else off += len; // skip
    } else if (wire === 1) {
      off += 8; // I64, skip
    } else {
      return null; // unknown wire type — bail rather than misalign
    }
  }
  if (!out.symbol || out.price == null) return null;
  return out as PricingTick;
}

export type StreamerHandle = { close: () => void };

// Open a streamer subscription for a single symbol. `onTick` fires for each
// price update; the same symbol can carry different `marketHours` values
// throughout the day (1=regular, 2=post, 4=overnight) so the caller decides
// which sessions to surface. Auto-reconnects on disconnect with exponential
// backoff capped at 30 s.
export function openYahooStreamer(
  symbol: string,
  onTick: (tick: PricingTick) => void,
): StreamerHandle {
  let ws: WebSocket | null = null;
  let closed = false;
  let retries = 0;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    console.info("[yahooStreamer] connecting", { symbol });
    try {
      ws = new WebSocket(STREAMER_URL);
    } catch (e) {
      console.warn("[yahooStreamer] constructor threw", e);
      scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      retries = 0;
      console.info("[yahooStreamer] open, subscribing", symbol);
      try {
        ws!.send(JSON.stringify({ subscribe: [symbol] }));
      } catch (e) {
        console.warn("[yahooStreamer] subscribe send failed", e);
      }
    };

    ws.onmessage = (e) => {
      const data =
        typeof e.data === "string"
          ? e.data
          : new TextDecoder().decode(e.data as ArrayBuffer);
      const tick = decodeTick(data.trim());
      if (!tick) {
        console.debug("[yahooStreamer] undecodable message", data.slice(0, 80));
        return;
      }
      console.debug("[yahooStreamer] tick", tick);
      if (tick.symbol === symbol) onTick(tick);
    };

    ws.onerror = (e) => {
      console.warn("[yahooStreamer] error", e);
    };
    ws.onclose = (e) => {
      console.info("[yahooStreamer] closed", { code: e.code, reason: e.reason });
      if (closed) return;
      scheduleReconnect();
    };
  };

  const scheduleReconnect = () => {
    if (closed) return;
    const delay = Math.min(30_000, 500 * Math.pow(2, retries++));
    backoffTimer = setTimeout(connect, delay);
  };

  connect();

  return {
    close: () => {
      closed = true;
      if (backoffTimer) clearTimeout(backoffTimer);
      if (ws) {
        try {
          ws.send(JSON.stringify({ unsubscribe: [symbol] }));
        } catch {
          /* connection might already be closing */
        }
        try {
          ws.close();
        } catch {
          /* idem */
        }
      }
    },
  };
}
