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
const { GameEngine } = require('./game/GameEngine');

// ─── Routes ──────────────────────────────────────────────────────────────────
const authRouter      = require('./routes/auth');
const kycRouter       = require('./routes/kyc');
const marketRouter    = require('./routes/market');
const referralRouter  = require('./routes/referral');
const analyticsRouter = require('./routes/analytics');
const pushRouter      = require('./routes/push');
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

// ─── Game instance ───────────────────────────────────────────────────────────
const game = new GameEngine(io);

// Hook game events → push notifications
game.on && game.on('elimination', async ({ roundId, territoryName, survivorsCount }) => {
  try {
    await broadcastToRound(roundId,
      `💀 ${territoryName} ELIMINATED`,
      `${survivorsCount} territories remain. Round continues.`,
      { type: 'elimination', url: '/public/play.html', tag: 'elimination' }
    );
  } catch (err) {
    console.error('[push] elimination broadcast failed:', err.message);
  }
});

game.on && game.on('lock-window', async ({ roundId, secondsLeft }) => {
  try {
    await broadcastToRound(roundId,
      '🔒 LOCK WINDOW — 5 min to elimination',
      'All trades are frozen. Hold your territories.',
      { type: 'alert', url: '/public/play.html', tag: 'lock', vibrate: [300, 100, 300, 100, 300] }
    );
  } catch { /* non-critical */ }
});

// ─── Socket.io events ────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id} connected  (${io.engine.clientsCount} total)`);

  socket.on('join', ({ name } = {}) => {
    const playerData = game.addPlayer(socket.id, name);
    socket.emit('init', game.fullState(socket.id));
  });

  socket.on('buy', ({ territoryId }) => {
    const result = game.buyTerritory(socket.id, territoryId);
    socket.emit('buy_result', result);
  });

  socket.on('sell', ({ territoryId }) => {
    const result = game.sellTerritory(socket.id, territoryId);
    socket.emit('sell_result', result);
  });

  socket.on('peek', () => {
    const result = game.buyPeek(socket.id);
    socket.emit('peek_result', result);
  });

  // Spectator room — no game state mutations
  socket.on('spectate', () => {
    socket.join('spectators');
    socket.emit('spectate_init', game.publicState());
  });

  socket.on('disconnect', () => {
    game.removePlayer(socket.id);
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
