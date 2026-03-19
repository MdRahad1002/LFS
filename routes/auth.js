// routes/auth.js
// Wallet-based authentication using SIWE (Sign-In with Ethereum)
// POST /api/auth/nonce    — generate a sign challenge
// POST /api/auth/verify   — verify signed message + issue JWT
// GET  /api/auth/me       — return current player profile
// POST /api/auth/logout   — invalidate session

const express  = require('express');
const jwt      = require('jsonwebtoken');
const { ethers } = require('ethers');
const { Pool } = require('pg');
const crypto   = require('crypto');
const router   = express.Router();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_in_production';
const JWT_EXPIRES = process.env.JWT_EXPIRES || '7d';

// In-memory nonce store (use Redis in production)
const nonces = new Map(); // address → { nonce, expiresAt }

// ─────────────────────────────────────────────────────────────
//  MIDDLEWARE: Authenticate JWT
// ─────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]
    || req.cookies?.auth_token;
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    req.player = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─────────────────────────────────────────────────────────────
//  POST /api/auth/nonce
//  Body: { address: "0x..." }
// ─────────────────────────────────────────────────────────────
router.post('/nonce', (req, res) => {
  const { address } = req.body;
  if (!address || !ethers.isAddress(address)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 min TTL

  nonces.set(address.toLowerCase(), { nonce, expiresAt });

  const message = buildSiweMessage(address, nonce);
  res.json({ nonce, message });
});

// ─────────────────────────────────────────────────────────────
//  POST /api/auth/verify
//  Body: { address, signature, referralCode? }
// ─────────────────────────────────────────────────────────────
router.post('/verify', async (req, res) => {
  const { address, signature, referralCode } = req.body;

  if (!address || !signature) {
    return res.status(400).json({ error: 'address and signature required' });
  }

  const addr = address.toLowerCase();
  const stored = nonces.get(addr);

  if (!stored || Date.now() > stored.expiresAt) {
    return res.status(401).json({ error: 'Nonce expired or not found. Request a new one.' });
  }

  // Verify signature
  const message = buildSiweMessage(address, stored.nonce);
  try {
    const recovered = ethers.verifyMessage(message, signature).toLowerCase();
    if (recovered !== addr) {
      return res.status(401).json({ error: 'Signature verification failed' });
    }
  } catch {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  nonces.delete(addr); // Consume nonce

  // Upsert player in DB
  const checksumAddress = ethers.getAddress(address);
  let player;
  try {
    const result = await pool.query(
      `INSERT INTO players (wallet_address, referral_code, referred_by)
       VALUES ($1, $2, (SELECT id FROM players WHERE referral_code = $3 LIMIT 1))
       ON CONFLICT (wallet_address) DO UPDATE
         SET last_active_at = now()
       RETURNING *`,
      [checksumAddress, generateReferralCode(), referralCode || null]
    );
    player = result.rows[0];

    // Credit referrer if new signup
    if (referralCode && !player.referred_by) {
      await creditReferral(pool, player.id, referralCode);
    }
  } catch (err) {
    console.error('[auth] DB error:', err.message);
    return res.status(500).json({ error: 'Database error' });
  }

  const token = jwt.sign(
    { id: player.id, wallet: checksumAddress, rank: player.rank_tier },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );

  res.json({
    token,
    player: sanitizePlayer(player),
  });
});

// ─────────────────────────────────────────────────────────────
//  GET /api/auth/me
// ─────────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*,
              a.name  AS alliance_name,
              a.id    AS alliance_id
       FROM   players p
       LEFT JOIN alliance_members am ON am.player_id = p.id
       LEFT JOIN alliances a         ON a.id = am.alliance_id
       WHERE  p.id = $1`,
      [req.player.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Player not found' });
    res.json(sanitizePlayer(rows[0]));
  } catch (err) {
    console.error('[auth] /me error:', err.message);
    res.status(500).json({ error: 'Database error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/auth/profile  (update username / avatar)
// ─────────────────────────────────────────────────────────────
router.post('/profile', requireAuth, async (req, res) => {
  const { username, bio, country_code } = req.body;

  if (username && (username.length < 3 || username.length > 32 || !/^[a-zA-Z0-9_]+$/.test(username))) {
    return res.status(400).json({ error: 'Username: 3-32 chars, alphanumeric + underscore only' });
  }

  try {
    const { rows } = await pool.query(
      `UPDATE players SET username=$1, bio=$2, country_code=$3
       WHERE id=$4 RETURNING *`,
      [username || req.player.username, bio, country_code, req.player.id]
    );
    res.json(sanitizePlayer(rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: 'Database error' });
  }
});

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────
function buildSiweMessage(address, nonce) {
  const domain  = process.env.DOMAIN || 'lastflagstanding.io';
  const chainId = process.env.CHAIN_ID || '1';
  const now     = new Date().toISOString();
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    'Sign in to Last Flag Standing. No password. No custody.',
    '',
    `URI: https://${domain}`,
    `Version: 1`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${now}`,
    `Expiration Time: ${new Date(Date.now() + 5 * 60 * 1000).toISOString()}`,
  ].join('\n');
}

function generateReferralCode() {
  return crypto.randomBytes(6).toString('base64url').toUpperCase().slice(0, 8);
}

async function creditReferral(pool, newPlayerId, referralCode) {
  const FC_REWARD = parseInt(process.env.REFERRAL_FC_REWARD || '100');
  try {
    await pool.query(
      `WITH referrer AS (
         SELECT id FROM players WHERE referral_code = $1
       )
       INSERT INTO referrals (referrer_id, referred_id, fc_credited, credited_at)
       SELECT id, $2, $3, now() FROM referrer
       ON CONFLICT DO NOTHING`,
      [referralCode, newPlayerId, FC_REWARD]
    );
    await pool.query(
      `UPDATE players SET referral_fc = referral_fc + $1 WHERE referral_code = $2`,
      [FC_REWARD, referralCode]
    );
  } catch (err) {
    console.error('[auth] referral credit error:', err.message);
  }
}

function sanitizePlayer(p) {
  const { kyc_applicant_id, push_token, ...safe } = p;
  return safe;
}

module.exports = router;
module.exports.requireAuth = requireAuth;
