// routes/market.js
// Territory P2P trading order book API (mirrors on-chain TerritoryMarket)
// GET    /api/market/listings              — get open listings with optional filters
// GET    /api/market/listings/:id          — single listing
// POST   /api/market/list                  — create listing (off-chain record; submit tx client-side)
// POST   /api/market/confirm-list          — confirm on-chain tx hash for listing
// POST   /api/market/confirm-buy           — confirm buy tx (updates order book)
// POST   /api/market/cancel/:id            — cancel listing
// GET    /api/market/my-listings           — authenticated player's listings
// GET    /api/market/history/:territoryId  — recent sales for a territory

const express  = require('express');
const { Pool } = require('pg');
const { requireAuth } = require('./auth');
const router = express.Router();
const pool   = new Pool({ connectionString: process.env.DATABASE_URL });

// ─────────────────────────────────────────────────────────────
//  GET /api/market/listings
// ─────────────────────────────────────────────────────────────
router.get('/listings', async (req, res) => {
  const { roundId, territoryId, minPrice, maxPrice, limit = 50, offset = 0 } = req.query;

  const conditions = ["o.status = 'open'"];
  const params     = [];
  let   p          = 1;

  if (roundId)     { conditions.push(`o.round_id = $${p++}`);       params.push(roundId); }
  if (territoryId) { conditions.push(`o.territory_id = $${p++}`);   params.push(territoryId); }
  if (minPrice)    { conditions.push(`o.price_per_slot_wei >= $${p++}`); params.push(minPrice); }
  if (maxPrice)    { conditions.push(`o.price_per_slot_wei <= $${p++}`); params.push(maxPrice); }

  params.push(Math.min(parseInt(limit), 200), parseInt(offset));

  try {
    const { rows } = await pool.query(
      `SELECT o.*,
              t.country_name, t.country_code, t.flag_emoji,
              p.username      AS seller_name,
              p.rank_tier     AS seller_rank
       FROM   orders o
       JOIN   territory_names t  ON t.territory_id = o.territory_id
       JOIN   players p           ON p.id = o.seller_id
       WHERE  ${conditions.join(' AND ')}
       ORDER BY o.price_per_slot_wei ASC
       LIMIT $${p++} OFFSET $${p}`,
      params
    );
    res.json({ listings: rows, total: rows.length });
  } catch (err) {
    console.error('[market] listings error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /api/market/listings/:id
// ─────────────────────────────────────────────────────────────
router.get('/listings/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.*,
              t.country_name, t.country_code, t.flag_emoji,
              p.username AS seller_name
       FROM   orders o
       JOIN   territory_names t ON t.territory_id = o.territory_id
       JOIN   players p          ON p.id = o.seller_id
       WHERE  o.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Listing not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/market/list
//  Creates an off-chain order record (pending tx confirmation)
// ─────────────────────────────────────────────────────────────
router.post('/list', requireAuth, async (req, res) => {
  const { roundId, territoryId, qty, pricePerSlotWei } = req.body;

  if (!roundId || !territoryId || !qty || !pricePerSlotWei) {
    return res.status(400).json({ error: 'roundId, territoryId, qty, pricePerSlotWei required' });
  }

  if (qty < 1 || qty > 50) return res.status(400).json({ error: 'qty must be 1-50' });
  if (BigInt(pricePerSlotWei) <= 0n) return res.status(400).json({ error: 'price must be > 0' });

  // Verify player holds enough slots
  const { rows: holdings } = await pool.query(
    'SELECT slots FROM holdings WHERE player_id=$1 AND round_id=$2 AND territory_id=$3',
    [req.player.id, roundId, territoryId]
  );
  const held = holdings[0]?.slots ?? 0;
  if (held < qty) {
    return res.status(400).json({ error: `Insufficient slots. You hold ${held}, listing ${qty}` });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO orders (seller_id, round_id, territory_id, qty, price_per_slot_wei)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.player.id, roundId, territoryId, qty, pricePerSlotWei]
    );
    res.json({ listing: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create listing' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/market/confirm-list
//  Attach on-chain listing ID after tx confirmed
// ─────────────────────────────────────────────────────────────
router.post('/confirm-list', requireAuth, async (req, res) => {
  const { orderId, onChainListingId, txHash } = req.body;
  try {
    await pool.query(
      `UPDATE orders SET listing_id=$1, status='open', fill_tx=$2 WHERE id=$3 AND seller_id=$4`,
      [onChainListingId, txHash, orderId, req.player.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/market/confirm-buy
// ─────────────────────────────────────────────────────────────
router.post('/confirm-buy', requireAuth, async (req, res) => {
  const { orderId, qty, txHash } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      'SELECT * FROM orders WHERE id=$1 AND status=$2 FOR UPDATE',
      [orderId, 'open']
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Listing not found or already closed' });
    }
    const order = rows[0];
    if (qty > order.qty) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'qty exceeds available slots' });
    }

    const newQty   = order.qty - qty;
    const newStatus = newQty === 0 ? 'filled' : 'open';

    await client.query(
      `UPDATE orders
       SET qty=$1, status=$2, filled_by=$3, filled_qty=filled_qty+$4, fill_tx=$5
       WHERE id=$6`,
      [newQty, newStatus, req.player.id, qty, txHash, orderId]
    );

    // Transfer holdings
    await client.query(
      `INSERT INTO holdings (player_id, round_id, territory_id, slots, cost_wei, tx_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (player_id, round_id, territory_id)
       DO UPDATE SET slots = holdings.slots + $4`,
      [req.player.id, order.round_id, order.territory_id, qty,
       (BigInt(order.price_per_slot_wei) * BigInt(qty)).toString(), txHash]
    );

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[market] confirm-buy error:', err.message);
    res.status(500).json({ error: 'Transaction failed' });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/market/cancel/:id
// ─────────────────────────────────────────────────────────────
router.post('/cancel/:id', requireAuth, async (req, res) => {
  const { txHash } = req.body;
  try {
    const { rowCount } = await pool.query(
      `UPDATE orders SET status='cancelled', cancel_tx=$1
       WHERE id=$2 AND seller_id=$3 AND status='open'`,
      [txHash || null, req.params.id, req.player.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Listing not found or already closed' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  GET /api/market/my-listings
// ─────────────────────────────────────────────────────────────
router.get('/my-listings', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, t.country_name, t.flag_emoji
     FROM   orders o
     JOIN   territory_names t ON t.territory_id = o.territory_id
     WHERE  o.seller_id = $1
     ORDER BY o.created_at DESC LIMIT 50`,
    [req.player.id]
  );
  res.json({ listings: rows });
});

// ─────────────────────────────────────────────────────────────
//  GET /api/market/history/:territoryId
// ─────────────────────────────────────────────────────────────
router.get('/history/:territoryId', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.filled_qty, o.price_per_slot_wei, o.fill_tx, o.updated_at,
            p.username AS buyer
     FROM   orders o
     LEFT JOIN players p ON p.id = o.filled_by
     WHERE  o.territory_id = $1 AND o.status = 'filled'
     ORDER BY o.updated_at DESC LIMIT 20`,
    [req.params.territoryId]
  );
  res.json({ history: rows });
});

module.exports = router;
