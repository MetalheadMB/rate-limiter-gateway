/**
 * Fixed window rate limiter -- in-memory, kept ONLY for comparison with
 * ./slidingWindow.js (and now ./slidingWindowRedis.js). Nothing in this
 * project uses this by default; select it with RATE_LIMIT_STRATEGY=fixed
 * to see the difference side by side.
 *
 * ALGORITHM: a counter per client that resets to zero at fixed clock
 * boundaries -- e.g. the top of every minute -- instead of rolling
 * continuously. Cheap: one integer and one timestamp per client.
 *
 * THE KNOWN FLAW -- the reason this project uses sliding log instead:
 * a client can send `max` requests in the last instant of one window and
 * another `max` in the first instant of the next window. Both batches are
 * individually under the limit -- the counter legitimately reset to 0 in
 * between -- but the two batches land within a fraction of a second of each
 * other on the wall clock. So the effective burst rate at the boundary is
 * up to 2x the configured limit, even though no single window was ever
 * "over". Concretely, with max=10 and a 60s window aligned to the minute:
 * 10 requests at 10:00:59.9 (all counted in the 10:00:00-10:00:59 window)
 * plus 10 more at 10:01:00.1 (a fresh window, counter back to 0) is 20
 * requests inside a 200ms span, and this middleware allows every one of them.
 *
 * ./slidingWindow.js doesn't have this flaw because it has no shared reset
 * boundary at all -- every request's window is measured backwards from that
 * request's own timestamp, so there is nothing to burst across.
 */

const DEFAULT_OPTIONS = {
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.ip,
};

function fixedWindow(options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };

  // counters: Map<clientKey, { count, windowStartMs }>
  const counters = new Map();

  function middleware(req, res, next) {
    const key = config.keyGenerator(req);
    const now = Date.now();

    // Which fixed window is "now" in? Integer-dividing the epoch into
    // windowMs-sized buckets is exactly what creates the shared boundary
    // every client resets against at the same instant -- that boundary is
    // the whole flaw described above, not an implementation accident.
    const windowStartMs = Math.floor(now / config.windowMs) * config.windowMs;
    const resetAtMs = windowStartMs + config.windowMs;

    let entry = counters.get(key);
    if (!entry || entry.windowStartMs !== windowStartMs) {
      entry = { count: 0, windowStartMs };
      counters.set(key, entry);
    }

    if (entry.count >= config.max) {
      const retryAfterSec = Math.max(1, Math.ceil((resetAtMs - now) / 1000));

      res.setHeader('X-RateLimit-Limit', config.max);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset', Math.ceil(resetAtMs / 1000));
      res.setHeader('Retry-After', retryAfterSec);

      return res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded: max ${config.max} requests per ${
          config.windowMs / 1000
        }s window. Try again in ${retryAfterSec}s.`,
        limit: config.max,
        windowSeconds: config.windowMs / 1000,
        retryAfterSeconds: retryAfterSec,
      });
    }

    entry.count += 1;
    const remaining = config.max - entry.count;

    res.setHeader('X-RateLimit-Limit', config.max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(resetAtMs / 1000));

    return next();
  }

  // Same leak risk as the naive in-memory sliding log has without cleanup --
  // a client whose window has rolled past never gets revisited on its own,
  // so a periodic sweep drops entries from windows that are no longer current.
  const sweeper = setInterval(() => {
    const currentWindowStart = Math.floor(Date.now() / config.windowMs) * config.windowMs;
    for (const [key, entry] of counters) {
      if (entry.windowStartMs !== currentWindowStart) counters.delete(key);
    }
  }, config.windowMs);
  if (typeof sweeper.unref === 'function') sweeper.unref();

  middleware.counters = counters;
  middleware.config = config;
  middleware.stop = () => clearInterval(sweeper);

  return middleware;
}

module.exports = fixedWindow;
module.exports.DEFAULT_OPTIONS = DEFAULT_OPTIONS;
