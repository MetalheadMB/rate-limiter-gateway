const express = require('express');

const router = express.Router();

/**
 * Simulated upstream work.
 * Real backends do I/O (DB reads, network hops), so a pure in-memory
 * response would make load tests unrealistically fast. A ~50ms delay
 * gives the gateway something meaningful to sit in front of.
 */
const ARTIFICIAL_DELAY_MS = 50;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// GET /api/data — mock "backend" endpoint the gateway protects.
router.get('/data', async (req, res) => {
  await delay(ARTIFICIAL_DELAY_MS);

  res.json({
    success: true,
    servedAt: new Date().toISOString(),
    latencyMs: ARTIFICIAL_DELAY_MS,
    data: [
      { id: 1, name: 'alpha', value: 42 },
      { id: 2, name: 'beta', value: 17 },
      { id: 3, name: 'gamma', value: 99 },
    ],
  });
});

module.exports = router;
