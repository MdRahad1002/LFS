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

const HOUSE_CUT        = 0.03;   // 3% on buys/sells
const PEEK_COST        = 25;     // fixed price for insider intel
const TERRITORY_PRICE  = 10;     // entry fee per territory
const ELIM_INTERVAL_MS = 60000;  // 1 elimination per minute

class GameEngine extends EventEmitter {
  constructor(io) {
    super();
    this.io = io;
    this.gameId = uuidv4();
    this.round = 1;
    this.jackpot = 0;
    this.houseTotal = 0;
    this.countdown = ELIM_INTERVAL_MS / 1000;
    this.eliminatedIds = [];
    this.activityLog = [];
    this.nextElimId = null;
    this.gameOver = false;

    // territory state: id -> { ...meta, status, owners: Set<socketId> }
    this.territories = {};
    TERRITORIES.forEach(t => {
      this.territories[t.id] = {
        ...t,
        status: 'safe',
        owners: new Set(),
        playerCount: Math.floor(Math.random() * 20) + 1,
      };
    });

    // player state: socketId -> { name, balance, territories: Set<id> }
    this.players = {};

    this._pickNextElim();
    this._startClock();
  }

  // ─── PUBLIC API (called by server.js on socket events) ──────────────────

  addPlayer(socketId, name) {
    this.players[socketId] = {
      id: socketId,
      name: name || `Player_${socketId.slice(0, 5)}`,
      balance: 1250,
      territories: new Set(),
    };
    this._log(`${this.players[socketId].name} entered the game`, 'join');
    return this._playerView(socketId);
  }

  removePlayer(socketId) {
    if(!this.players[socketId]) return;
    const name = this.players[socketId].name;
    // Release territory ownership counts but keep territory in game
    this.players[socketId].territories.forEach(id => {
      if(this.territories[id]) this.territories[id].owners.delete(socketId);
    });
    delete this.players[socketId];
    this._log(`${name} left the game`, 'leave');
  }

  buyTerritory(socketId, territoryId) {
    const player = this.players[socketId];
    const terr   = this.territories[territoryId];
    if(!player || !terr) return { ok: false, error: 'Not found' };
    if(terr.status === 'eliminated') return { ok: false, error: 'Territory eliminated' };
    if(player.territories.has(territoryId))  return { ok: false, error: 'Already owned' };
    if(player.balance < TERRITORY_PRICE)     return { ok: false, error: 'Insufficient balance' };

    const fee       = TERRITORY_PRICE * HOUSE_CUT;
    const poolShare = TERRITORY_PRICE - fee;

    player.balance      -= TERRITORY_PRICE;
    player.territories.add(territoryId);
    terr.owners.add(socketId);
    terr.playerCount    += 1;
    this.jackpot        += poolShare;
    this.houseTotal     += fee;

    this._log(`${player.name} bought ${terr.flag} ${terr.name} for $${TERRITORY_PRICE}`, 'buy');
    this._broadcastState();

    return { ok: true, balance: player.balance, jackpot: this.jackpot };
  }

  sellTerritory(socketId, territoryId) {
    const player = this.players[socketId];
    const terr   = this.territories[territoryId];
    if(!player || !terr)                      return { ok: false, error: 'Not found' };
    if(!player.territories.has(territoryId))  return { ok: false, error: 'Not your territory' };

    const sellPrice = TERRITORY_PRICE * (1 - HOUSE_CUT);
    const fee       = TERRITORY_PRICE * HOUSE_CUT;

    player.balance     += sellPrice;
    player.territories.delete(territoryId);
    terr.owners.delete(socketId);
    terr.playerCount   = Math.max(1, terr.playerCount - 1);
    this.houseTotal    += fee;

    this._log(`${player.name} sold ${terr.flag} ${terr.name} for $${sellPrice.toFixed(2)}`, 'sell');
    this._broadcastState();

    return { ok: true, balance: player.balance, sellPrice };
  }

  buyPeek(socketId) {
    const player = this.players[socketId];
    if(!player)                      return { ok: false, error: 'Not found' };
    if(player.balance < PEEK_COST)   return { ok: false, error: 'Insufficient balance' };

    player.balance  -= PEEK_COST;
    this.houseTotal += PEEK_COST;

    const hint = this.nextElimId
      ? { id: this.nextElimId, ...this._terrSummary(this.nextElimId) }
      : null;

    this._log(`${player.name} purchased Insider Intel`, 'peek');
    return { ok: true, balance: player.balance, hint };
  }

  // Full state snapshot for a newly connected player
  fullState(socketId) {
    return {
      territories: this._allTerrSummaries(),
      leaderboard: this._leaderboard(),
      jackpot: this.jackpot,
      houseTotal: this.houseTotal,
      round: this.round,
      countdown: this.countdown,
      eliminatedIds: this.eliminatedIds,
      activityLog: this.activityLog.slice(-30),
      player: socketId ? this._playerView(socketId) : null,
      totalPlayers: Object.keys(this.players).length,
      peekCost: PEEK_COST,
      territoryPrice: TERRITORY_PRICE,
      houseCutPct: HOUSE_CUT * 100,
    };
  }

  // Public read-only snapshot for spectators (no private data)
  publicState() {
    return {
      gameId: this.gameId,
      round: this.round,
      jackpot: this.jackpot,
      countdown: this.countdown,
      totalPlayers: Object.keys(this.players).length,
      survivingCount: Object.values(this.territories).filter(t => t.status === 'safe').length,
      territories: this._allTerrSummaries(),
      eliminatedIds: this.eliminatedIds,
      activityLog: this.activityLog.slice(-20),
      gameOver: this.gameOver,
    };
  }

  // ─── INTERNAL ────────────────────────────────────────────────────────────

  _startClock() {
    this._clockInterval = setInterval(() => {
      this.countdown--;
      if(this.countdown <= 0) {
        this._eliminate();
        this.countdown = ELIM_INTERVAL_MS / 1000;
        this._pickNextElim();
      }
      // Emit lock-window event at 30 s left → server.js hooks push notifications
      if (this.countdown === 30 && this.nextElimId) {
        this.emit('lock-window', {
          roundId: this.gameId,
          round: this.round,
          nextElimId: this.nextElimId,
          secondsLeft: this.countdown,
        });
      }
      // Broadcast countdown tick to all clients every second
      this.io.emit('tick', {
        countdown: this.countdown,
        jackpot: this.jackpot,
        totalPlayers: Object.keys(this.players).length,
      });
    }, 1000);
  }

  _eliminate() {
    if(!this.nextElimId || this.gameOver) return;
    const id   = this.nextElimId;
    const terr = this.territories[id];
    terr.status = 'eliminated';
    this.eliminatedIds.push(id);
    this.round++;

    // Notify owners that they've lost this territory
    terr.owners.forEach(socketId => {
      this.io.to(socketId).emit('territory_lost', { id, name: terr.name, flag: terr.flag });
    });

    this._log(`💀 ${terr.flag} ${terr.name} ELIMINATED — Round ${this.round}`, 'elim');

    // Emit elimination event so server.js push-notification hooks fire
    const survivorsCount = Object.values(this.territories).filter(t => t.status === 'safe').length;
    this.emit('elimination', {
      roundId: this.gameId,
      round: this.round,
      territoryId: id,
      territoryName: terr.name,
      territoryFlag: terr.flag,
      survivorsCount,
    });

    // Check win condition: last player with surviving territories
    this._checkWin();
    this._broadcastState();
  }

  _checkWin() {
    const activeTerrs = Object.values(this.territories).filter(t => t.status === 'safe');
    if(activeTerrs.length > 1) return;

    // Find surviving players
    const survivors = Object.values(this.players).filter(p => {
      return [...p.territories].some(id => this.territories[id]?.status === 'safe');
    });

    if(survivors.length === 1) {
      this.gameOver = true;
      clearInterval(this._clockInterval);
      const winner = survivors[0];
      this._log(`🏆 ${winner.name} WON THE JACKPOT of $${this.jackpot.toFixed(2)}!`, 'win');
      this.io.emit('game_over', { winner: winner.name, jackpot: this.jackpot });
    }
  }

  _pickNextElim() {
    const safe = Object.values(this.territories).filter(t => t.status === 'safe');
    if(safe.length === 0) { this.nextElimId = null; return; }
    this.nextElimId = safe[Math.floor(Math.random() * safe.length)].id;
  }

  _broadcastState() {
    this.io.emit('state_update', {
      territories: this._allTerrSummaries(),
      leaderboard: this._leaderboard(),
      jackpot: this.jackpot,
      houseTotal: this.houseTotal,
      round: this.round,
      eliminatedIds: this.eliminatedIds,
      activityLog: this.activityLog.slice(-30),
      totalPlayers: Object.keys(this.players).length,
    });
  }

  _log(msg, type) {
    const entry = { msg, type, ts: new Date().toISOString() };
    this.activityLog.push(entry);
    if(this.activityLog.length > 200) this.activityLog.shift();
    this.io.emit('activity', entry);
  }

  _terrSummary(id) {
    const t = this.territories[id];
    if(!t) return null;
    return {
      id: t.id, name: t.name, flag: t.flag,
      status: t.status,
      playerCount: t.playerCount,
      price: TERRITORY_PRICE,
    };
  }

  _allTerrSummaries() {
    return Object.values(this.territories).map(t => this._terrSummary(t.id));
  }

  _playerView(socketId) {
    const p = this.players[socketId];
    if(!p) return null;
    return {
      id: socketId,
      name: p.name,
      balance: p.balance,
      territories: [...p.territories],
    };
  }

  _leaderboard() {
    return Object.values(this.players)
      .map(p => ({
        name: p.name,
        id: p.id,
        territories: [...p.territories].filter(id => this.territories[id]?.status === 'safe').length,
        flags: [...p.territories]
          .filter(id => this.territories[id]?.status === 'safe')
          .slice(0, 4)
          .map(id => this.territories[id]?.flag || ''),
      }))
      .sort((a, b) => b.territories - a.territories)
      .slice(0, 20);
  }
}

module.exports = { GameEngine, TERRITORIES, TERRITORY_PRICE, PEEK_COST, HOUSE_CUT };
