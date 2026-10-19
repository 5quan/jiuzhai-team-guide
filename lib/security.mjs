// A bounded fixed-window limiter. Only the TCP peer identifies a client;
// forwarded headers are deliberately ignored until a trusted proxy is configured.
export function createLimiter({ perIp = 120, total = 600, windowMs = 60_000, maxClients = 1024, now = Date.now } = {}) {
  const clients = new Map();
  let reset = 0;
  let count = 0;
  return address => {
    const time = now();
    if (time >= reset) {
      clients.clear();
      count = 0;
      reset = time + windowMs;
    }
    const used = clients.get(address) || 0;
    const retryAfter = Math.max(1, Math.ceil((reset - time) / 1000));
    if (count >= total || used >= perIp || (!clients.has(address) && clients.size >= maxClients)) return retryAfter;
    clients.set(address, used + 1);
    count++;
    return 0;
  };
}

// Fixed route keys only: random query strings never increase cache cardinality.
// Pending/rejected work is also shared within the TTL to prevent retry storms.
export function createCache({ ttlMs = 1000, maxEntries = 64, now = Date.now } = {}) {
  const entries = new Map();
  return (key, load) => {
    const time = now();
    const cached = entries.get(key);
    if (cached && (cached.pending || time < cached.expires)) return cached.value;
    if (entries.size >= maxEntries && !entries.has(key)) entries.delete(entries.keys().next().value);
    const entry = { pending: true, expires: Infinity, value: null };
    entry.value = Promise.resolve().then(load).finally(() => {
      entry.pending = false;
      entry.expires = now() + ttlMs;
    });
    entries.set(key, entry);
    return entry.value;
  };
}
