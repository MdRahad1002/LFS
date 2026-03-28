// routes/lottery.js
// Territory Lottery API — weekly pot game
//
// GET  /api/lottery/rounds                  — list all rounds (history + active)
// GET  /api/lottery/rounds/current          — active round + full territory breakdown
// GET  /api/lottery/rounds/:id              — single round details
// POST /api/lottery/rounds/:id/buy          — validate buy intent (auth required)
// POST /api/lottery/rounds/:id/confirm-buy  — record confirmed on-chain purchase (auth required)
// GET  /api/lottery/rounds/:id/my-tickets   — player's ticket positions + odds (auth required)
// GET  /api/lottery/rounds/:id/leaderboard  — top territories + top players
// POST /api/lottery/rounds/:id/claim        — record claimed payout tx (auth required)
// POST /api/lottery/rounds/:id/draw         — trigger draw (ADMIN only)
// POST /api/lottery/rounds/new              — start new round (ADMIN only)

'use strict';

const express        = require('express');
const { Pool }       = require('pg');
const { requireAuth } = require('./auth');

const router = express.Router();
const pool   = new Pool({ connectionString: process.env.DATABASE_URL });

const ADMIN_WALLETS = (process.env.ADMIN_WALLETS || '')
  .toLowerCase()
  .split(',')
  .filter(Boolean);

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (!req.player) return res.status(401).json({ error: 'Not signed in' });
  if (!ADMIN_WALLETS.includes(req.player.wallet_address.toLowerCase())) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

/** Parse integer with safe fallback and upper bound. */
function safeInt(val, def, max) {
  const n = parseInt(val, 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return max !== undefined ? Math.min(n, max) : n;
}

/** Build the per-territory ticket stats for a given round (all 195 territories). */
async function buildTerritoryStats(roundId) {
  const { rows } = await pool.query(
    `SELECT tn.territory_id,
            tn.country_name,
            tn.country_code,
            tn.flag_emoji,
            COALESCE(agg.ticket_count, 0)::int AS ticket_count,
            COALESCE(agg.player_count, 0)::int AS player_count
     FROM   territory_names tn
     LEFT JOIN (
       SELECT   territory_id,
                SUM(quantity)             AS ticket_count,
                COUNT(DISTINCT player_id) AS player_count
       FROM     lottery_tickets
       WHERE    round_id = $1
       GROUP BY territory_id
     ) agg ON agg.territory_id = tn.territory_id
     ORDER BY tn.territory_id`,
    [roundId]
  );

  const totalTickets = rows.reduce((s, r) => s + r.ticket_count, 0);
  return {
    territories: rows.map(r => ({
      ...r,
      odds_pct: totalTickets > 0
        ? ((r.ticket_count / totalTickets) * 100).toFixed(2)
        : '0.00',
    })),
    totalTickets,
  };
}

// ─── GET /api/lottery/rounds ─────────────────────────────────────────────────

router.get('/rounds', async (req, res) => {
  const limit  = safeInt(req.query.limit,  20, 100);
  const offset = safeInt(req.query.offset,  0);
  try {
    const { rows } = await pool.query(
      `SELECT lr.*,
              tn.country_name AS winner_country,
              tn.flag_emoji   AS winner_flag
       FROM   lottery_rounds lr
       LEFT JOIN territory_names tn ON tn.territory_id = lr.winner_territory_id
       ORDER BY lr.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ rounds: rows });
  } catch (err) {
    console.error('[lottery] GET /rounds:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── GET /api/lottery/rounds/current ─────────────────────────────────────────
// Must be registered BEFORE /:id to avoid param collision

router.get('/rounds/current', async (req, res) => {
  try {
    const { rows: roundRows } = await pool.query(
      `SELECT * FROM lottery_rounds
       WHERE  status IN ('entry', 'drawing')
       ORDER BY created_at DESC
       LIMIT 1`
    );
    if (!roundRows.length) return res.json({ round: null, territories: [], totalTickets: 0 });

    const round = roundRows[0];
    const stats = await buildTerritoryStats(round.id);

    res.json({ round, ...stats });
  } catch (err) {
    console.error('[lottery] GET /rounds/current:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── GET /api/lottery/rounds/:id ─────────────────────────────────────────────

router.get('/rounds/:id', async (req, res) => {
  const roundId = safeInt(req.params.id, 0);
  if (!roundId) return res.status(400).json({ error: 'Invalid round ID' });

  try {
    const { rows } = await pool.query(
      `SELECT lr.*,
              tn.country_name AS winner_country,
              tn.flag_emoji   AS winner_flag
       FROM   lottery_rounds lr
       LEFT JOIN territory_names tn ON tn.territory_id = lr.winner_territory_id
       WHERE  lr.id = $1`,
      [roundId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Round not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── POST /api/lottery/rounds/:id/buy ────────────────────────────────────────
// Validates buy intent; client then submits MetaMask tx and calls /confirm-buy.

router.post('/rounds/:id/buy', requireAuth, async (req, res) => {
  const roundId    = safeInt(req.params.id, 0);
  const territoryId = parseInt(req.body.territoryId, 10);
  const quantity   = safeInt(req.body.quantity, 0, 1000);

  if (!roundId)
    return res.status(400).json({ error: 'Invalid round ID' });
  if (!Number.isInteger(territoryId) || territoryId < 1 || territoryId > 195)
    return res.status(400).json({ error: 'Invalid territory (1–195)' });
  if (quantity < 1)
    return res.status(400).json({ error: 'Quantity must be 1–1000' });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM lottery_rounds WHERE id = $1 AND status = 'entry'`,
      [roundId]
    );
    if (!rows.length)
      return res.status(400).json({ error: 'Round not open for entry' });
    if (new Date(rows[0].end_time) < new Date())
      return res.status(400).json({ error: 'Round entry period has ended' });

    res.json({
      ok:          true,
      roundId,
      territoryId,
      quantity,
      message:     'Submit on-chain tx, then POST /confirm-buy with txHash',
    });
  } catch (err) {
    console.error('[lottery] POST /buy:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── POST /api/lottery/rounds/:id/confirm-buy ────────────────────────────────

router.post('/rounds/:id/confirm-buy', requireAuth, async (req, res) => {
  const roundId          = safeInt(req.params.id, 0);
  const territoryId      = parseInt(req.body.territoryId, 10);
  const quantity         = safeInt(req.body.quantity, 0, 1000);
  const { txHash, totalPaidWei = '0', pricePerTicketWei = '0' } = req.body;

  if (!roundId)
    return res.status(400).json({ error: 'Invalid round ID' });
  if (!Number.isInteger(territoryId) || territoryId < 1 || territoryId > 195)
    return res.status(400).json({ error: 'Invalid territory' });
  if (quantity < 1)
    return res.status(400).json({ error: 'Invalid quantity' });
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash))
    return res.status(400).json({ error: 'Invalid tx hash' });

  // Sanitize numeric strings — only digits allowed
  if (!/^\d+$/.test(totalPaidWei) || !/^\d+$/.test(pricePerTicketWei))
    return res.status(400).json({ error: 'Invalid wei amounts' });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM lottery_rounds WHERE id = $1`,
      [roundId]
    );
    if (!rows.length)
      return res.status(404).json({ error: 'Round not found' });
    if (!['entry', 'drawing'].includes(rows[0].status))
      return res.status(400).json({ error: 'Round is not accepting purchases' });

    // tx_hash has a UNIQUE constraint — prevents double-credit on replay
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO lottery_tickets
           (round_id, territory_id, player_id, quantity,
            price_per_ticket_wei, total_paid_wei, tx_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tx_hash) DO NOTHING`,
        [roundId, territoryId, req.player.id, quantity,
         pricePerTicketWei, totalPaidWei, txHash]
      );

      await client.query(
        `UPDATE lottery_rounds
         SET    jackpot_wei   = jackpot_wei   + $1,
                total_tickets = total_tickets + $2
         WHERE  id = $3`,
        [totalPaidWei, quantity, roundId]
      );

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    // Broadcast live jackpot update to all spectators
    const { rows: updated } = await pool.query(
      `SELECT jackpot_wei, total_tickets FROM lottery_rounds WHERE id = $1`, [roundId]
    );
    if (updated.length) {
      req.app.locals.io?.emit('lottery_jackpot_update', {
        roundId,
        jackpotWei:   updated[0].jackpot_wei.toString(),
        totalTickets: parseInt(updated[0].total_tickets),
        territoryId,
        qty:          quantity,
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[lottery] POST /confirm-buy:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── GET /api/lottery/rounds/:id/my-tickets ──────────────────────────────────

router.get('/rounds/:id/my-tickets', requireAuth, async (req, res) => {
  const roundId = safeInt(req.params.id, 0);
  if (!roundId) return res.status(400).json({ error: 'Invalid round ID' });

  try {
    // Player's positions in this round
    const { rows: myRows } = await pool.query(
      `SELECT lt.territory_id,
              tn.country_name,
              tn.country_code,
              tn.flag_emoji,
              SUM(lt.quantity)::int       AS my_tickets,
              SUM(lt.total_paid_wei)      AS total_paid
       FROM   lottery_tickets lt
       JOIN   territory_names tn ON tn.territory_id = lt.territory_id
       WHERE  lt.round_id = $1 AND lt.player_id = $2
       GROUP  BY lt.territory_id, tn.country_name, tn.country_code, tn.flag_emoji
       ORDER  BY my_tickets DESC`,
      [roundId, req.player.id]
    );

    // Grand total tickets for this round (for odds calculation)
    const { rows: totRows } = await pool.query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS grand_total,
              territory_id,
              SUM(quantity)::int              AS terr_total
       FROM   lottery_tickets
       WHERE  round_id = $1
       GROUP BY territory_id`,
      [roundId]
    );

    const grandTotal = totRows.reduce((s, r) => s + r.terr_total, 0);
    const terrTotals = Object.fromEntries(totRows.map(r => [r.territory_id, r.terr_total]));

    const territories = myRows.map(r => ({
      ...r,
      terr_total_tickets: terrTotals[r.territory_id] || 0,
      // Odds of winning pot = my tickets / grand total tickets for entire round
      odds_pct: grandTotal > 0
        ? ((r.my_tickets / grandTotal) * 100).toFixed(3)
        : '0.000',
    }));

    res.json({ territories, grandTotal });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── GET /api/lottery/rounds/:id/leaderboard  ────────────────────────────────

router.get('/rounds/:id/leaderboard', async (req, res) => {
  const roundId = safeInt(req.params.id, 0);
  if (!roundId) return res.status(400).json({ error: 'Invalid round ID' });

  try {
    const [terrRes, playersRes] = await Promise.all([
      pool.query(
        `SELECT lt.territory_id,
                tn.country_name,
                tn.flag_emoji,
                SUM(lt.quantity)::int             AS ticket_count,
                COUNT(DISTINCT lt.player_id)::int AS player_count
         FROM   lottery_tickets lt
         JOIN   territory_names tn ON tn.territory_id = lt.territory_id
         WHERE  lt.round_id = $1
         GROUP  BY lt.territory_id, tn.country_name, tn.flag_emoji
         ORDER  BY ticket_count DESC
         LIMIT  10`,
        [roundId]
      ),
      pool.query(
        `SELECT p.username,
                CONCAT(LEFT(p.wallet_address, 6), '...', RIGHT(p.wallet_address, 4)) AS wallet_short,
                SUM(lt.quantity)::int AS total_tickets,
                SUM(lt.total_paid_wei) AS total_spent_wei
         FROM   lottery_tickets lt
         JOIN   players p ON p.id = lt.player_id
         WHERE  lt.round_id = $1
         GROUP  BY p.id, p.username, p.wallet_address
         ORDER  BY total_tickets DESC
         LIMIT  10`,
        [roundId]
      ),
    ]);

    res.json({
      territories: terrRes.rows,
      players:     playersRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── POST /api/lottery/rounds/:id/claim ──────────────────────────────────────

router.post('/rounds/:id/claim', requireAuth, async (req, res) => {
  const roundId = safeInt(req.params.id, 0);
  if (!roundId) return res.status(400).json({ error: 'Invalid round ID' });

  const { txHash } = req.body;
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash))
    return res.status(400).json({ error: 'Invalid tx hash' });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM lottery_rounds WHERE id = $1 AND status = 'complete'`,
      [roundId]
    );
    if (!rows.length)
      return res.status(400).json({ error: 'Round not complete or not found' });

    const round = rows[0];

    // Check player has winning tickets
    const { rows: myRows } = await pool.query(
      `SELECT COALESCE(SUM(quantity), 0)::int AS qty
       FROM   lottery_tickets
       WHERE  round_id = $1 AND territory_id = $2 AND player_id = $3`,
      [roundId, round.winner_territory_id, req.player.id]
    );
    const myTickets = myRows[0]?.qty || 0;
    if (myTickets === 0)
      return res.status(400).json({ error: 'No winning tickets in this round' });

    // Compute payout
    const { rows: totRows } = await pool.query(
      `SELECT COALESCE(SUM(quantity), 0)::bigint AS total
       FROM   lottery_tickets
       WHERE  round_id = $1 AND territory_id = $2`,
      [roundId, round.winner_territory_id]
    );
    const totalWinner  = BigInt(totRows[0]?.total || '1');
    const distributable = BigInt(round.jackpot_wei.toString()) * BigInt(9600) / BigInt(10_000);
    const payoutWei    = (distributable * BigInt(myTickets) / totalWinner).toString();

    // Upsert payout record (idempotent)
    await pool.query(
      `INSERT INTO lottery_payouts
         (round_id, player_id, territory_id, ticket_count, payout_wei, claimed_at, tx_hash)
       VALUES ($1, $2, $3, $4, $5, now(), $6)
       ON CONFLICT (round_id, player_id)
         DO UPDATE SET claimed_at = now(), tx_hash = EXCLUDED.tx_hash`,
      [roundId, req.player.id, round.winner_territory_id, myTickets, payoutWei, txHash]
    );

    res.json({ ok: true, payoutWei });
  } catch (err) {
    console.error('[lottery] POST /claim:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── POST /api/lottery/rounds/:id/draw  (ADMIN) ───────────────────────────────

router.post('/rounds/:id/draw', requireAuth, requireAdmin, async (req, res) => {
  const roundId = safeInt(req.params.id, 0);
  if (!roundId) return res.status(400).json({ error: 'Invalid round ID' });

  try {
    const { rows } = await pool.query(
      `SELECT * FROM lottery_rounds WHERE id = $1`,
      [roundId]
    );
    if (!rows.length)
      return res.status(404).json({ error: 'Round not found' });
    if (rows[0].status !== 'entry')
      return res.status(400).json({ error: 'Round is not in entry phase' });

    await pool.query(
      `UPDATE lottery_rounds SET status = 'drawing' WHERE id = $1`,
      [roundId]
    );

    // Signal LotteryEngine (attached to app.locals by server.js)
    const engine = req.app.locals.lotteryEngine;
    if (engine) engine.emit('draw_requested', { roundId });

    res.json({ ok: true, message: `Draw triggered for round ${roundId}` });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ─── POST /api/lottery/rounds/new  (ADMIN) ────────────────────────────────────
// Must be registered AFTER /:id/draw to avoid route conflict

router.post('/rounds/new', requireAuth, requireAdmin, async (req, res) => {
  const engine = req.app.locals.lotteryEngine;
  if (!engine) return res.status(500).json({ error: 'Lottery engine not initialized' });
  try {
    const round = await engine.startNewRound();
    res.json({ ok: true, round });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/lottery/config ─────────────────────────────────────────────────
// Returns public runtime config needed by the frontend (contract address, etc.)

router.get('/config', (_req, res) => {
  res.json({
    contractAddress: process.env.CONTRACT_LOTTERY || null,
    ticketPriceUsd:  20,
    chainId:         parseInt(process.env.CHAIN_ID || '1', 10),
  });
});

// ─── GET /api/lottery/rounds  (must stay last in file order) ─────────────────

module.exports = router;
