const express = require('express');

const fixedWindow = require('./middleware/fixedWindow');
const slidingWindow = require('./middleware/slidingWindow');
const slidingWindowRedis = require('./middleware/slidingWindowRedis');
const dataRoutes = require('./routes/data.routes');

const app = express();
const PORT = process.env.PORT || 3000;
const INSTANCE_ID = process.env.INSTANCE_ID || `local-${process.pid}`;

// Behind the nginx gateway (docker-compose.yml), req.ip would otherwise be
// nginx's own container IP, not the real client -- every request would look
// like it came from the same "client", which breaks per-IP limiting. Trust
// the X-Forwarded-For header nginx sets so req.ip is the real caller again.
// Safe to enable unconditionally: with no proxy in front (plain `npm run
// dev`), there's no X-Forwarded-For to trust and req.ip falls back to the
// direct connection, same as before.
app.set('trust proxy', 1);

// --- rate limit strategy selection -----------------------------------------
// Three interchangeable middlewares, same interface, picked by env var so
// they can be compared side by side without editing code:
//   fixed          -- src/middleware/fixedWindow.js        (in-memory, has the boundary-burst flaw, for comparison)
//   memory-sliding -- src/middleware/slidingWindow.js       (in-memory, correct on one instance, NOT shared across instances)
//   redis-sliding  -- src/middleware/slidingWindowRedis.js  (shared across every instance -- the one docker-compose.yml runs)
//
// Default: redis-sliding when REDIS_URL is set (i.e. running under
// docker-compose), otherwise memory-sliding -- so `npm install && npm run
// dev` keeps working exactly as before with no Redis required.
const RATE_LIMIT_OPTIONS = { windowMs: 60 * 1000, max: 10 };
const strategy = process.env.RATE_LIMIT_STRATEGY || (process.env.REDIS_URL ? 'redis-sliding' : 'memory-sliding');

const STRATEGIES = {
  fixed: () => fixedWindow(RATE_LIMIT_OPTIONS),
  'memory-sliding': () => slidingWindow(RATE_LIMIT_OPTIONS),
  'redis-sliding': () => slidingWindowRedis(RATE_LIMIT_OPTIONS),
};

if (!STRATEGIES[strategy]) {
  throw new Error(`Unknown RATE_LIMIT_STRATEGY "${strategy}". Valid values: ${Object.keys(STRATEGIES).join(', ')}`);
}

const apiDataLimiter = STRATEGIES[strategy]();
console.log(`[rate-limit] strategy = ${strategy} (${RATE_LIMIT_OPTIONS.max} req / ${RATE_LIMIT_OPTIONS.windowMs / 1000}s)`);
// ----------------------------------------------------------------------------

// Parse JSON bodies.
app.use(express.json());

// Tiny request logger, tagged with which instance served the request --
// handy when multiple instances are running behind the gateway and you want
// to see the load balancer actually alternating between them.
app.use((req, res, next) => {
  const start = Date.now();
  res.setHeader('X-Served-By', INSTANCE_ID);
  res.on('finish', () => {
    console.log(`[${INSTANCE_ID}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// Gateway layer: every /api/data request passes through the rate limiter first.
app.use('/api/data', apiDataLimiter);
app.use('/api', dataRoutes);

// Liveness probe -- deliberately NOT rate limited.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', instance: INSTANCE_ID, uptimeSeconds: Math.round(process.uptime()) });
});

// 404 fallback.
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', path: req.originalUrl });
});

// Centralized error handler.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[${INSTANCE_ID}] Gateway listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
module.exports.apiDataLimiter = apiDataLimiter;
