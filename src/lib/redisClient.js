/**
 * Shared ioredis client, created once and reused by any middleware that
 * needs Redis (currently just slidingWindowRedis.js).
 *
 * Configuration is entirely via REDIS_URL so the same code runs unchanged
 * whether you're pointing at a local redis-server, the `redis` service in
 * docker-compose.yml, or a managed Redis in production.
 */

const Redis = require('ioredis');

let client = null;

function getRedisClient() {
  if (client) return client;

  const url = process.env.REDIS_URL || 'redis://localhost:6379';

  client = new Redis(url, {
    // Fail fast rather than queueing commands indefinitely when Redis is
    // down -- the rate limiter middleware relies on this to fail OPEN
    // quickly instead of hanging every request while it waits.
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });

  client.on('error', (err) => {
    // ioredis retries connections in the background; this just logs so a
    // Redis outage is visible in the server's own logs, not silent.
    console.error(`[redis] connection error: ${err.message}`);
  });

  client.on('connect', () => {
    console.log(`[redis] connected (${url})`);
  });

  return client;
}

module.exports = getRedisClient;
