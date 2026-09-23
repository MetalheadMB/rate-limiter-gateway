/**
 * Dependency-free load test.
 *
 * Fires N requests at the gateway as fast as it can and reports how many
 * came back 200 vs 429, plus latency percentiles. Once the rate limiter is
 * actually implemented, this is the script that proves it works — run it,
 * screenshot the output, put the numbers in the README.
 *
 * Usage:
 *   npm run dev                 # in one terminal
 *   npm run loadtest            # in another
 *   npm run loadtest -- 500 50  # 500 requests, 50 at a time
 */

const http = require('http');

const TOTAL = Number(process.argv[2]) || 200;
const CONCURRENCY = Number(process.argv[3]) || 20;
const TARGET = process.env.TARGET || 'http://localhost:3000/api/data';

const url = new URL(TARGET);

function fireOne() {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();

    const req = http.get(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
      },
      (res) => {
        res.resume(); // drain the body, we only care about the status
        res.on('end', () => {
          const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
          resolve({ status: res.statusCode, ms });
        });
      }
    );

    req.on('error', (err) => resolve({ status: 0, ms: 0, error: err.code }));
  });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

async function main() {
  console.log(`Firing ${TOTAL} requests at ${TARGET} (concurrency ${CONCURRENCY})\n`);

  const results = [];
  const wallStart = Date.now();
  let dispatched = 0;

  // A fixed pool of workers, each pulling the next request off the counter.
  const worker = async () => {
    while (dispatched < TOTAL) {
      dispatched += 1;
      results.push(await fireOne());
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const wallMs = Date.now() - wallStart;
  const byStatus = results.reduce((acc, r) => {
    const key = r.error ? `error:${r.error}` : r.status;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const latencies = results
    .filter((r) => !r.error)
    .map((r) => r.ms)
    .sort((a, b) => a - b);

  console.log('Status codes:');
  for (const [status, count] of Object.entries(byStatus)) {
    const label = status === '200' ? 'allowed' : status === '429' ? 'rate limited' : '';
    console.log(`  ${status}  ${String(count).padStart(5)}  ${label}`);
  }

  console.log('\nLatency (ms):');
  console.log(`  p50  ${percentile(latencies, 50).toFixed(1)}`);
  console.log(`  p95  ${percentile(latencies, 95).toFixed(1)}`);
  console.log(`  p99  ${percentile(latencies, 99).toFixed(1)}`);

  console.log(`\nWall time: ${wallMs}ms  |  Throughput: ${(TOTAL / (wallMs / 1000)).toFixed(1)} req/s`);
}

main();
