// routes/kyc.js
// Sumsub KYC/AML integration
// POST /api/kyc/init              — create Sumsub applicant + return access token
// POST /api/kyc/webhook           — Sumsub status webhook
// GET  /api/kyc/status            — player's current KYC status

const express  = require('express');
const crypto   = require('crypto');
const axios    = require('axios');
const { Pool } = require('pg');
const { requireAuth } = require('./auth');

const router = express.Router();
const pool   = new Pool({ connectionString: process.env.DATABASE_URL });

const SUMSUB_APP_TOKEN  = process.env.SUMSUB_APP_TOKEN  || '';
const SUMSUB_SECRET_KEY = process.env.SUMSUB_SECRET_KEY || '';
const SUMSUB_BASE_URL   = 'https://api.sumsub.com';
const LEVEL_NAME        = process.env.SUMSUB_LEVEL || 'basic-kyc-level'; // configure in Sumsub dashboard

// ─────────────────────────────────────────────────────────────
//  POST /api/kyc/init
//  Creates applicant + returns a short-lived access token for
//  the Sumsub WebSDK to embed in the frontend.
// ─────────────────────────────────────────────────────────────
router.post('/init', requireAuth, async (req, res) => {
  try {
    // Fetch current player
    const { rows } = await pool.query(
      'SELECT kyc_status, kyc_applicant_id, wallet_address FROM players WHERE id = $1',
      [req.player.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Player not found' });
    const player = rows[0];

    if (player.kyc_status === 'approved') {
      return res.json({ status: 'approved', message: 'KYC already completed' });
    }

    // Create or reuse applicant
    let applicantId = player.kyc_applicant_id;
    if (!applicantId) {
      const applicant = await sumsubRequest('POST', '/resources/applicants?levelName=' + LEVEL_NAME, {
        externalUserId: req.player.id,
        email: req.body.email,
        fixedInfo: {
          country: req.body.country || undefined,
        },
      });
      applicantId = applicant.id;

      await pool.query(
        'UPDATE players SET kyc_status=$1, kyc_applicant_id=$2 WHERE id=$3',
        ['pending', applicantId, req.player.id]
      );
    }

    // Generate access token for WebSDK (valid 10 min)
    const tokenResp = await sumsubRequest(
      'POST',
      `/resources/accessTokens?userId=${req.player.id}&levelName=${LEVEL_NAME}`,
      {}
    );

    res.json({
      token:       tokenResp.token,
      applicantId,
      status:      'pending',
    });
  } catch (err) {
    console.error('[kyc] init error:', err.response?.data || err.message);
    res.status(500).json({ error: 'KYC initialization failed', detail: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  POST /api/kyc/webhook  (Sumsub → your server)
//  Verify HMAC signature, update player KYC status.
// ─────────────────────────────────────────────────────────────
router.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const signature = req.headers['x-payload-digest'];
  const algo      = req.headers['x-payload-digest-alg'] || 'HMAC_SHA256';

  if (!signature) return res.status(400).json({ error: 'Missing signature' });

  // Verify HMAC
  const expectedSig = crypto
    .createHmac('sha256', SUMSUB_SECRET_KEY)
    .update(req.body)
    .digest('hex');

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload;
  try { payload = JSON.parse(req.body.toString()); }
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { externalUserId, type, reviewResult } = payload;

  // Map Sumsub review result to our status
  const statusMap = {
    applicantCreated:    'pending',
    applicantPending:    'pending',
    applicantOnHold:     'pending',
    applicantReviewed:   reviewResult?.reviewAnswer === 'GREEN' ? 'approved' : 'rejected',
    applicantReset:      'none',
  };

  const newStatus = statusMap[type] || 'pending';

  try {
    await pool.query(
      `UPDATE players
       SET kyc_status=$1, kyc_reviewed_at=$2
       WHERE id=$3`,
      [newStatus, new Date(), externalUserId]
    );

    // If approved, log an analytics event
    if (newStatus === 'approved') {
      await pool.query(
        `INSERT INTO analytics_events (player_id, event_type, properties)
         VALUES ($1, 'kyc_approved', $2)`,
        [externalUserId, JSON.stringify({ applicantId: payload.applicantId })]
      );
    }
  } catch (err) {
    console.error('[kyc] webhook DB error:', err.message);
    return res.status(500).send('DB error');
  }

  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
//  GET /api/kyc/status
// ─────────────────────────────────────────────────────────────
router.get('/status', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT kyc_status, kyc_reviewed_at FROM players WHERE id=$1',
    [req.player.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({
    status:     rows[0].kyc_status,
    reviewedAt: rows[0].kyc_reviewed_at,
  });
});

// ─────────────────────────────────────────────────────────────
//  HELPER: Sumsub signed request
// ─────────────────────────────────────────────────────────────
async function sumsubRequest(method, path, body) {
  const ts       = Math.floor(Date.now() / 1000).toString();
  const bodyStr  = body && Object.keys(body).length ? JSON.stringify(body) : '';
  const sigData  = ts + method.toUpperCase() + path + bodyStr;
  const signature = crypto
    .createHmac('sha256', SUMSUB_SECRET_KEY)
    .update(sigData)
    .digest('hex');

  const response = await axios({
    method,
    url:     SUMSUB_BASE_URL + path,
    data:    bodyStr || undefined,
    headers: {
      'Accept':        'application/json',
      'Content-Type':  'application/json',
      'X-App-Token':   SUMSUB_APP_TOKEN,
      'X-App-Access-Ts':  ts,
      'X-App-Access-Sig': signature,
    },
  });

  return response.data;
}

module.exports = router;
