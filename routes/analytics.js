// routes/analytics.js
// Internal analytics endpoints (admin only)
// GET /api/analytics/overview       — daily summary
// GET /api/analytics/players        — player growth
// GET /api/analytics/revenue        — deposit/payout/house fee breakdown
// GET /api/analytics/territories    — hottest + deadliest territories
// GET /api/analytics/retention      — churn / session length / streak data
// POST /api/analytics/event         — client-side event tracking

const express  = require('express');
const { Pool } = require('pg');
const { requireAuth } = require('./auth');
const router = express.Router();
const pool   = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Admin auth middleware ───────────────────────────────────
function requireAdmin(req, res, next) {
  const adminWallets = (process.env.ADMIN_WALLETS || '').toLowerCase().split(',');
  if (!req.player?.wallet || !adminWallets.includes(req.player.wallet.toLowerCase())) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// ─────────────────────────────────────────────────────────────
//  GET /api/analytics/overview
// ─────────────────────────────────────────────────────────────
router.get('/overview', requireAuth, requireAdmin, async (req, res) => {
  const { days = 7 } = req.query;
  try {
    const [playerStats, txStats, roundStats, activeToday] = await Promise.all([
      // New players per day
      pool.query(`
        SELECT DATE(created_at) AS day, COUNT(*)::int AS new_players
        FROM players
        WHERE created_at >= now() - ($1 || ' days')::interval
        GROUP BY day ORDER BY day
      `, [days]),

      // Daily deposit/payout volume in ETH
      pool.query(`
        SELECT DATE(created_at) AS day, type,
               COUNT(*)::int AS count,
               SUM(amount_wei)::numeric AS total_wei
        FROM transactions
        WHERE created_at >= now() - ($1 || ' days')::interval
          AND status = 'confirmed'
        GROUP BY day, type ORDER BY day
      `, [days]),

      // Rounds completed
      pool.query(`
        SELECT DATE(created_at) AS day, COUNT(*)::int AS rounds,
               AVG(jackpot_wei)::numeric AS avg_jackpot_wei
        FROM rounds
        WHERE created_at >= now() - ($1 || ' days')::interval
          AND status = 'complete'
        GROUP BY day ORDER BY day
      `, [days]),

      // Active players today
      pool.query(`
        SELECT COUNT(DISTINCT player_id)::int AS active_today
        FROM analytics_events
        WHERE created_at >= CURRENT_DATE
      `),
    ]);

    res.json({
      playerGrowth:  playerStats.rows,
      transactions:  txStats.rows,
      rounds:        roundStats.rows,
      activeToday:   activeToday.rows[0]?.active_today ?? 0,
    });
  } catch (err) {
    console.error('[analytics] overview error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /api/analytics/revenue
// ─────────────────────────────────────────────────────────────
router.get('/revenue', requireAuth, requireAdmin, async (req, res) => {
  const { days = 30 } = req.query;
  try {
    const { rows } = await pool.query(`
      SELECT
        DATE(created_at)                AS day,
        SUM(CASE WHEN type='deposit'   THEN amount_wei ELSE 0 END)::numeric AS deposit_wei,
        SUM(CASE WHEN type='payout'    THEN amount_wei ELSE 0 END)::numeric AS payout_wei,
        COUNT(CASE WHEN type='deposit' THEN 1 END)::int                     AS deposit_count,
        COUNT(CASE WHEN type='payout'  THEN 1 END)::int                     AS payout_count
      FROM transactions
      WHERE created_at >= now() - ($1 || ' days')::interval
        AND status = 'confirmed'
      GROUP BY day ORDER BY day DESC
    `, [days]);
    res.json({ revenue: rows });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /api/analytics/territories
// ─────────────────────────────────────────────────────────────
router.get('/territories', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [hottest, mostEliminated] = await Promise.all([
      // Most purchased territories (overall)
      pool.query(`
        SELECT h.territory_id, t.country_name, t.flag_emoji,
               SUM(h.slots)::int AS total_slots,
               COUNT(DISTINCT h.player_id)::int AS unique_holders
        FROM   holdings h
        JOIN   territory_names t ON t.territory_id = h.territory_id
        GROUP BY h.territory_id, t.country_name, t.flag_emoji
        ORDER BY total_slots DESC LIMIT 20
      `),
      // Most eliminated
      pool.query(`
        SELECT te.territory_id, tn.country_name, tn.flag_emoji,
               COUNT(*)::int AS times_eliminated
        FROM   territories te
        JOIN   territory_names tn ON tn.territory_id = te.territory_id
        WHERE  te.is_eliminated = true
        GROUP BY te.territory_id, tn.country_name, tn.flag_emoji
        ORDER BY times_eliminated DESC LIMIT 20
      `),
    ]);
    res.json({ hottest: hottest.rows, mostEliminated: mostEliminated.rows });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /api/analytics/retention
// ─────────────────────────────────────────────────────────────
router.get('/retention', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [streakDist, rankDist, kycFunnel] = await Promise.all([
      pool.query(`
        SELECT streak_days, COUNT(*)::int AS player_count
        FROM players
        GROUP BY streak_days ORDER BY streak_days
      `),
      pool.query(`
        SELECT rank_tier, COUNT(*)::int AS count
        FROM players GROUP BY rank_tier
        ORDER BY CASE rank_tier
          WHEN 'emperor'   THEN 1
          WHEN 'warlord'   THEN 2
          WHEN 'general'   THEN 3
          WHEN 'commander' THEN 4
          WHEN 'soldier'   THEN 5
          ELSE 6 END
      `),
      pool.query(`
        SELECT kyc_status, COUNT(*)::int AS count
        FROM players GROUP BY kyc_status
      `),
    ]);
    res.json({
      streakDistribution: streakDist.rows,
      rankDistribution:   rankDist.rows,
      kycFunnel:          kycFunnel.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/analytics/event  (client-side event tracking)
//  Public — no auth required. Rate limited upstream (nginx).
// ─────────────────────────────────────────────────────────────
router.post('/event', async (req, res) => {
  const { eventType, sessionId, properties } = req.body;
  if (!eventType) return res.status(400).json({ error: 'eventType required' });

  const allowedEvents = new Set([
    'page_view', 'deposit_start', 'deposit_complete', 'round_join',
    'territory_buy', 'territory_sell', 'elimination_watch', 'kyc_start', 'referral_click',
  ]);
  if (!allowedEvents.has(eventType)) return res.status(400).json({ error: 'Unknown event type' });

  const ipHash = require('crypto')
    .createHash('sha256')
    .update(req.ip + process.env.IP_SALT || '')
    .digest('hex');

  try {
    await pool.query(
      `INSERT INTO analytics_events (player_id, session_id, event_type, properties, ip_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.player?.id || null, sessionId || null,
       eventType, JSON.stringify(properties || {}), ipHash]
    );
    res.json({ ok: true });
  } catch {
    res.json({ ok: true }); // Never break client on analytics failure
  }
});

module.exports = router;
module.exports.requireAdmin = requireAdmin;
