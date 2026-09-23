/**
 * Proof that the sliding window actually rolls.
 *
 * Runs the middleware directly with a tiny window (2 seconds, max 3) so the
 * whole thing finishes in a few seconds instead of two minutes. No server, no
 * HTTP — it calls the middleware with fake req/res objects and checks results.
 *
 * Usage: node scripts/verify-limiter.js
 */

const slidingWindow = require('../src/middleware/slidingWindow');

const WINDOW_MS = 2000;
const MAX = 3;

const limiter = slidingWindow({ windowMs: WINDOW_MS, max: MAX });

// Minimal fake req/res good enough for this middleware.
function call(ip) {
  return new Promise((resolve) => {
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
    limiter(req, res, () => resolve({ status: 200, headers, body: null }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(11, 23);

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${actual}, expected ${expected})`);
}

async function main() {
  console.log(`Config: max ${MAX} requests per ${WINDOW_MS / 1000}s rolling window\n`);

  console.log(`[${stamp()}] Burst of 5 from 1.1.1.1 — first ${MAX} allowed, rest blocked:`);
  for (let i = 1; i <= 5; i += 1) {
    const r = await call('1.1.1.1');
    const expected = i <= MAX ? 200 : 429;
    check(`request ${i}`, r.status, expected);
    if (r.status === 200) check(`  X-RateLimit-Remaining`, r.headers['X-RateLimit-Remaining'], MAX - i);
    if (r.status === 429) check(`  Retry-After present`, typeof r.headers['Retry-After'], 'number');
  }

  console.log(`\n[${stamp()}] A different IP is unaffected (separate bucket):`);
  const other = await call('2.2.2.2');
  check('2.2.2.2 request 1', other.status, 200);

  console.log(`\n[${stamp()}] Waiting ${WINDOW_MS / 2}ms — HALF the window. Still blocked:`);
  await sleep(WINDOW_MS / 2);
  const mid = await call('1.1.1.1');
  check('1.1.1.1 mid-window', mid.status, 429);

  console.log(`\n[${stamp()}] Waiting out the rest of the window. Slots free up one by one:`);
  await sleep(WINDOW_MS / 2 + 100);
  const after = await call('1.1.1.1');
  check('1.1.1.1 after window', after.status, 200);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  limiter.stop();
  process.exit(failures === 0 ? 0 : 1);
}

main();
