const express = require('express');

const fixedWindow = require('./middleware/fixedWindow');
const slidingWindow = require('./middleware/slidingWindow');
const slidingWindowRedis = require('./middleware/slidingWindowRedis');
const dataRoutes = require('./routes/data.routes');

const app = express();
const PORT = process.env.PORT || 3000;
const INSTANCE_ID = process.env.INSTANCE_ID || `local-${process.pid}`;

// Client IP for per-IP limiting.
// Behind the nginx gateway (docker-compose.yml), req.ip would otherwise be
// nginx's own container IP -- every request would look like the same
// "client". Trusting one proxy hop makes Express read the IP nginx appends
// to X-Forwarded-For instead.
//
// But trust is OFF by default, on purpose: if the app is reachable directly
// (plain `npm run dev`, or a published container port), a client can send
// its own fake X-Forwarded-For header. With trust on, Express would believe
// it, so every request could claim a new IP and get a fresh rate-limit
// bucket -- a complete bypass. So TRUST_PROXY is set only in
// docker-compose.yml, where the app instances are NOT published and nginx
// is the only way in. Accepts a hop count ("1") or a comma-separated list of
// trusted proxy IPs/subnets.
const TRUST_PROXY = process.env.TRUST_PROXY;
if (TRUST_PROXY) {
  app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
}

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
