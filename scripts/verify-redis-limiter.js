/**
 * Proof that the Redis-backed limiter actually solves the multi-instance
 * problem -- not just that it runs, but that two separate "instances"
 * (two independent ioredis connections, exactly as two separate Node
 * processes would have) share one counter instead of each keeping their own.
 *
 * Requires a real Redis reachable at REDIS_URL (default redis://localhost:6379).
 * This is intentionally NOT mocked -- the whole point is proving real
 * cross-connection atomicity, which a mock can't demonstrate.
 *
 * Usage:
 *   redis-server --daemonize yes   # or: docker run -p 6379:6379 redis:7-alpine
 *   node scripts/verify-redis-limiter.js
 */

const Redis = require('ioredis');
const slidingWindowRedis = require('../src/middleware/slidingWindowRedis');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${actual}, expected ${expected})`);
}
function checkThat(label, condition, detail) {
  if (!condition) failures += 1;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
}

function call(limiter, ip) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const req = { ip };
    const res = {
      setHeader: (k, v) => {
        headers[k] = v;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, headers, body });
      },
    };
    limiter(req, res, () => resolve({ status: 200, headers, body: null })).catch(reject);
  });
}

async function testBasicAllowDeny() {
  console.log('\n=== 1. Basic allow/deny through the real Lua script ===');
  const limiter = slidingWindowRedis({ windowMs: 3000, max: 3, keyPrefix: `test:basic:${Date.now()}` });

  for (let i = 1; i <= 5; i += 1) {
    const r = await call(limiter, '1.1.1.1');
    check(`request ${i}`, r.status, i <= 3 ? 200 : 429);
  }

  await sleep(3100);
  const after = await call(limiter, '1.1.1.1');
  check('allowed again after window', after.status, 200);
}

async function testSharedAcrossInstances() {
  console.log('\n=== 2. Two independent connections share ONE counter (the actual point) ===');
  const keyPrefix = `test:shared:${Date.now()}`;
  const options = { windowMs: 5000, max: 6, keyPrefix };

  // Two genuinely separate ioredis connections -- standing in for two
  // separate Node processes / server instances, exactly like app1 and app2
  // in docker-compose.yml.
  const redisA = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  const redisB = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  await Promise.all([
    new Promise((res) => redisA.once('ready', res)),
    new Promise((res) => redisB.once('ready', res)),
  ]);

  const instanceA = buildMiddlewareOnClient(redisA, options);
  const instanceB = buildMiddlewareOnClient(redisB, options);

  console.log('  Sending 3 requests to "instance A" and 3 to "instance B", alternating:');
  const results = [];
  for (let i = 0; i < 6; i += 1) {
    const inst = i % 2 === 0 ? instanceA : instanceB;
    const label = i % 2 === 0 ? 'A' : 'B';
    const r = await call(inst, '9.9.9.9'); // SAME client IP hitting both instances
    results.push(r);
    console.log(`    [instance ${label}] request ${i + 1} -> HTTP ${r.status}, remaining=${r.headers['X-RateLimit-Remaining']}`);
  }
  checkThat('all 6 allowed (within the shared limit of 6)', results.every((r) => r.status === 200));
  check('final remaining reached 0', results[5].headers['X-RateLimit-Remaining'], 0);

  console.log('  A 7th request, to instance A, should now be rejected -- proving A saw B\'s requests:');
  const seventh = await call(instanceA, '9.9.9.9');
  check('7th request (instance A) rejected', seventh.status, 429);

  console.log('  ...and instance B independently agrees it\'s also rejected:');
  const eighth = await call(instanceB, '9.9.9.9');
  check('8th request (instance B) rejected', eighth.status, 429);

  redisA.disconnect();
  redisB.disconnect();
}

async function testConcurrencyRace() {
  console.log('\n=== 3. Concurrency: the race the naive read-then-write approach loses ===');
  console.log('  Firing 30 concurrent requests from TWO simultaneous connections (15 each),');
  console.log('  limit = 10. A read-count-then-write implementation would very likely let');
  console.log('  more than 10 through here, because both connections read the pre-write');
  console.log('  count before either one\'s write lands. The atomic Lua script must not.');

  const keyPrefix = `test:race:${Date.now()}`;
  const options = { windowMs: 5000, max: 10, keyPrefix };

  const redisA = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  const redisB = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  await Promise.all([
    new Promise((res) => redisA.once('ready', res)),
    new Promise((res) => redisB.once('ready', res)),
  ]);

  const instanceA = buildMiddlewareOnClient(redisA, options);
  const instanceB = buildMiddlewareOnClient(redisB, options);

  const callsA = Array.from({ length: 15 }, () => call(instanceA, '5.5.5.5'));
  const callsB = Array.from({ length: 15 }, () => call(instanceB, '5.5.5.5'));
  const all = await Promise.all([...callsA, ...callsB]);

  const allowed = all.filter((r) => r.status === 200).length;
  const rejected = all.filter((r) => r.status === 429).length;

  console.log(`  Result: ${allowed} allowed, ${rejected} rejected (30 fired concurrently, limit 10)`);
  check('exactly 10 allowed -- no overshoot from the race', allowed, 10);
  check('exactly 20 rejected', rejected, 20);

  redisA.disconnect();
  redisB.disconnect();
}

async function testFailOpen() {
  console.log('\n=== 4. Fail-open when Redis is unreachable ===');
  const brokenRedis = new Redis({ port: 1, host: '127.0.0.1', lazyConnect: true, retryStrategy: () => null, maxRetriesPerRequest: 1 });
  brokenRedis.on('error', () => {}); // expected in this test; the assertions below are what matters
  const limiter = buildMiddlewareOnClient(brokenRedis, { windowMs: 5000, max: 3, keyPrefix: 'test:failopen' });

  const r = await call(limiter, '8.8.8.8');
  check('request allowed through despite Redis being unreachable', r.status, 200);
  checkThat('X-RateLimit-Bypassed header set', r.headers['X-RateLimit-Bypassed'] === 'redis-unavailable');
}

// Build the middleware against a SPECIFIC ioredis client instead of the
// module-level singleton in src/lib/redisClient.js, so tests 2-4 can use
// genuinely independent connections rather than accidentally sharing one.
function buildMiddlewareOnClient(redisClient, options) {
  const crypto = require('crypto');
  const config = { ...slidingWindowRedis.DEFAULT_OPTIONS, ...options };
  const LUA = slidingWindowRedis.LUA_SLIDING_WINDOW;
  if (typeof redisClient.slidingWindowCheck !== 'function') {
    redisClient.defineCommand('slidingWindowCheck', { numberOfKeys: 1, lua: LUA });
  }

  async function middleware(req, res, next) {
    const key = `${config.keyPrefix}:${config.keyGenerator(req)}`;
    const member = crypto.randomUUID();
    let result;
    try {
      result = await redisClient.slidingWindowCheck(key, config.windowMs, config.max, member);
    } catch (err) {
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
      return res.status(429).json({ error: 'Too Many Requests', retryAfterSeconds: retryAfterSec });
    }
    return next();
  }
  return middleware;
}

async function main() {
  await testBasicAllowDeny();
  await testSharedAcrossInstances();
  await testConcurrencyRace();
  await testFailOpen();

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
