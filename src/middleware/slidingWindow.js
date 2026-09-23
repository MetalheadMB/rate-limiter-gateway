/**
 * Sliding window rate limiter (sliding LOG variant).
 * ---------------------------------------------------
 * For each client IP we keep an array of timestamps — one entry per allowed
 * request. On every incoming request we drop the timestamps that have fallen
 * out of the last `windowMs` milliseconds, then compare what's left against
 * `max`. The window therefore always measures backwards from *now*, so there
 * are no fixed reset boundaries a client can burst across.
 *
 * Why the log and not the weighted "sliding window counter"?
 *   The log is exact — it never allows an 11th request inside any 60s span.
 *   Its cost is memory: O(max) timestamps per active client. With max = 10
 *   that's 10 numbers (~80 bytes) per IP, which is nothing. The weighted
 *   counter stores only 2 integers per client but *approximates* the count by
 *   blending the previous window, so it can be slightly wrong near the edge.
 *   At this scale, exactness is free — so we take it. (Swap to the counter
 *   when max is huge, e.g. 10,000 req/min, and the memory matters.)
 *
 * No external rate limiting package is used — this is all timestamp math.
 */

const DEFAULT_OPTIONS = {
  windowMs: 60 * 1000, // rolling window length: 60 seconds
  max: 10, // requests allowed per window, per client
  // How to identify a client. Note: req.ip is only trustworthy behind a proxy
  // if you set app.set('trust proxy', ...) — otherwise you'd see the proxy IP.
  keyGenerator: (req) => req.ip,
};

function slidingWindow(options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };

  /**
   * hits: Map<clientKey, number[]>
   * The array holds epoch-millisecond timestamps of allowed requests, oldest
   * first. Kept sorted for free — time only moves forward, so pushing appends
   * in order and expired entries are always at the front.
   */
  const hits = new Map();

  /**
   * Remove timestamps older than the window from a client's list.
   * Because the list is sorted, everything expired is a prefix: find the first
   * index still inside the window and splice off everything before it.
   */
  function prune(timestamps, windowStart) {
    let firstValid = 0;
    while (firstValid < timestamps.length && timestamps[firstValid] <= windowStart) {
      firstValid += 1;
    }
    if (firstValid > 0) timestamps.splice(0, firstValid);
    return timestamps;
  }

  function middleware(req, res, next) {
    const key = config.keyGenerator(req);
    const now = Date.now();
    const windowStart = now - config.windowMs; // exactly 60s ago, every time

    const timestamps = prune(hits.get(key) || [], windowStart);

    if (timestamps.length >= config.max) {
      // Over the limit. The window frees up a slot when the OLDEST surviving
      // timestamp expires, i.e. at oldest + windowMs.
      const oldest = timestamps[0];
      const resetAtMs = oldest + config.windowMs;
      const retryAfterSec = Math.max(1, Math.ceil((resetAtMs - now) / 1000));

      hits.set(key, timestamps); // persist the pruning we just did

      res.setHeader('X-RateLimit-Limit', config.max);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset', Math.ceil(resetAtMs / 1000));
      res.setHeader('Retry-After', retryAfterSec);

      // Deliberately do NOT record this request. A rejected request costs the
      // upstream nothing, and counting it would let a client that keeps
      // hammering push its own reset time forever into the future.
      return res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded: max ${config.max} requests per ${
          config.windowMs / 1000
        } seconds. Try again in ${retryAfterSec}s.`,
        limit: config.max,
        windowSeconds: config.windowMs / 1000,
        retryAfterSeconds: retryAfterSec,
      });
    }

    // Allowed — record it.
    timestamps.push(now);
    hits.set(key, timestamps);

    const remaining = config.max - timestamps.length;
    // When does the client next regain a slot? When its oldest request expires.
    const resetAtMs = timestamps[0] + config.windowMs;

    res.setHeader('X-RateLimit-Limit', config.max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(resetAtMs / 1000)); // epoch seconds

    return next();
  }

  /**
   * Housekeeping: a client that never comes back would otherwise leave its
   * array in the Map forever — an unbounded memory leak on a public endpoint.
   * Sweep once per window and drop clients with nothing left inside it.
   * .unref() so this timer never keeps the Node process alive on its own.
   */
  const sweeper = setInterval(() => {
    const windowStart = Date.now() - config.windowMs;
    for (const [key, timestamps] of hits) {
      if (prune(timestamps, windowStart).length === 0) hits.delete(key);
    }
  }, config.windowMs);
  if (typeof sweeper.unref === 'function') sweeper.unref();

  // Exposed for tests and debugging.
  middleware.hits = hits;
  middleware.config = config;
  middleware.stop = () => clearInterval(sweeper);

  return middleware;
}

module.exports = slidingWindow;
module.exports.DEFAULT_OPTIONS = DEFAULT_OPTIONS;
