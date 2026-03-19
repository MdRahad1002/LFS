// routes/push.js
// Web Push (VAPID) push notification endpoints
// POST /api/push/subscribe               — save push subscription
// POST /api/push/unsubscribe             — remove subscription
// POST /api/push/test                    — send test notification
// (Internal) exported: sendPush(playerId, title, body, data)

const express    = require('express');
const webpush    = require('web-push');
const { Pool }   = require('pg');
const { requireAuth } = require('./auth');
const router = express.Router();
const pool   = new Pool({ connectionString: process.env.DATABASE_URL });

// Configure VAPID
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    'mailto:' + (process.env.VAPID_CONTACT || 'security@lastflagstanding.io'),
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn('[push] VAPID keys not configured. Run: npx web-push generate-vapid-keys');
}

// ─────────────────────────────────────────────────────────────
//  GET /api/push/vapid-public-key  (client needs this to subscribe)
// ─────────────────────────────────────────────────────────────
router.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
});

// ─────────────────────────────────────────────────────────────
//  POST /api/push/subscribe
//  Body: { endpoint, keys: { p256dh, auth } }
// ─────────────────────────────────────────────────────────────
router.post('/subscribe', requireAuth, async (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription object' });
  }

  try {
    await pool.query(
      `INSERT INTO push_subscriptions (player_id, endpoint, p256dh_key, auth_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (player_id, endpoint) DO UPDATE
         SET p256dh_key = $3, auth_key = $4`,
      [req.player.id, endpoint, keys.p256dh, keys.auth]
    );
    await pool.query(
      'UPDATE players SET push_enabled=true WHERE id=$1',
      [req.player.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/push/unsubscribe
// ─────────────────────────────────────────────────────────────
router.post('/unsubscribe', requireAuth, async (req, res) => {
  const { endpoint } = req.body;
  await pool.query(
    'DELETE FROM push_subscriptions WHERE player_id=$1 AND endpoint=$2',
    [req.player.id, endpoint || null]
  );
  // Disable if no more subscriptions
  const { rows } = await pool.query(
    'SELECT COUNT(*) FROM push_subscriptions WHERE player_id=$1',
    [req.player.id]
  );
  if (parseInt(rows[0].count) === 0) {
    await pool.query('UPDATE players SET push_enabled=false WHERE id=$1', [req.player.id]);
  }
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
//  POST /api/push/test
// ─────────────────────────────────────────────────────────────
router.post('/test', requireAuth, async (req, res) => {
  const count = await sendPush(req.player.id, '🚩 Last Flag Standing', 'Push notifications are working!', {
    url: '/hub.html',
  });
  res.json({ sent: count });
});

// ─────────────────────────────────────────────────────────────
//  INTERNAL: sendPush(playerId, title, body, data?)
//  Returns the number of notifications successfully sent.
// ─────────────────────────────────────────────────────────────
async function sendPush(playerId, title, body, data = {}) {
  let subs;
  try {
    const { rows } = await pool.query(
      'SELECT endpoint, p256dh_key, auth_key FROM push_subscriptions WHERE player_id=$1',
      [playerId]
    );
    subs = rows;
  } catch {
    return 0;
  }

  const payload = JSON.stringify({ title, body, data, icon: '/icons/icon-192.png' });
  let sent = 0;

  for (const sub of subs) {
    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh_key, auth: sub.auth_key },
      }, payload);
      sent++;
    } catch (err) {
      // Remove expired/invalid subscriptions
      if (err.statusCode === 410 || err.statusCode === 404) {
        await pool.query(
          'DELETE FROM push_subscriptions WHERE endpoint=$1',
          [sub.endpoint]
        ).catch(() => {});
      }
    }
  }
  return sent;
}

// ─────────────────────────────────────────────────────────────
//  INTERNAL: broadcastToRound(roundId, title, body, data?)
//  Send a push to all players holding territories in a round.
// ─────────────────────────────────────────────────────────────
async function broadcastToRound(roundId, title, body, data = {}) {
  const { rows } = await pool.query(
    `SELECT DISTINCT h.player_id
     FROM   holdings h
     JOIN   players p ON p.id = h.player_id
     WHERE  h.round_id = $1 AND p.push_enabled = true`,
    [roundId]
  );
  await Promise.allSettled(
    rows.map(r => sendPush(r.player_id, title, body, data))
  );
}

module.exports = router;
module.exports.sendPush          = sendPush;
module.exports.broadcastToRound  = broadcastToRound;
