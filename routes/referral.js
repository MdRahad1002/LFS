// routes/referral.js
// GET  /api/referral/my-code       — get player's code + stats
// GET  /api/referral/leaderboard   — top referrers
// POST /api/referral/track-click   — log click (for attribution)

const express  = require('express');
const { Pool } = require('pg');
const { requireAuth } = require('./auth');
const router = express.Router();
const pool   = new Pool({ connectionString: process.env.DATABASE_URL });

// ─────────────────────────────────────────────────────────────
//  GET /api/referral/my-code
// ─────────────────────────────────────────────────────────────
router.get('/my-code', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.referral_code, p.referral_fc,
            COUNT(r.id)::int      AS total_referrals,
            COALESCE(SUM(r.fc_credited),0)::int AS total_fc_earned
     FROM   players p
     LEFT JOIN referrals r ON r.referrer_id = p.id
     WHERE  p.id = $1
     GROUP BY p.referral_code, p.referral_fc`,
    [req.player.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });

  const domain = process.env.DOMAIN || 'lastflagstanding.io';
  res.json({
    code:           rows[0].referral_code,
    link:           `https://${domain}/?ref=${rows[0].referral_code}`,
    totalReferrals: rows[0].total_referrals,
    totalFcEarned:  rows[0].total_fc_earned,
  });
});

// ─────────────────────────────────────────────────────────────
//  GET /api/referral/leaderboard
// ─────────────────────────────────────────────────────────────
router.get('/leaderboard', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.username, p.wallet_address, p.rank_tier,
            COUNT(r.id)::int            AS referral_count,
            COALESCE(SUM(r.fc_credited),0)::int AS fc_earned
     FROM   players p
     JOIN   referrals r ON r.referrer_id = p.id
     GROUP BY p.id, p.username, p.wallet_address, p.rank_tier
     ORDER BY referral_count DESC
     LIMIT 50`
  );
  res.json({ leaderboard: rows });
});

// ─────────────────────────────────────────────────────────────
//  POST /api/referral/track-click
//  Called when someone lands on ?ref=CODE before signing in
// ─────────────────────────────────────────────────────────────
router.post('/track-click', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });

  try {
    await pool.query(
      `INSERT INTO analytics_events (event_type, properties)
       VALUES ('referral_click', $1)`,
      [JSON.stringify({ code })]
    );
    res.json({ ok: true });
  } catch {
    res.json({ ok: true }); // Never fail a click track
  }
});

module.exports = router;
