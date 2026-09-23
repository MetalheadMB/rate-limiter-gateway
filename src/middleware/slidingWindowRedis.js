/**
 * Sliding window rate limiter -- REDIS-BACKED.
 * ---------------------------------------------------------------------
 * Same algorithm as ./slidingWindow.js (sliding log: keep every request
 * timestamp, evict anything older than the window, compare what's left to
 * the limit) -- but the state lives in Redis instead of a process-local
 * `Map`. That's the whole point: every server instance reads and writes the
 * SAME data, so the limit is enforced across the whole fleet, not per-process.
 * See ./slidingWindow.js's header comment for the algorithm-choice rationale
 * (sliding log vs sliding window counter) -- that reasoning is unchanged.
 *
 * DATA STRUCTURE: one Redis SORTED SET per client, e.g. key
 * "ratelimit:sliding:203.0.113.5". Each allowed request is one entry:
 *   score  = the request's timestamp in milliseconds (lets us evict
 *            anything older than the window with a single range command)
 *   member = a random id, NOT the timestamp -- two requests can arrive in
 *            the same millisecond, and a sorted set can't hold two members
 *            with the same value, so a timestamp-only member would silently
 *            drop one of them. The score still holds the real timestamp;
 *            the member just needs to be unique.
 *
 * ATOMICITY -- the actual reason this needs more than "just use Redis":
 * The naive translation of the in-memory version -- read the count, decide,
 * then write -- is a classic distributed race condition. Picture two app
 * instances, limit 10, and a client already at 9 requests in the window.
 * Both instances receive a request at nearly the same moment:
 *
 *   instance A: ZCARD key -> 9         instance B: ZCARD key -> 9
 *   instance A: 9 < 10, allow, ZADD    instance B: 9 < 10, allow, ZADD
 *
 * Both read 9 before either had written its own request, so both decide
 * "allowed" -- the client now has 11 requests recorded against a limit of
 * 10. Redis being shared didn't fix this; it just moved the race from two
 * in-memory Maps to two clients of the same store, racing the same way.
 *
 * The fix: do the whole evict -> count -> conditionally-add sequence as ONE
 * Lua script, sent to Redis with EVAL. Redis executes commands (and whole
 * Lua scripts) single-threaded -- while this script runs, no other client's
 * command can interleave with it, on any instance, anywhere. That's what
 * makes the check-then-act atomic across the fleet, not just within one
 * process. This is the actual mechanism; "Redis is shared storage" alone
 * does not prevent the race without it.
 *
 * CLOCK SOURCE: the script asks Redis for the current time (`TIME`) rather
 * than trusting each Node process's own clock. If app instances' system
 * clocks drift even slightly, computing "now" locally would make one
 * instance's evictions and resets subtly inconsistent with another's. Using
 * Redis's clock means every instance agrees on "now", by construction.
 *
 * TTL / MEMORY: `PEXPIRE` is set on every accepted request, so Redis itself
 * deletes a client's key windowMs after their last request -- the lazy
 * pruning / background sweep / hard cap machinery built for the in-memory
 * version (see slidingWindow.js's evolution) isn't needed here at all.
 * Redis's own expiry does that job for free.
 */

const crypto = require('crypto');
const getRedisClient = require('../lib/redisClient');

// KEYS[1] = the client's rate-limit key
// ARGV[1] = window length in milliseconds
// ARGV[2] = max requests allowed per window
// ARGV[3] = unique member id for this request, if it's allowed
const LUA_SLIDING_WINDOW = `
local key    = KEYS[1]
local window = tonumber(ARGV[1])
local max    = tonumber(ARGV[2])
local member = ARGV[3]

-- Redis's own clock, not the calling process's -- see header comment.
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local windowStart = now - window

-- Evict anything that has fallen out of the window, then count what's left.
redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
local count = redis.call('ZCARD', key)

local function resetAt()
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if oldest[2] then
    return tonumber(oldest[2]) + window
  end
  return now + window
end

if count >= max then
  return { 0, count, now, resetAt() }
end

redis.call('ZADD', key, now, member)
-- Self-cleaning: this key needs to outlive nothing past one window after
-- the last request in it, so let Redis delete it for us.
redis.call('PEXPIRE', key, window)

return { 1, count + 1, now, resetAt() }
`;

const DEFAULT_OPTIONS = {
  windowMs: 60 * 1000,
  max: 10,
  keyPrefix: 'ratelimit:sliding',
  keyGenerator: (req) => req.ip,
};

function slidingWindowRedis(options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const redis = getRedisClient();

  // ioredis caches the script's SHA and sends EVALSHA on repeat calls,
  // falling back to EVAL automatically if Redis has forgotten it (e.g.
  // after a restart) -- defineCommand is what gives us that for free.
  if (typeof redis.slidingWindowCheck !== 'function') {
    redis.defineCommand('slidingWindowCheck', { numberOfKeys: 1, lua: LUA_SLIDING_WINDOW });
  }

  async function middleware(req, res, next) {
    const key = `${config.keyPrefix}:${config.keyGenerator(req)}`;
    const member = crypto.randomUUID();

    let result;
    try {
      result = await redis.slidingWindowCheck(key, config.windowMs, config.max, member);
    } catch (err) {
      // FAIL OPEN: if Redis is unreachable, let the request through rather
      // than taking the whole API down because its rate limiter's datastore
      // hiccuped. See README "Design Notes" for the fail-open vs
      // fail-closed tradeoff and why this is the right default here.
      console.error(`[rate-limit] Redis unavailable, allowing request through: ${err.message}`);
      res.setHeader('X-RateLimit-Limit', config.max);
      res.setHeader('X-RateLimit-Bypassed', 'redis-unavailable');
      return next();
    }

    const [allowed, count, nowMs, resetAtMs] = result;
    const remaining = Math.max(0, config.max - count);

    res.setHeader('X-RateLimit-Limit', config.max);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(resetAtMs / 1000));

    if (!allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
      res.setHeader('Retry-After', retryAfterSec);
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

    return next();
  }

  middleware.config = config;
  middleware.redis = redis;

  return middleware;
}

module.exports = slidingWindowRedis;
module.exports.DEFAULT_OPTIONS = DEFAULT_OPTIONS;
module.exports.LUA_SLIDING_WINDOW = LUA_SLIDING_WINDOW;
