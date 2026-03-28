// game/LotteryEngine.js
// Weekly territory lottery engine.
// Manages round lifecycle, schedules draws, and broadcasts Socket.io events.
// Socket.io events emitted:
//   lottery_round_started  { id, status, jackpotWei, totalTickets, endTime, msLeft }
//   lottery_tick           { roundId, msLeft }
//   lottery_drawing        { roundId, message }
//   lottery_winner         { roundId, territoryId, countryName, flagEmoji, jackpotWei, winnerCount }
//   lottery_your_payout    { roundId, territoryId, tickets, payoutWei }  — room: player:<playerId>

'use strict';

const EventEmitter = require('events');
const { Pool }     = require('pg');

const DEMO_MODE         = process.env.DEMO_MODE !== 'false';
// 7-day rounds in production; 3-minute rounds in demo mode
const ROUND_DURATION_MS = DEMO_MODE ? 3 * 60 * 1000 : 7 * 24 * 3600 * 1000;

class LotteryEngine extends EventEmitter {
  /**
   * @param {object} io  Socket.io server instance (shared with main game)
   */
  constructor(io) {
    super();
    this.io           = io;
    this.pool         = new Pool({ connectionString: process.env.DATABASE_URL });
    this.currentRound = null;  // cached active round row
    this._drawTimer   = null;
    this._tickTimer   = null;
  }

  // ─── LIFECYCLE ─────────────────────────────────────────────────────────────

  /** Initialize: resume any in-progress round or start a fresh one. */
  async init() {
    try {
      const { rows } = await this.pool.query(
        `SELECT * FROM lottery_rounds
         WHERE  status IN ('entry', 'drawing')
         ORDER BY created_at DESC
         LIMIT  1`
      );

      if (rows.length) {
        this.currentRound = rows[0];
        if (this.currentRound.status === 'entry') {
          const msLeft = Math.max(0, new Date(this.currentRound.end_time) - Date.now());
          if (msLeft > 0) {
            this._drawTimer = setTimeout(
              () => this._triggerDraw(this.currentRound.id), msLeft
            );
          } else {
            // Round ended while server was offline — trigger draw now
            await this._triggerDraw(this.currentRound.id);
          }
        }
        // If status === 'drawing', wait for admin/VRF to finalize
      } else {
        await this.startNewRound();
      }

      this._startTick();
    } catch (err) {
      console.error('[lottery] init error:', err.message);
    }
  }

  /** Create a new 7-day ticket-purchase window. */
  async startNewRound() {
    clearTimeout(this._drawTimer);
    const endTime = new Date(Date.now() + ROUND_DURATION_MS);

    const { rows } = await this.pool.query(
      `INSERT INTO lottery_rounds (status, end_time)
       VALUES ('entry', $1)
       RETURNING *`,
      [endTime]
    );

    this.currentRound = rows[0];
    this.io.emit('lottery_round_started', this._publicState());

    this._drawTimer = setTimeout(
      () => this._triggerDraw(this.currentRound.id), ROUND_DURATION_MS
    );

    this.emit('round_started', { round: this.currentRound });
    console.log(`[lottery] Round ${this.currentRound.id} started — closes ${endTime.toISOString()}`);
    return this.currentRound;
  }

  // ─── DRAW FLOW ──────────────────────────────────────────────────────────────

  /** Close ticket sales and mark round as 'drawing'. */
  async _triggerDraw(roundId) {
    try {
      const { rowCount } = await this.pool.query(
        `UPDATE lottery_rounds
         SET    status = 'drawing'
         WHERE  id = $1 AND status = 'entry'`,
        [roundId]
      );
      if (rowCount === 0) return; // Already drawing or complete

      if (this.currentRound?.id === roundId) {
        this.currentRound.status = 'drawing';
      }

      this.io.emit('lottery_drawing', {
        roundId,
        message: 'Ticket window closed — Chainlink VRF draw in progress…',
      });
      this.emit('draw_requested', { roundId });
      console.log(`[lottery] Round ${roundId} — draw requested`);
    } catch (err) {
      console.error('[lottery] _triggerDraw error:', err.message);
    }
  }

  /**
   * Called after VRF fulfillment is confirmed on-chain.
   * Stores the raw random value for reference and emits notification.
   */
  async onVrfFulfilled(roundId, rawRandom) {
    try {
      await this.pool.query(
        `UPDATE lottery_rounds SET vrf_raw_random = $1 WHERE id = $2`,
        [rawRandom.toString(), roundId]
      );
      this.emit('vrf_fulfilled', { roundId, rawRandom });
      console.log(`[lottery] Round ${roundId} — VRF fulfilled, rawRandom: ${rawRandom}`);
    } catch (err) {
      console.error('[lottery] onVrfFulfilled error:', err.message);
    }
  }

  /**
   * Called after finalizeWinner() is confirmed on-chain.
   * Updates DB, fires Socket.io winner broadcast, starts next round.
   */
  async onWinnerFinalized(roundId, winnerTerritoryId) {
    try {
      // Fetch territory metadata
      const { rows: [territory] } = await this.pool.query(
        `SELECT * FROM territory_names WHERE territory_id = $1`,
        [winnerTerritoryId]
      );

      // Total tickets in winning territory
      const { rows: [stats] } = await this.pool.query(
        `SELECT COALESCE(SUM(quantity), 0)::bigint AS total
         FROM   lottery_tickets
         WHERE  round_id = $1 AND territory_id = $2`,
        [roundId, winnerTerritoryId]
      );

      // Round jackpot
      const { rows: [round] } = await this.pool.query(
        `SELECT jackpot_wei FROM lottery_rounds WHERE id = $1`,
        [roundId]
      );

      // Mark round complete
      await this.pool.query(
        `UPDATE lottery_rounds
         SET    status = 'complete', winner_territory_id = $1, drawn_at = now()
         WHERE  id = $2`,
        [winnerTerritoryId, roundId]
      );

      const jackpotWei         = (round?.jackpot_wei || '0').toString();
      const totalWinnerTickets = parseInt(stats?.total || '0');
      const distributable      = BigInt(jackpotWei) * BigInt(9600) / BigInt(10_000);

      // Broadcast winner to every connected client
      this.io.emit('lottery_winner', {
        roundId,
        territoryId: winnerTerritoryId,
        countryName: territory?.country_name  || `Territory ${winnerTerritoryId}`,
        flagEmoji:   territory?.flag_emoji    || '🏳',
        jackpotWei,
        winnerCount: totalWinnerTickets,
      });

      console.log(
        `[lottery] Round ${roundId} winner: ${territory?.country_name} ` +
        `(territory ${winnerTerritoryId}), jackpot: ${jackpotWei} wei`
      );

      // Notify each winning player's private room
      const { rows: winners } = await this.pool.query(
        `SELECT lt.player_id, SUM(lt.quantity)::bigint AS tickets
         FROM   lottery_tickets lt
         WHERE  lt.round_id = $1 AND lt.territory_id = $2
         GROUP  BY lt.player_id`,
        [roundId, winnerTerritoryId]
      );

      for (const w of winners) {
        const payout = totalWinnerTickets > 0
          ? (distributable * BigInt(w.tickets) / BigInt(totalWinnerTickets)).toString()
          : '0';
        this.io.to(`player:${w.player_id}`).emit('lottery_your_payout', {
          roundId,
          territoryId: winnerTerritoryId,
          tickets:     parseInt(w.tickets),
          payoutWei:   payout,
        });
      }

      // Auto-start next round
      this.currentRound = null;
      this.emit('round_complete', { roundId, winnerTerritoryId });
      await this.startNewRound();
    } catch (err) {
      console.error('[lottery] onWinnerFinalized error:', err.message);
    }
  }

  // ─── QUERY HELPERS ──────────────────────────────────────────────────────────

  /** Returns all 195 territories with ticket counts + odds for a given round. */
  async getTerritoryStats(roundId) {
    const { rows } = await this.pool.query(
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

    const total = rows.reduce((s, r) => s + r.ticket_count, 0);
    return rows.map(r => ({
      ...r,
      odds_pct: total > 0
        ? ((r.ticket_count / total) * 100).toFixed(2)
        : '0.00',
    }));
  }

  /** Returns the active/drawing round from DB (or null). */
  async getCurrentRound() {
    const { rows } = await this.pool.query(
      `SELECT * FROM lottery_rounds
       WHERE  status IN ('entry', 'drawing')
       ORDER BY created_at DESC
       LIMIT  1`
    );
    return rows[0] || null;
  }

  // ─── INTERNAL ───────────────────────────────────────────────────────────────

  _publicState() {
    if (!this.currentRound) return null;
    return {
      id:           this.currentRound.id,
      status:       this.currentRound.status,
      jackpotWei:   (this.currentRound.jackpot_wei || '0').toString(),
      totalTickets: parseInt(this.currentRound.total_tickets || 0),
      endTime:      this.currentRound.end_time,
      msLeft:       Math.max(0, new Date(this.currentRound.end_time) - Date.now()),
    };
  }

  _startTick() {
    clearInterval(this._tickTimer);
    this._tickTimer = setInterval(() => {
      if (!this.currentRound || this.currentRound.status !== 'entry') return;
      const msLeft = Math.max(0, new Date(this.currentRound.end_time) - Date.now());
      this.io.emit('lottery_tick', { roundId: this.currentRound.id, msLeft });
    }, 1000);
  }

  /** Clean up timers and DB pool on shutdown. */
  destroy() {
    clearTimeout(this._drawTimer);
    clearInterval(this._tickTimer);
    this.pool.end().catch(() => {});
  }
}

module.exports = { LotteryEngine };
