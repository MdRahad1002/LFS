// ─── server.js ──────────────────────────────────────────────────────────────
// Last Flag Standing — Express + Socket.io backend
// Run: node server.js  (or: npm run dev  with nodemon)

require('dotenv').config();

const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const path         = require('path');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const helmet       = require('helmet');
const { GameEngine }    = require('./game/GameEngine');
const { LotteryEngine } = require('./game/LotteryEngine');

// ─── Routes ──────────────────────────────────────────────────────────────────
const authRouter      = require('./routes/auth');
const kycRouter       = require('./routes/kyc');
const marketRouter    = require('./routes/market');
const referralRouter  = require('./routes/referral');
const analyticsRouter = require('./routes/analytics');
const pushRouter      = require('./routes/push');
const lotteryRouter   = require('./routes/lottery');
const { broadcastToRound } = require('./routes/push');

const PORT = process.env.PORT || 3000;

// ─── Express setup ───────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: {
    origin:      process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true,
  }
});

// Security headers
app.use(helmet({
  contentSecurityPolicy: false,  // adjust in production
  crossOriginEmbedderPolicy: false,
}));

// CORS
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['*'];
app.use(cors({
  origin:      allowedOrigins[0] === '*' ? true : allowedOrigins,
  credentials: true,
}));

app.use(cookieParser());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Rate Limits ─────────────────────────────────────────────────────────────
const authLimit = rateLimit({
  windowMs:    15 * 60 * 1000,  // 15 min
  max:         20,
  message:     { error: 'Too many auth attempts. Try again in 15 minutes.' },
});

const apiLimit = rateLimit({
  windowMs:    60 * 1000,      // 1 min
  max:         120,
});

const analyticsLimit = rateLimit({
  windowMs:    60 * 1000,
  max:         60,
});

// ─── API Routes ──────────────────────────────────────────────────────────────
app.use('/api/auth',      authLimit,      authRouter);
app.use('/api/kyc',                       kycRouter);
app.use('/api/market',    apiLimit,       marketRouter);
app.use('/api/referral',  apiLimit,       referralRouter);
app.use('/api/analytics', analyticsLimit, analyticsRouter);
app.use('/api/push',      apiLimit,       pushRouter);
app.use('/api/lottery',   apiLimit,       lotteryRouter);

// Health check
app.get('/health', (_req, res) => res.json({
  status:  'ok',
  uptime:  process.uptime(),
  players: io.engine?.clientsCount ?? 0,
  version: require('./package.json').version,
}));

// ─── KYC withdrawal gate ─────────────────────────────────────────────────────
// Middleware used on /api/withdraw (implement later)
function requireKYC(req, res, next) {
  if (!req.player?.id) return res.status(401).json({ error: 'Not signed in' });
  if (req.player.kyc_status !== 'approved') {
    return res.status(403).json({
      error: 'KYC required for withdrawals over $2,000',
      code:  'KYC_REQUIRED',
    });
  }
  next();
}

// ─── Game instances ─────────────────────────────────────────────────────────
// Run a Standard game + a Flash War simultaneously
const game      = new GameEngine(io, 'standard');
const flashGame = new GameEngine(io, 'flash');

// ─── Lottery Engine ──────────────────────────────────────────────────────────
const lotteryEngine = new LotteryEngine(io);
app.locals.lotteryEngine = lotteryEngine;
app.locals.io            = io;
lotteryEngine.init().catch(err => console.error('[lottery] init failed:', err.message));

// Helper: attach push-notification hooks to any GameEngine instance
function hookGameEvents(g) {
  g.on('elimination', async ({ roundId, territoryName, survivorsCount }) => {
    try {
      await broadcastToRound(roundId,
        `💀 ${territoryName} ELIMINATED`,
        `${survivorsCount} territories remain.`,
        { type: 'elimination', url: '/play.html', tag: 'elimination' }
      );
    } catch (err) { console.error('[push] elimination:', err.message); }
  });

  g.on('lock-window', async ({ roundId, secondsLeft }) => {
    try {
      await broadcastToRound(roundId,
        `🔒 LOCK WINDOW — ${secondsLeft}s to elimination`,
        'All trades are frozen. Hold your territories.',
        { type: 'alert', url: '/play.html', tag: 'lock', vibrate: [300,100,300,100,300] }
      );
    } catch { /* non-critical */ }
  });
}
hookGameEvents(game);
hookGameEvents(flashGame);

// ─── Socket.io events ────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id} connected  (${io.engine.clientsCount} total)`);

  // Client specifies which game to join: 'standard' | 'flash' | 'championship'
  socket.on('join', ({ name, gameType = 'standard' } = {}) => {
    const g = gameType === 'flash' ? flashGame : game;
    g.addPlayer(socket.id, name);
    socket.emit('init', g.fullState(socket.id));
  });

  // Lottery: join player-specific room for personal payout notifications
  socket.on('lottery_auth', ({ playerId } = {}) => {
    if (playerId && /^[0-9a-f-]{36}$/i.test(playerId)) {
      socket.join(`player:${playerId}`);
    }
  });

  socket.on('buy', ({ territoryId, gameType = 'standard' }) => {
    const g = gameType === 'flash' ? flashGame : game;
    socket.emit('buy_result', g.buyTerritory(socket.id, territoryId));
  });

  socket.on('sell', ({ territoryId, gameType = 'standard' }) => {
    const g = gameType === 'flash' ? flashGame : game;
    socket.emit('sell_result', g.sellTerritory(socket.id, territoryId));
  });

  socket.on('peek', ({ gameType = 'standard' } = {}) => {
    const g = gameType === 'flash' ? flashGame : game;
    socket.emit('peek_result', g.buyPeek(socket.id));
  });

  socket.on('shield', ({ territoryId, gameType = 'standard' }) => {
    const g = gameType === 'flash' ? flashGame : game;
    socket.emit('shield_result', g.buyShield(socket.id, territoryId));
  });

  socket.on('fog', ({ gameType = 'standard' } = {}) => {
    const g = gameType === 'flash' ? flashGame : game;
    socket.emit('fog_result', g.buyFog(socket.id));
  });

  // Spectator room — no mutations
  socket.on('spectate', ({ gameType = 'standard' } = {}) => {
    socket.join('spectators');
    const g = gameType === 'flash' ? flashGame : game;
    socket.emit('spectate_init', g.publicState());
  });

  // Dashboard: return both active games
  socket.on('games_list', () => {
    socket.emit('games_list', [
      game.publicState(),
      flashGame.publicState(),
    ]);
  });

  socket.on('disconnect', () => {
    game.removePlayer(socket.id);
    flashGame.removePlayer(socket.id);
    console.log(`[-] ${socket.id} disconnected  (${io.engine.clientsCount} total)`);
  });
});

// ─── Anti-bot: track connection rate per IP ───────────────────────────────────
const connCount = new Map();
io.use((socket, next) => {
  const ip   = socket.handshake.address;
  const now  = Date.now();
  const prev = connCount.get(ip) || { count: 0, since: now };

  if (now - prev.since > 60_000) {
    connCount.set(ip, { count: 1, since: now });
    return next();
  }
  if (prev.count > 30) {   // >30 connections/min from one IP
    return next(new Error('Rate limit exceeded'));
  }
  connCount.set(ip, { count: prev.count + 1, since: prev.since });
  next();
});

// ─── Start ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚩  LAST FLAG STANDING`);
  console.log(`    Server  → http://localhost:${PORT}`);
  console.log(`    Health  → http://localhost:${PORT}/health`);
  console.log(`    Mode    → ${process.env.NODE_ENV || 'development'}\n`);
});
