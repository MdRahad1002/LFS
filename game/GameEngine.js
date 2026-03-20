// ─── game/GameEngine.js ─────────────────────────────────────────────────────
// Authoritative server-side game state. All elimination logic lives here.
// The server is the single source of truth; clients are pure display layers.

const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

const TERRITORIES = [
  {id:'us',name:'United States',flag:'🇺🇸'},{id:'gb',name:'United Kingdom',flag:'🇬🇧'},
  {id:'de',name:'Germany',flag:'🇩🇪'},{id:'fr',name:'France',flag:'🇫🇷'},
  {id:'jp',name:'Japan',flag:'🇯🇵'},{id:'cn',name:'China',flag:'🇨🇳'},
  {id:'br',name:'Brazil',flag:'🇧🇷'},{id:'au',name:'Australia',flag:'🇦🇺'},
  {id:'ca',name:'Canada',flag:'🇨🇦'},{id:'in',name:'India',flag:'🇮🇳'},
  {id:'ru',name:'Russia',flag:'🇷🇺'},{id:'mx',name:'Mexico',flag:'🇲🇽'},
  {id:'kr',name:'South Korea',flag:'🇰🇷'},{id:'za',name:'South Africa',flag:'🇿🇦'},
  {id:'ar',name:'Argentina',flag:'🇦🇷'},{id:'es',name:'Spain',flag:'🇪🇸'},
  {id:'it',name:'Italy',flag:'🇮🇹'},{id:'se',name:'Sweden',flag:'🇸🇪'},
  {id:'no',name:'Norway',flag:'🇳🇴'},{id:'nl',name:'Netherlands',flag:'🇳🇱'},
  {id:'ch',name:'Switzerland',flag:'🇨🇭'},{id:'sg',name:'Singapore',flag:'🇸🇬'},
  {id:'nz',name:'New Zealand',flag:'🇳🇿'},{id:'ie',name:'Ireland',flag:'🇮🇪'},
  {id:'pt',name:'Portugal',flag:'🇵🇹'},{id:'eg',name:'Egypt',flag:'🇪🇬'},
  {id:'ng',name:'Nigeria',flag:'🇳🇬'},{id:'th',name:'Thailand',flag:'🇹🇭'},
  {id:'pl',name:'Poland',flag:'🇵🇱'},{id:'tr',name:'Turkey',flag:'🇹🇷'},
  {id:'id',name:'Indonesia',flag:'🇮🇩'},{id:'pk',name:'Pakistan',flag:'🇵🇰'},
  {id:'my',name:'Malaysia',flag:'🇲🇾'},{id:'ph',name:'Philippines',flag:'🇵🇭'},
  {id:'cl',name:'Chile',flag:'🇨🇱'},{id:'co',name:'Colombia',flag:'🇨🇴'},
  {id:'pe',name:'Peru',flag:'🇵🇪'},{id:'ua',name:'Ukraine',flag:'🇺🇦'},
  {id:'ro',name:'Romania',flag:'🇷🇴'},{id:'cz',name:'Czech Republic',flag:'🇨🇿'},
  {id:'hu',name:'Hungary',flag:'🇭🇺'},{id:'at',name:'Austria',flag:'🇦🇹'},
  {id:'be',name:'Belgium',flag:'🇧🇪'},{id:'dk',name:'Denmark',flag:'🇩🇰'},
  {id:'fi',name:'Finland',flag:'🇫🇮'},{id:'gr',name:'Greece',flag:'🇬🇷'},
  {id:'il',name:'Israel',flag:'🇮🇱'},{id:'sa',name:'Saudi Arabia',flag:'🇸🇦'},
  {id:'ae',name:'UAE',flag:'🇦🇪'},{id:'tz',name:'Tanzania',flag:'🇹🇿'},
  {id:'ke',name:'Kenya',flag:'🇰🇪'},{id:'gh',name:'Ghana',flag:'🇬🇭'},
  {id:'vn',name:'Vietnam',flag:'🇻🇳'},{id:'bd',name:'Bangladesh',flag:'🇧🇩'},
  {id:'ir',name:'Iran',flag:'🇮🇷'},{id:'iq',name:'Iraq',flag:'🇮🇶'},
  {id:'ma',name:'Morocco',flag:'🇲🇦'},{id:'dz',name:'Algeria',flag:'🇩🇿'},
  {id:'ve',name:'Venezuela',flag:'🇻🇪'},{id:'ec',name:'Ecuador',flag:'🇪🇨'},
  {id:'bo',name:'Bolivia',flag:'🇧🇴'},{id:'py',name:'Paraguay',flag:'🇵🇾'},
  {id:'uy',name:'Uruguay',flag:'🇺🇾'},{id:'sk',name:'Slovakia',flag:'🇸🇰'},
  {id:'hr',name:'Croatia',flag:'🇭🇷'},{id:'rs',name:'Serbia',flag:'🇷🇸'},
  {id:'ba',name:'Bosnia',flag:'🇧🇦'},{id:'mk',name:'North Macedonia',flag:'🇲🇰'},
  {id:'al',name:'Albania',flag:'🇦🇱'},{id:'lv',name:'Latvia',flag:'🇱🇻'},
  {id:'lt',name:'Lithuania',flag:'🇱🇹'},{id:'ee',name:'Estonia',flag:'🇪🇪'},
  {id:'bg',name:'Bulgaria',flag:'🇧🇬'},{id:'si',name:'Slovenia',flag:'🇸🇮'},
  {id:'by',name:'Belarus',flag:'🇧🇾'},{id:'md',name:'Moldova',flag:'🇲🇩'},
  {id:'ge',name:'Georgia',flag:'🇬🇪'},{id:'am',name:'Armenia',flag:'🇦🇲'},
  {id:'az',name:'Azerbaijan',flag:'🇦🇿'},{id:'kz',name:'Kazakhstan',flag:'🇰🇿'},
  {id:'uz',name:'Uzbekistan',flag:'🇺🇿'},{id:'mn',name:'Mongolia',flag:'🇲🇳'},
  {id:'kh',name:'Cambodia',flag:'🇰🇭'},{id:'la',name:'Laos',flag:'🇱🇦'},
  {id:'mm',name:'Myanmar',flag:'🇲🇲'},{id:'np',name:'Nepal',flag:'🇳🇵'},
  {id:'lk',name:'Sri Lanka',flag:'🇱🇰'},{id:'jo',name:'Jordan',flag:'🇯🇴'},
  {id:'lb',name:'Lebanon',flag:'🇱🇧'},{id:'sy',name:'Syria',flag:'🇸🇾'},
  {id:'ye',name:'Yemen',flag:'🇾🇪'},{id:'om',name:'Oman',flag:'🇴🇲'},
  {id:'kw',name:'Kuwait',flag:'🇰🇼'},{id:'qa',name:'Qatar',flag:'🇶🇦'},
  {id:'bh',name:'Bahrain',flag:'🇧🇭'},{id:'et',name:'Ethiopia',flag:'🇪🇹'},
  {id:'ug',name:'Uganda',flag:'🇺🇬'},{id:'sn',name:'Senegal',flag:'🇸🇳'},
  {id:'ci',name:"Côte d'Ivoire",flag:'🇨🇮'},{id:'cm',name:'Cameroon',flag:'🇨🇲'},
  {id:'cd',name:'DR Congo',flag:'🇨🇩'},{id:'ao',name:'Angola',flag:'🇦🇴'},
  {id:'mz',name:'Mozambique',flag:'🇲🇿'},{id:'zm',name:'Zambia',flag:'🇿🇲'},
  {id:'zw',name:'Zimbabwe',flag:'🇿🇼'},{id:'bw',name:'Botswana',flag:'🇧🇼'},
  {id:'na',name:'Namibia',flag:'🇳🇦'},{id:'lu',name:'Luxembourg',flag:'🇱🇺'},
  {id:'mt',name:'Malta',flag:'🇲🇹'},{id:'cy',name:'Cyprus',flag:'🇨🇾'},
  {id:'is',name:'Iceland',flag:'🇮🇸'},{id:'ad',name:'Andorra',flag:'🇦🇩'},
  {id:'cu',name:'Cuba',flag:'🇨🇺'},{id:'do',name:'Dominican Republic',flag:'🇩🇴'},
  {id:'ht',name:'Haiti',flag:'🇭🇹'},{id:'jm',name:'Jamaica',flag:'🇯🇲'},
  {id:'tt',name:'Trinidad',flag:'🇹🇹'},{id:'bb',name:'Barbados',flag:'🇧🇧'},
  {id:'fj',name:'Fiji',flag:'🇫🇯'},{id:'pg',name:'Papua New Guinea',flag:'🇵🇬'},
  {id:'sb',name:'Solomon Islands',flag:'🇸🇧'},{id:'vu',name:'Vanuatu',flag:'🇻🇺'},
  {id:'ws',name:'Samoa',flag:'🇼🇸'},{id:'to',name:'Tonga',flag:'🇹🇴'},
  {id:'ki',name:'Kiribati',flag:'🇰🇮'},{id:'pw',name:'Palau',flag:'🇵🇼'},
  {id:'mh',name:'Marshall Islands',flag:'🇲🇭'},{id:'fm',name:'Micronesia',flag:'🇫🇲'},
  {id:'tv',name:'Tuvalu',flag:'🇹🇻'},{id:'nr',name:'Nauru',flag:'🇳🇷'},
  {id:'gm',name:'Gambia',flag:'🇬🇲'},{id:'sl',name:'Sierra Leone',flag:'🇸🇱'},
  {id:'lr',name:'Liberia',flag:'🇱🇷'},{id:'tg',name:'Togo',flag:'🇹🇬'},
  {id:'bj',name:'Benin',flag:'🇧🇯'},{id:'bf',name:'Burkina Faso',flag:'🇧🇫'},
  {id:'ml',name:'Mali',flag:'🇲🇱'},{id:'ne',name:'Niger',flag:'🇳🇪'},
  {id:'td',name:'Chad',flag:'🇹🇩'},{id:'so',name:'Somalia',flag:'🇸🇴'},
  {id:'er',name:'Eritrea',flag:'🇪🇷'},{id:'dj',name:'Djibouti',flag:'🇩🇯'},
  {id:'rw',name:'Rwanda',flag:'🇷🇼'},{id:'bi',name:'Burundi',flag:'🇧🇮'},
  {id:'mw',name:'Malawi',flag:'🇲🇼'},{id:'sz',name:'Eswatini',flag:'🇸🇿'},
  {id:'ls',name:'Lesotho',flag:'🇱🇸'},{id:'mg',name:'Madagascar',flag:'🇲🇬'},
  {id:'mu',name:'Mauritius',flag:'🇲🇺'},{id:'sc',name:'Seychelles',flag:'🇸🇨'},
  {id:'cv',name:'Cape Verde',flag:'🇨🇻'},{id:'gw',name:'Guinea-Bissau',flag:'🇬🇼'},
  {id:'gn',name:'Guinea',flag:'🇬🇳'},
];

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const HOUSE_CUT   = 0.03;   // 3 % on all buys / sells
const PEEK_COST   = 25;     // FC for Insider Intel
const SHIELD_COST = 50;     // FC for Shield Token
const FOG_COST    = 30;     // FC for Fog of War

// DEMO_MODE = fast intervals for local dev.  Set DEMO_MODE=false in .env for production.
const DEMO_MODE = process.env.DEMO_MODE !== 'false';

// ─── GAME TYPES ───────────────────────────────────────────────────────────────
const GAME_TYPES = {
  standard:     { label: 'Daily War',   entryFee: 10, seedJackpot: 0,    peekCost: 25, shieldCost: 50 },
  flash:        { label: 'Flash War',   entryFee:  5, seedJackpot: 0,    peekCost: 15, shieldCost: 30 },
  championship: { label: 'World War',   entryFee: 50, seedJackpot: 5000, peekCost: 75, shieldCost: 150 },
};

// ─── ACCELERATION FORMULA ────────────────────────────────────────────────────
// Returns elimination interval in milliseconds based on surviving territory count.
// In DEMO_MODE intervals are divided by 1440 (24h → 1min, 6h → 25s, etc.)
function getElimInterval(surviving) {
  const scale = DEMO_MODE ? 1440 : 1;
  if (surviving > 100) return { ms: (24 * 3600000) / scale, label: '1 per day' };
  if (surviving > 50)  return { ms: (12 * 3600000) / scale, label: '2 per day' };
  if (surviving > 20)  return { ms: ( 8 * 3600000) / scale, label: '3 per day' };
  if (surviving > 10)  return { ms: ( 6 * 3600000) / scale, label: '1 per 6 h' };
  if (surviving > 5)   return { ms: ( 2 * 3600000) / scale, label: '1 per 2 h' };
  return                      { ms: (   1800000)   / scale, label: '1 per 30 min' };
}

// Heat-spike fires every 4–7 minutes (production) or every 20–40 s (demo)
function heatSpikeDelay() {
  return DEMO_MODE
    ? (20 + Math.random() * 20) * 1000
    : (240 + Math.random() * 180) * 1000;
}

// Lock-window: 5 min before elimination (demo: 10 s)
const LOCK_WINDOW_MS  = DEMO_MODE ? 10000  : 5 * 60000;
// Entry window: 14 days (demo: 60 s)
const ENTRY_WINDOW_MS = DEMO_MODE ? 60000  : 14 * 24 * 3600000;

// ─── GAME ENGINE ─────────────────────────────────────────────────────────────
class GameEngine extends EventEmitter {
  /**
   * @param {object} io         Socket.io server instance
   * @param {string} gameType   'standard' | 'flash' | 'championship'
   * @param {object} [opts]
   * @param {number} [opts.seedJackpot]   Extra FC seeded into jackpot at start
   */
  constructor(io, gameType = 'standard', opts = {}) {
    super();
    this.io         = io;
    this.gameId     = uuidv4();
    this.gameType   = gameType;
    this.typeCfg    = GAME_TYPES[gameType] || GAME_TYPES.standard;
    this.round      = 1;
    this.jackpot    = opts.seedJackpot ?? this.typeCfg.seedJackpot;
    this.houseTotal = 0;
    this.eliminatedIds  = [];
    this.activityLog    = [];
    this.nextElimId     = null;
    this.gameOver       = false;
    this.lockWindowOpen = false;  // trading suspended this.heatSpikeId     = null;   // territory currently spiked
    this.heatWarningEnd = null;   // Date when 90-s heat warning expires

    // ─ Phase machine ─────────────────────────────────────────────────────
    // entry_window → active → complete
    this.phase         = 'entry_window';
    this.entryEndsAt   = Date.now() + ENTRY_WINDOW_MS;
    this.countdown     = Math.ceil(ENTRY_WINDOW_MS / 1000); // seconds until next event

    // ─ Territory state ───────────────────────────────────────────────────
    // id → { ...meta, status, owners, playerCount, probability, heatSpiked, intelCount }
    this.territories = {};
    TERRITORIES.forEach(t => {
      this.territories[t.id] = {
        ...t,
        status:      'safe',
        owners:      new Set(),
        playerCount: 0,
        probability: 0,      // elimination probability 0–100 this round
        heatSpiked:  false,  // currently in heat spike
        intelCount:  0,      // how many players bought Intel on this territory
        shielded:    false,  // protected this round
      };
    });

    // ─ Player state ──────────────────────────────────────────────────────
    // socketId → { name, balance, territories, fogged, streakDays }
    this.players = {};

    // ─ Entry window countdown then activate ──────────────────────────────
    this._startEntryWindow();
  }

  // ─── PUBLIC API ──────────────────────────────────────────────────────────

  addPlayer(socketId, name) {
    this.players[socketId] = {
      id:          socketId,
      name:        name || `Player_${socketId.slice(0, 5)}`,
      balance:     1250,
      territories: new Set(),
      fogged:      false,
      streakDays:  0,
    };
    this._log(`${this.players[socketId].name} entered the game`, 'join');
    return this._playerView(socketId);
  }

  removePlayer(socketId) {
    if (!this.players[socketId]) return;
    const name = this.players[socketId].name;
    this.players[socketId].territories.forEach(id => {
      if (this.territories[id]) this.territories[id].owners.delete(socketId);
    });
    delete this.players[socketId];
    this._log(`${name} left the game`, 'leave');
  }

  buyTerritory(socketId, territoryId) {
    const player = this.players[socketId];
    const terr   = this.territories[territoryId];
    if (!player || !terr)                        return { ok: false, error: 'Not found' };
    if (this.phase === 'entry_window' === false && this.lockWindowOpen)
                                                 return { ok: false, error: 'Trading locked before elimination' };
    if (terr.status === 'eliminated')            return { ok: false, error: 'Territory eliminated' };
    if (player.territories.has(territoryId))     return { ok: false, error: 'Already owned' };
    const price = this.typeCfg.entryFee;
    if (player.balance < price)                  return { ok: false, error: 'Insufficient balance' };

    const fee       = price * HOUSE_CUT;
    const poolShare = price - fee;
    player.balance      -= price;
    player.territories.add(territoryId);
    terr.owners.add(socketId);
    terr.playerCount    += 1;
    this.jackpot        += poolShare;
    this.houseTotal     += fee;
    this._recomputeProbabilities();
    this._log(`${player.name} bought ${terr.flag} ${terr.name} for ${price} FC`, 'buy');
    this._broadcastState();
    return { ok: true, balance: player.balance, jackpot: this.jackpot };
  }

  sellTerritory(socketId, territoryId) {
    const player = this.players[socketId];
    const terr   = this.territories[territoryId];
    if (!player || !terr)                        return { ok: false, error: 'Not found' };
    if (this.lockWindowOpen)                     return { ok: false, error: 'Trading locked — elimination imminent' };
    if (!player.territories.has(territoryId))    return { ok: false, error: 'Not your territory' };

    const price     = this.typeCfg.entryFee;
    const sellPrice = price * (1 - HOUSE_CUT);
    const fee       = price * HOUSE_CUT;
    player.balance     += sellPrice;
    player.territories.delete(territoryId);
    terr.owners.delete(socketId);
    terr.playerCount    = Math.max(0, terr.playerCount - 1);
    this.houseTotal    += fee;
    this._recomputeProbabilities();
    this._log(`${player.name} sold ${terr.flag} ${terr.name} for ${sellPrice.toFixed(2)} FC`, 'sell');
    this._broadcastState();
    return { ok: true, balance: player.balance, sellPrice };
  }

  buyPeek(socketId) {
    const player = this.players[socketId];
    if (!player)                             return { ok: false, error: 'Not found' };
    const cost = this.typeCfg.peekCost;
    if (player.balance < cost)               return { ok: false, error: 'Insufficient balance' };
    player.balance  -= cost;
    this.houseTotal += cost;
    if (this.nextElimId) this.territories[this.nextElimId].intelCount++;
    const hint = this.nextElimId
      ? { id: this.nextElimId, ...this._terrSummary(this.nextElimId) }
      : null;
    this._log(`${player.name} purchased Insider Intel`, 'peek');
    // Broadcast social-proof: X players bought Intel on [territory]
    if (hint) {
      this.io.emit('social_proof', {
        type:    'intel',
        message: `${this.territories[this.nextElimId].intelCount} player${this.territories[this.nextElimId].intelCount > 1 ? 's' : ''} bought Intel on ${this.territories[this.nextElimId].flag} ${this.territories[this.nextElimId].name}`,
      });
    }
    return { ok: true, balance: player.balance, hint };
  }

  buyShield(socketId, territoryId) {
    const player = this.players[socketId];
    const terr   = this.territories[territoryId];
    if (!player || !terr)                    return { ok: false, error: 'Not found' };
    if (!player.territories.has(territoryId)) return { ok: false, error: 'Not your territory' };
    if (terr.shielded)                       return { ok: false, error: 'Already shielded this round' };
    const cost = this.typeCfg.shieldCost;
    if (player.balance < cost)               return { ok: false, error: 'Insufficient balance' };
    player.balance  -= cost;
    this.houseTotal += cost;
    terr.shielded    = true;
    this._log(`${player.name} shielded ${terr.flag} ${terr.name}`, 'shield');
    return { ok: true, balance: player.balance };
  }

  buyFog(socketId) {
    const player = this.players[socketId];
    if (!player)                             return { ok: false, error: 'Not found' };
    if (player.balance < FOG_COST)           return { ok: false, error: 'Insufficient balance' };
    player.balance  -= FOG_COST;
    this.houseTotal += FOG_COST;
    player.fogged    = true;
    this._log(`${player.name} activated Fog of War`, 'fog');
    return { ok: true, balance: player.balance };
  }

  fullState(socketId) {
    const safe = Object.values(this.territories).filter(t => t.status === 'safe');
    const rate = getElimInterval(safe.length);
    return {
      territories:    this._allTerrSummaries(),
      leaderboard:    this._leaderboard(),
      jackpot:        this.jackpot,
      houseTotal:     this.houseTotal,
      round:          this.round,
      countdown:      this.countdown,
      eliminatedIds:  this.eliminatedIds,
      activityLog:    this.activityLog.slice(-30),
      player:         socketId ? this._playerView(socketId) : null,
      totalPlayers:   Object.keys(this.players).length,
      peekCost:       this.typeCfg.peekCost,
      shieldCost:     this.typeCfg.shieldCost,
      fogCost:        FOG_COST,
      entryFee:       this.typeCfg.entryFee,
      houseCutPct:    HOUSE_CUT * 100,
      phase:          this.phase,
      entryEndsAt:    this.entryEndsAt,
      gameType:       this.gameType,
      gameTypeLabel:  this.typeCfg.label,
      elimRate:       rate.label,
      lockWindowOpen: this.lockWindowOpen,
      heatSpikeId:    this.heatSpikeId,
      heatWarningEnd: this.heatWarningEnd,
    };
  }

  publicState() {
    const safe = Object.values(this.territories).filter(t => t.status === 'safe');
    const rate = getElimInterval(safe.length);
    return {
      gameId:         this.gameId,
      gameType:       this.gameType,
      gameTypeLabel:  this.typeCfg.label,
      round:          this.round,
      jackpot:        this.jackpot,
      countdown:      this.countdown,
      phase:          this.phase,
      totalPlayers:   Object.keys(this.players).length,
      survivingCount: safe.length,
      elimRate:       rate.label,
      territories:    this._allTerrSummaries(),
      eliminatedIds:  this.eliminatedIds,
      activityLog:    this.activityLog.slice(-20),
      gameOver:       this.gameOver,
      lockWindowOpen: this.lockWindowOpen,
      heatSpikeId:    this.heatSpikeId,
    };
  }

  // ─── INTERNAL ────────────────────────────────────────────────────────────

  _startEntryWindow() {
    this._log(`🚩 ${this.typeCfg.label} opened — entry window active`, 'info');
    this.io.emit('phase_change', {
      phase:       'entry_window',
      endsAt:      this.entryEndsAt,
      gameType:    this.gameType,
      typeLabel:   this.typeCfg.label,
      entryFee:    this.typeCfg.entryFee,
    });

    // Tick during entry window
    const entryTick = setInterval(() => {
      this.countdown = Math.max(0, Math.ceil((this.entryEndsAt - Date.now()) / 1000));
      this.io.emit('tick', {
        phase:       'entry_window',
        countdown:   this.countdown,
        jackpot:     this.jackpot,
        totalPlayers: Object.keys(this.players).length,
      });
      if (Date.now() >= this.entryEndsAt) {
        clearInterval(entryTick);
        this._activate();
      }
    }, 1000);
  }

  _activate() {
    this.phase = 'active';
    this._log(`⚔️ Game active — eliminations begin`, 'info');
    this.io.emit('phase_change', { phase: 'active', gameType: this.gameType });
    this._pickNextElim();
    this._scheduleNextElim();
    this._scheduleHeatSpike();
  }

  _scheduleNextElim() {
    if (this.gameOver) return;
    const safe = Object.values(this.territories).filter(t => t.status === 'safe');
    const { ms, label } = getElimInterval(safe.length);
    this._currentElimInterval = ms;
    this._currentElimLabel    = label;

    // Fire lock window LOCK_WINDOW_MS before the actual elimination
    const lockDelay = Math.max(0, ms - LOCK_WINDOW_MS);
    this._lockTimer = setTimeout(() => this._openLockWindow(), lockDelay);
    this._elimTimer = setTimeout(() => {
      this._eliminate();
      if (!this.gameOver) {
        this._pickNextElim();
        this._scheduleNextElim();
      }
    }, ms);

    // Countdown ticks every second
    const startedAt = Date.now();
    if (this._tickInterval) clearInterval(this._tickInterval);
    this._tickInterval = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      this.countdown = Math.max(0, Math.ceil((ms - elapsed) / 1000));
      this.io.emit('tick', {
        phase:         this.phase,
        countdown:     this.countdown,
        jackpot:       this.jackpot,
        totalPlayers:  Object.keys(this.players).length,
        elimRate:      label,
        lockWindowOpen: this.lockWindowOpen,
      });
    }, 1000);
  }

  _openLockWindow() {
    this.lockWindowOpen = true;
    this._log(`🔒 Trading LOCKED — elimination in ${Math.round(LOCK_WINDOW_MS / 1000)} s`, 'warn');
    this.io.emit('lock_window', {
      secondsLeft:  Math.round(LOCK_WINDOW_MS / 1000),
      nextElimId:   this.nextElimId,
      probability:  this.nextElimId ? this.territories[this.nextElimId].probability : null,
    });
    this.emit('lock-window', {
      roundId:     this.gameId,
      round:       this.round,
      nextElimId:  this.nextElimId,
      secondsLeft: Math.round(LOCK_WINDOW_MS / 1000),
    });
  }

  _scheduleHeatSpike() {
    if (this.gameOver) return;
    setTimeout(() => {
      if (this.gameOver) return;
      const safe = Object.values(this.territories).filter(t => t.status === 'safe' && !t.heatSpiked);
      if (safe.length < 2) return;
      // Pick a random territory that is NOT the actual next elimination (for tension)
      const candidates = safe.filter(t => t.id !== this.nextElimId);
      const target = candidates[Math.floor(Math.random() * candidates.length)];
      target.heatSpiked   = true;
      this.heatSpikeId    = target.id;
      this.heatWarningEnd = Date.now() + 90000;
      target.probability  = Math.min(99, target.probability * 2 + 10);
      this._log(`🔥 HEAT SPIKE on ${target.flag} ${target.name} — probability surged`, 'heat');
      this.io.emit('heat_spike', {
        territoryId: target.id,
        flag:        target.flag,
        name:        target.name,
        probability: target.probability,
        warningMs:   90000,
        endsAt:      this.heatWarningEnd,
      });
      // Expire the spike after 90 s
      setTimeout(() => {
        if (target.heatSpiked) {
          target.heatSpiked  = false;
          target.probability = Math.max(0, target.probability - 10);
          if (this.heatSpikeId === target.id) this.heatSpikeId = null;
          this.io.emit('heat_expire', { territoryId: target.id });
        }
        this._scheduleHeatSpike(); // chain next spike
      }, 90000);
    }, heatSpikeDelay());
  }

  _eliminate() {
    if (!this.nextElimId || this.gameOver) return;
    const id   = this.nextElimId;
    const terr = this.territories[id];

    // Shield absorbs the elimination for one round
    if (terr.shielded) {
      terr.shielded    = false;
      terr.heatSpiked  = false;
      this.lockWindowOpen = false;
      this._recomputeProbabilities();
      this._log(`🛡️ ${terr.flag} ${terr.name} SHIELDED — survived this round`, 'shield');
      this.io.emit('shield_blocked', { id, name: terr.name, flag: terr.flag });
      this._pickNextElim();
      return;
    }

    // Near-miss reporting — all safe territories get their % exposed
    const nearMissData = Object.values(this.territories)
      .filter(t => t.status === 'safe' && t.id !== id)
      .map(t => ({ id: t.id, probability: t.probability }));

    terr.status      = 'eliminated';
    terr.heatSpiked  = false;
    if (this.heatSpikeId === id) this.heatSpikeId = null;
    this.eliminatedIds.push(id);
    this.round++;
    this.lockWindowOpen = false;

    // Reset shields and intel counts for next round
    Object.values(this.territories).forEach(t => {
      t.shielded   = false;
      t.intelCount = 0;
    });

    terr.owners.forEach(socketId => {
      this.io.to(socketId).emit('territory_lost', { id, name: terr.name, flag: terr.flag });
    });

    const survivorsCount = Object.values(this.territories).filter(t => t.status === 'safe').length;
    this._log(`💀 ${terr.flag} ${terr.name} ELIMINATED — ${survivorsCount} territories remain`, 'elim');

    // Near-miss broadcast
    this.io.emit('near_miss', { survived: nearMissData, eliminated: { id, probability: terr.probability } });

    this.emit('elimination', {
      roundId:       this.gameId,
      round:         this.round,
      territoryId:   id,
      territoryName: terr.name,
      territoryFlag: terr.flag,
      survivorsCount,
    });

    this._recomputeProbabilities();
    this._broadcastState();
    this._checkWin();
  }

  _checkWin() {
    const activeTerrs = Object.values(this.territories).filter(t => t.status === 'safe');
    if (activeTerrs.length > 1) return;

    const survivors = Object.values(this.players).filter(p =>
      [...p.territories].some(id => this.territories[id]?.status === 'safe')
    );

    this.gameOver = true;
    this.phase    = 'complete';
    if (this._tickInterval)  clearInterval(this._tickInterval);
    if (this._elimTimer)     clearTimeout(this._elimTimer);
    if (this._lockTimer)     clearTimeout(this._lockTimer);

    const winnerName = survivors.length === 1 ? survivors[0].name : `${survivors.length} players`;
    this._log(`🏆 ${winnerName} WON THE JACKPOT of ${this.jackpot.toFixed(2)} FC!`, 'win');
    this.io.emit('game_over', {
      winners:   survivors.map(p => p.name),
      jackpot:   this.jackpot,
      gameType:  this.gameType,
      typeLabel: this.typeCfg.label,
    });
    this.emit('game-over', { gameId: this.gameId, jackpot: this.jackpot, winners: survivors.map(p => p.name) });
  }

  _pickNextElim() {
    const safe = Object.values(this.territories).filter(t => t.status === 'safe');
    if (safe.length === 0) { this.nextElimId = null; return; }
    this.nextElimId = safe[Math.floor(Math.random() * safe.length)].id;
    this._recomputeProbabilities();
  }

  // Assign base elimination probability to every safe territory.
  // The actual next target gets high weight; others spread the remainder.
  _recomputeProbabilities() {
    const safe = Object.values(this.territories).filter(t => t.status === 'safe');
    if (safe.length === 0) return;
    const base = Math.round(100 / safe.length);
    safe.forEach(t => {
      t.probability = t.heatSpiked ? Math.min(99, base * 2) : base;
    });
    // Nudge the actual target slightly higher (without revealing it perfectly)
    if (this.nextElimId && this.territories[this.nextElimId]) {
      this.territories[this.nextElimId].probability = Math.min(99, base + Math.floor(base * 0.4));
    }
  }

  _broadcastState() {
    const safe = Object.values(this.territories).filter(t => t.status === 'safe');
    const rate = getElimInterval(safe.length);
    this.io.emit('state_update', {
      territories:    this._allTerrSummaries(),
      leaderboard:    this._leaderboard(),
      jackpot:        this.jackpot,
      houseTotal:     this.houseTotal,
      round:          this.round,
      eliminatedIds:  this.eliminatedIds,
      activityLog:    this.activityLog.slice(-30),
      totalPlayers:   Object.keys(this.players).length,
      phase:          this.phase,
      elimRate:       rate.label,
      lockWindowOpen: this.lockWindowOpen,
    });
  }

  _log(msg, type) {
    const entry = { msg, type, ts: new Date().toISOString() };
    this.activityLog.push(entry);
    if (this.activityLog.length > 200) this.activityLog.shift();
    this.io.emit('activity', entry);
  }

  _terrSummary(id) {
    const t = this.territories[id];
    if (!t) return null;
    return {
      id:          t.id,
      name:        t.name,
      flag:        t.flag,
      status:      t.status,
      playerCount: t.playerCount,
      price:       this.typeCfg.entryFee,
      probability: t.probability,
      heatSpiked:  t.heatSpiked,
      shielded:    t.shielded,
      intelCount:  t.intelCount,
    };
  }

  _allTerrSummaries() {
    return Object.values(this.territories).map(t => this._terrSummary(t.id));
  }

  _playerView(socketId) {
    const p = this.players[socketId];
    if (!p) return null;
    const atRisk = [...p.territories]
      .filter(id => this.territories[id]?.status === 'safe')
      .length * this.typeCfg.entryFee;
    return {
      id:          socketId,
      name:        p.name,
      balance:     p.balance,
      territories: [...p.territories],
      atRisk,
      fogged:      p.fogged,
      streakDays:  p.streakDays,
    };
  }

  _leaderboard() {
    return Object.values(this.players)
      .map(p => {
        const surviving = [...p.territories].filter(id => this.territories[id]?.status === 'safe');
        return {
          name:        p.name,
          id:          p.id,
          territories: surviving.length,
          atRisk:      surviving.length * this.typeCfg.entryFee,
          flags:       surviving.slice(0, 4).map(id => this.territories[id]?.flag || ''),
        };
      })
      .sort((a, b) => b.territories - a.territories)
      .slice(0, 20);
  }
}

module.exports = { GameEngine, TERRITORIES, GAME_TYPES, getElimInterval, HOUSE_CUT, DEMO_MODE };
