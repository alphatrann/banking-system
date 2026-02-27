require('dotenv/config');
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.raw({ type: '*/*' }));

/* -------------------------------------------------------------------------- */
/*                              CONFIGURATION                                 */
/* -------------------------------------------------------------------------- */

const PORT = 8000;
const SHARED_SECRET = process.env.WEBHOOK_SECRET;

const MAX_REQUESTS_PER_WINDOW = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

let requestCount = 0;

setInterval(() => {
  requestCount = 0;
}, RATE_LIMIT_WINDOW_MS);

/* -------------------------------------------------------------------------- */
/*                              UTILITIES                                     */
/* -------------------------------------------------------------------------- */

function randomDelay(min = 50, max = 3000) {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.floor(Math.random() * (max - min) + min)),
  );
}

function weightedScenario() {
  const rand = Math.random();

  if (rand < 0.5) return 'success';
  if (rand < 0.7) return 'server_error';
  if (rand < 0.8) return 'timeout';
  if (rand < 0.9) return 'connection_drop';
  return 'client_error';
}

function verifySignature(req) {
  const signature = req.headers['x-webhook-signature']; // X-Webhook-Signature: t=1708700000,v1=abcdef123456...
  if (!signature) return false;

  const [timestampPart, sigPart] = signature.split(',');
  const timestamp = timestampPart.split('=')[1];
  const receivedSig = sigPart.split('=')[1];

  const payload = req.body.toString();
  const signedPayload = `${timestamp}.${payload}`;

  const expectedSig = crypto
    .createHmac('sha256', SHARED_SECRET)
    .update(signedPayload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(receivedSig),
    Buffer.from(expectedSig),
  );
}

/* -------------------------------------------------------------------------- */
/*                              WEBHOOK ENDPOINT                              */
/* -------------------------------------------------------------------------- */

app.post('/webhook', async (req, res) => {
  const requestId = crypto.randomUUID();
  requestCount++;

  console.log(`[${requestId}] Incoming webhook. Count: ${requestCount}`);

  /* --------------------------- Burst Rate Limit ---------------------------- */

  if (requestCount > MAX_REQUESTS_PER_WINDOW) {
    console.log(`[${requestId}] Burst rate limit triggered`);
    const secondsAfter = 60;

    res.set(
      'Retry-After',
      Math.random() < 0.5
        ? secondsAfter.toString()
        : new Date(Date.now() + secondsAfter * 1000).toUTCString(),
    );
    return res.status(429).json({
      error: 'Burst rate limit exceeded',
    });
  }

  /* --------------------------- Signature Check ----------------------------- */

  if (!verifySignature(req)) {
    console.log(`[${requestId}] Invalid signature`);
    return res.status(401).json({
      error: 'Invalid signature',
    });
  }

  /* --------------------------- Scenario Selection -------------------------- */

  const scenario = weightedScenario();
  console.log(`[${requestId}] Scenario: ${scenario}`);

  switch (scenario) {
    case 'success':
      await randomDelay();
      return res.status(200).json({
        received: true,
        requestId,
        timestamp: Date.now(),
      });

    case 'client_error':
      await randomDelay();
      return res.status(400).json({
        error: 'Simulated permanent failure',
        requestId,
      });

    case 'server_error':
      await randomDelay();
      return res.status(500).json({
        error: 'Simulated transient server failure',
        requestId,
      });

    case 'timeout':
      console.log(`[${requestId}] Simulating timeout (15s delay)`);
      await randomDelay(15_000, 20_000);
      return res.status(200).json({
        message: 'If your worker waited, it survived.',
      });

    case 'connection_drop':
      console.log(`[${requestId}] Simulating connection drop`);
      req.socket.destroy();
      return;

    default:
      return res.status(200).json({ ok: true });
  }
});

/* -------------------------------------------------------------------------- */
/*                                  START                                     */
/* -------------------------------------------------------------------------- */

app.listen(PORT, () => {
  console.log(`🔥 Chaos webhook listening at http://localhost:${PORT}/webhook`);
});
