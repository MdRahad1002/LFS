-- ============================================================
--  LAST FLAG STANDING — PostgreSQL Schema
--  Run: psql -d lastflag -f db/schema.sql
-- ============================================================

-- ── Extensions ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
--  PLAYERS
-- ============================================================
CREATE TABLE IF NOT EXISTS players (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  wallet_address  VARCHAR(42) UNIQUE NOT NULL,    -- checksummed EVM address
  wallet_chain    VARCHAR(20) NOT NULL DEFAULT 'evm',

  -- Profile
  username        VARCHAR(32) UNIQUE,
  avatar_url      TEXT,
  bio             TEXT,
  country_code    CHAR(2),

  -- XP & Rank
  xp              INTEGER     NOT NULL DEFAULT 0,
  rank_tier       VARCHAR(20) NOT NULL DEFAULT 'recruit',  -- recruit|soldier|commander|general|warlord|emperor
  streak_days     INTEGER     NOT NULL DEFAULT 0,
  last_active_at  TIMESTAMPTZ,

  -- Referrals
  referral_code   VARCHAR(12) UNIQUE NOT NULL,
  referred_by     UUID        REFERENCES players(id),
  referral_fc     INTEGER     NOT NULL DEFAULT 0,      -- FC credited from referrals

  -- KYC / Compliance
  kyc_status      VARCHAR(20) NOT NULL DEFAULT 'none',  -- none|pending|approved|rejected
  kyc_applicant_id TEXT,                                 -- Sumsub applicant ID
  kyc_reviewed_at TIMESTAMPTZ,

  -- Notification preferences
  push_token      TEXT,    -- FCM / Web Push endpoint
  push_enabled    BOOLEAN  NOT NULL DEFAULT FALSE,
  email           VARCHAR(255),
  sms_number      VARCHAR(20),

  -- Timestamps
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_players_wallet     ON players(wallet_address);
CREATE INDEX idx_players_referral   ON players(referral_code);
CREATE INDEX idx_players_rank       ON players(rank_tier, xp DESC);

-- ============================================================
--  ROUNDS
-- ============================================================
CREATE TABLE IF NOT EXISTS rounds (
  id              BIGSERIAL   PRIMARY KEY,
  round_uuid      UUID        UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
  status          VARCHAR(20) NOT NULL DEFAULT 'entry',
  -- entry → locked → eliminating → complete

  jackpot_wei     NUMERIC(36,0) NOT NULL DEFAULT 0,
  jackpot_usd     NUMERIC(18,2),

  territories_start INTEGER NOT NULL DEFAULT 195,
  territories_left  INTEGER NOT NULL DEFAULT 195,

  -- Chainlink VRF
  vrf_request_id  VARCHAR(78),
  vrf_randomness  VARCHAR(78),

  -- Timing
  entry_open_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  lock_at         TIMESTAMPTZ,
  elimination_at  TIMESTAMPTZ,
  complete_at     TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
--  TERRITORIES  (per-round state)
-- ============================================================
CREATE TABLE IF NOT EXISTS territories (
  id              BIGSERIAL   PRIMARY KEY,
  round_id        BIGINT      NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  territory_id    INTEGER     NOT NULL,   -- 1..195 matching ERC-1155 tokenId
  country_code    CHAR(2)     NOT NULL,
  country_name    VARCHAR(80) NOT NULL,
  slots_total     INTEGER     NOT NULL DEFAULT 0,
  is_eliminated   BOOLEAN     NOT NULL DEFAULT FALSE,
  eliminated_at   TIMESTAMPTZ,
  elimination_tx  VARCHAR(66),            -- on-chain tx hash

  UNIQUE(round_id, territory_id)
);

CREATE INDEX idx_territories_round ON territories(round_id, is_eliminated);

-- ============================================================
--  TERRITORY HOLDINGS  (player → territory positions)
-- ============================================================
CREATE TABLE IF NOT EXISTS holdings (
  id            BIGSERIAL   PRIMARY KEY,
  player_id     UUID        NOT NULL REFERENCES players(id),
  round_id      BIGINT      NOT NULL REFERENCES rounds(id),
  territory_id  INTEGER     NOT NULL,
  slots         INTEGER     NOT NULL DEFAULT 1,
  cost_wei      NUMERIC(36,0) NOT NULL DEFAULT 0,
  acquired_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  tx_hash       VARCHAR(66),

  UNIQUE(player_id, round_id, territory_id)
);

CREATE INDEX idx_holdings_player ON holdings(player_id, round_id);
CREATE INDEX idx_holdings_round  ON holdings(round_id, territory_id);

-- ============================================================
--  ORDERS  (fixed-price P2P market order book)
-- ============================================================
CREATE TABLE IF NOT EXISTS orders (
  id              BIGSERIAL   PRIMARY KEY,
  listing_id      INTEGER,              -- on-chain listing ID from TerritoryMarket
  seller_id       UUID        NOT NULL REFERENCES players(id),
  round_id        BIGINT      NOT NULL REFERENCES rounds(id),
  territory_id    INTEGER     NOT NULL,
  qty             INTEGER     NOT NULL,
  price_per_slot_wei NUMERIC(36,0) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'open',  -- open|filled|cancelled|expired
  filled_by       UUID        REFERENCES players(id),
  filled_qty      INTEGER     NOT NULL DEFAULT 0,
  fill_tx         VARCHAR(66),
  cancel_tx       VARCHAR(66),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ
);

CREATE INDEX idx_orders_territory ON orders(round_id, territory_id, status);
CREATE INDEX idx_orders_seller    ON orders(seller_id, status);

-- ============================================================
--  TRANSACTIONS  (deposits / withdrawals / payouts)
-- ============================================================
CREATE TABLE IF NOT EXISTS transactions (
  id          BIGSERIAL   PRIMARY KEY,
  player_id   UUID        NOT NULL REFERENCES players(id),
  type        VARCHAR(20) NOT NULL, -- deposit|withdrawal|payout|referral_bonus|market_sale
  amount_wei  NUMERIC(36,0) NOT NULL,
  amount_usd  NUMERIC(18,2),
  coin        VARCHAR(10) NOT NULL DEFAULT 'ETH',
  tx_hash     VARCHAR(66) UNIQUE,
  status      VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending|confirmed|failed
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  round_id    BIGINT      REFERENCES rounds(id)
);

CREATE INDEX idx_tx_player ON transactions(player_id, created_at DESC);
CREATE INDEX idx_tx_status ON transactions(status, created_at DESC);

-- ============================================================
--  REFERRALS
-- ============================================================
CREATE TABLE IF NOT EXISTS referrals (
  id            BIGSERIAL   PRIMARY KEY,
  referrer_id   UUID        NOT NULL REFERENCES players(id),
  referred_id   UUID        NOT NULL REFERENCES players(id) UNIQUE,
  fc_credited   INTEGER     NOT NULL DEFAULT 0,
  credited_at   TIMESTAMPTZ,
  deposit_tx    VARCHAR(66),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_referrals_referrer ON referrals(referrer_id);

-- ============================================================
--  ALLIANCES
-- ============================================================
CREATE TABLE IF NOT EXISTS alliances (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(50) UNIQUE NOT NULL,
  leader_id   UUID        NOT NULL REFERENCES players(id),
  on_chain_key VARCHAR(66),   -- keccak256 key from AllianceVault
  total_winnings_wei NUMERIC(36,0) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alliance_members (
  alliance_id UUID        NOT NULL REFERENCES alliances(id),
  player_id   UUID        NOT NULL REFERENCES players(id),
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (alliance_id, player_id)
);

-- ============================================================
--  PUSH SUBSCRIPTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id   UUID        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  endpoint    TEXT        NOT NULL,
  p256dh_key  TEXT,
  auth_key    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(player_id, endpoint)
);

-- ============================================================
--  ANALYTICS EVENTS  (append-only)
-- ============================================================
CREATE TABLE IF NOT EXISTS analytics_events (
  id          BIGSERIAL   PRIMARY KEY,
  player_id   UUID        REFERENCES players(id),
  session_id  UUID,
  event_type  VARCHAR(50) NOT NULL,  -- page_view|deposit|trade|elimination_watch|round_join etc.
  properties  JSONB,
  ip_hash     VARCHAR(64),           -- hashed for GDPR
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_analytics_type ON analytics_events(event_type, created_at DESC);
CREATE INDEX idx_analytics_player ON analytics_events(player_id, created_at DESC);

-- ============================================================
--  FUNCTIONS
-- ============================================================

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_players_updated_at
  BEFORE UPDATE ON players
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
--  SEED DATA: territory names
-- ============================================================
CREATE TABLE IF NOT EXISTS territory_names (
  territory_id  INTEGER     PRIMARY KEY,  -- matches ERC-1155 tokenId
  country_code  CHAR(2)     NOT NULL,
  country_name  VARCHAR(80) NOT NULL,
  flag_emoji    VARCHAR(10)
);

INSERT INTO territory_names (territory_id, country_code, country_name, flag_emoji) VALUES
(1,'AF','Afghanistan','🇦🇫'),(2,'AL','Albania','🇦🇱'),(3,'DZ','Algeria','🇩🇿'),
(4,'AD','Andorra','🇦🇩'),(5,'AO','Angola','🇦🇴'),(6,'AG','Antigua and Barbuda','🇦🇬'),
(7,'AR','Argentina','🇦🇷'),(8,'AM','Armenia','🇦🇲'),(9,'AU','Australia','🇦🇺'),
(10,'AT','Austria','🇦🇹'),(11,'AZ','Azerbaijan','🇦🇿'),(12,'BS','Bahamas','🇧🇸'),
(13,'BH','Bahrain','🇧🇭'),(14,'BD','Bangladesh','🇧🇩'),(15,'BB','Barbados','🇧🇧'),
(16,'BY','Belarus','🇧🇾'),(17,'BE','Belgium','🇧🇪'),(18,'BZ','Belize','🇧🇿'),
(19,'BJ','Benin','🇧🇯'),(20,'BT','Bhutan','🇧🇹'),(21,'BO','Bolivia','🇧🇴'),
(22,'BA','Bosnia and Herzegovina','🇧🇦'),(23,'BW','Botswana','🇧🇼'),(24,'BR','Brazil','🇧🇷'),
(25,'BN','Brunei','🇧🇳'),(26,'BG','Bulgaria','🇧🇬'),(27,'BF','Burkina Faso','🇧🇫'),
(28,'BI','Burundi','🇧🇮'),(29,'CV','Cabo Verde','🇨🇻'),(30,'KH','Cambodia','🇰🇭'),
(31,'CM','Cameroon','🇨🇲'),(32,'CA','Canada','🇨🇦'),(33,'CF','Central African Republic','🇨🇫'),
(34,'TD','Chad','🇹🇩'),(35,'CL','Chile','🇨🇱'),(36,'CN','China','🇨🇳'),
(37,'CO','Colombia','🇨🇴'),(38,'KM','Comoros','🇰🇲'),(39,'CG','Congo','🇨🇬'),
(40,'CR','Costa Rica','🇨🇷'),(41,'CI','Côte d Ivoire','🇨🇮'),(42,'HR','Croatia','🇭🇷'),
(43,'CU','Cuba','🇨🇺'),(44,'CY','Cyprus','🇨🇾'),(45,'CZ','Czech Republic','🇨🇿'),
(46,'DK','Denmark','🇩🇰'),(47,'DJ','Djibouti','🇩🇯'),(48,'DM','Dominica','🇩🇲'),
(49,'DO','Dominican Republic','🇩🇴'),(50,'EC','Ecuador','🇪🇨'),(51,'EG','Egypt','🇪🇬'),
(52,'SV','El Salvador','🇸🇻'),(53,'GQ','Equatorial Guinea','🇬🇶'),(54,'ER','Eritrea','🇪🇷'),
(55,'EE','Estonia','🇪🇪'),(56,'SZ','Eswatini','🇸🇿'),(57,'ET','Ethiopia','🇪🇹'),
(58,'FJ','Fiji','🇫🇯'),(59,'FI','Finland','🇫🇮'),(60,'FR','France','🇫🇷'),
(61,'GA','Gabon','🇬🇦'),(62,'GM','Gambia','🇬🇲'),(63,'GE','Georgia','🇬🇪'),
(64,'DE','Germany','🇩🇪'),(65,'GH','Ghana','🇬🇭'),(66,'GR','Greece','🇬🇷'),
(67,'GD','Grenada','🇬🇩'),(68,'GT','Guatemala','🇬🇹'),(69,'GN','Guinea','🇬🇳'),
(70,'GW','Guinea-Bissau','🇬🇼'),(71,'GY','Guyana','🇬🇾'),(72,'HT','Haiti','🇭🇹'),
(73,'HN','Honduras','🇭🇳'),(74,'HU','Hungary','🇭🇺'),(75,'IS','Iceland','🇮🇸'),
(76,'IN','India','🇮🇳'),(77,'ID','Indonesia','🇮🇩'),(78,'IR','Iran','🇮🇷'),
(79,'IQ','Iraq','🇮🇶'),(80,'IE','Ireland','🇮🇪'),(81,'IL','Israel','🇮🇱'),
(82,'IT','Italy','🇮🇹'),(83,'JM','Jamaica','🇯🇲'),(84,'JP','Japan','🇯🇵'),
(85,'JO','Jordan','🇯🇴'),(86,'KZ','Kazakhstan','🇰🇿'),(87,'KE','Kenya','🇰🇪'),
(88,'KI','Kiribati','🇰🇮'),(89,'KW','Kuwait','🇰🇼'),(90,'KG','Kyrgyzstan','🇰🇬'),
(91,'LA','Laos','🇱🇦'),(92,'LV','Latvia','🇱🇻'),(93,'LB','Lebanon','🇱🇧'),
(94,'LS','Lesotho','🇱🇸'),(95,'LR','Liberia','🇱🇷'),(96,'LY','Libya','🇱🇾'),
(97,'LI','Liechtenstein','🇱🇮'),(98,'LT','Lithuania','🇱🇹'),(99,'LU','Luxembourg','🇱🇺'),
(100,'MG','Madagascar','🇲🇬'),(101,'MW','Malawi','🇲🇼'),(102,'MY','Malaysia','🇲🇾'),
(103,'MV','Maldives','🇲🇻'),(104,'ML','Mali','🇲🇱'),(105,'MT','Malta','🇲🇹'),
(106,'MH','Marshall Islands','🇲🇭'),(107,'MR','Mauritania','🇲🇷'),(108,'MU','Mauritius','🇲🇺'),
(109,'MX','Mexico','🇲🇽'),(110,'FM','Micronesia','🇫🇲'),(111,'MD','Moldova','🇲🇩'),
(112,'MC','Monaco','🇲🇨'),(113,'MN','Mongolia','🇲🇳'),(114,'ME','Montenegro','🇲🇪'),
(115,'MA','Morocco','🇲🇦'),(116,'MZ','Mozambique','🇲🇿'),(117,'MM','Myanmar','🇲🇲'),
(118,'NA','Namibia','🇳🇦'),(119,'NR','Nauru','🇳🇷'),(120,'NP','Nepal','🇳🇵'),
(121,'NL','Netherlands','🇳🇱'),(122,'NZ','New Zealand','🇳🇿'),(123,'NI','Nicaragua','🇳🇮'),
(124,'NE','Niger','🇳🇪'),(125,'NG','Nigeria','🇳🇬'),(126,'NO','Norway','🇳🇴'),
(127,'OM','Oman','🇴🇲'),(128,'PK','Pakistan','🇵🇰'),(129,'PW','Palau','🇵🇼'),
(130,'PA','Panama','🇵🇦'),(131,'PG','Papua New Guinea','🇵🇬'),(132,'PY','Paraguay','🇵🇾'),
(133,'PE','Peru','🇵🇪'),(134,'PH','Philippines','🇵🇭'),(135,'PL','Poland','🇵🇱'),
(136,'PT','Portugal','🇵🇹'),(137,'QA','Qatar','🇶🇦'),(138,'RO','Romania','🇷🇴'),
(139,'RU','Russia','🇷🇺'),(140,'RW','Rwanda','🇷🇼'),(141,'KN','Saint Kitts and Nevis','🇰🇳'),
(142,'LC','Saint Lucia','🇱🇨'),(143,'VC','Saint Vincent and the Grenadines','🇻🇨'),
(144,'WS','Samoa','🇼🇸'),(145,'SM','San Marino','🇸🇲'),(146,'ST','Sao Tome and Principe','🇸🇹'),
(147,'SA','Saudi Arabia','🇸🇦'),(148,'SN','Senegal','🇸🇳'),(149,'RS','Serbia','🇷🇸'),
(150,'SC','Seychelles','🇸🇨'),(151,'SL','Sierra Leone','🇸🇱'),(152,'SG','Singapore','🇸🇬'),
(153,'SK','Slovakia','🇸🇰'),(154,'SI','Slovenia','🇸🇮'),(155,'SB','Solomon Islands','🇸🇧'),
(156,'SO','Somalia','🇸🇴'),(157,'ZA','South Africa','🇿🇦'),(158,'SS','South Sudan','🇸🇸'),
(159,'ES','Spain','🇪🇸'),(160,'LK','Sri Lanka','🇱🇰'),(161,'SD','Sudan','🇸🇩'),
(162,'SR','Suriname','🇸🇷'),(163,'SE','Sweden','🇸🇪'),(164,'CH','Switzerland','🇨🇭'),
(165,'SY','Syria','🇸🇾'),(166,'TW','Taiwan','🇹🇼'),(167,'TJ','Tajikistan','🇹🇯'),
(168,'TZ','Tanzania','🇹🇿'),(169,'TH','Thailand','🇹🇭'),(170,'TL','Timor-Leste','🇹🇱'),
(171,'TG','Togo','🇹🇬'),(172,'TO','Tonga','🇹🇴'),(173,'TT','Trinidad and Tobago','🇹🇹'),
(174,'TN','Tunisia','🇹🇳'),(175,'TR','Turkey','🇹🇷'),(176,'TM','Turkmenistan','🇹🇲'),
(177,'TV','Tuvalu','🇹🇻'),(178,'UG','Uganda','🇺🇬'),(179,'UA','Ukraine','🇺🇦'),
(180,'AE','United Arab Emirates','🇦🇪'),(181,'GB','United Kingdom','🇬🇧'),
(182,'US','United States','🇺🇸'),(183,'UY','Uruguay','🇺🇾'),(184,'UZ','Uzbekistan','🇺🇿'),
(185,'VU','Vanuatu','🇻🇺'),(186,'VE','Venezuela','🇻🇪'),(187,'VN','Vietnam','🇻🇳'),
(188,'YE','Yemen','🇾🇪'),(189,'ZM','Zambia','🇿🇲'),(190,'ZW','Zimbabwe','🇿🇼'),
(191,'KP','North Korea','🇰🇵'),(192,'KR','South Korea','🇰🇷'),(193,'TZ','Tanzania','🇹🇿'),
(194,'PS','Palestine','🇵🇸'),(195,'XK','Kosovo','🇽🇰')
ON CONFLICT DO NOTHING;

-- ============================================================
--  LOTTERY ROUNDS
-- ============================================================
CREATE TABLE IF NOT EXISTS lottery_rounds (
  id                  BIGSERIAL     PRIMARY KEY,
  status              VARCHAR(20)   NOT NULL DEFAULT 'entry',
  -- entry | drawing | complete | cancelled

  jackpot_wei         NUMERIC(36,0) NOT NULL DEFAULT 0,
  total_tickets       INTEGER       NOT NULL DEFAULT 0,

  winner_territory_id INTEGER,          -- NULL until finalized, FK-style (no FK — territory_names has no id PK)
  vrf_raw_random      VARCHAR(78),      -- raw Chainlink random value after fulfillment

  start_time          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  end_time            TIMESTAMPTZ   NOT NULL,
  drawn_at            TIMESTAMPTZ,

  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_lottery_rounds_status ON lottery_rounds(status, created_at DESC);

CREATE TRIGGER trg_lottery_rounds_updated_at
  BEFORE UPDATE ON lottery_rounds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
--  LOTTERY TICKETS
-- ============================================================
CREATE TABLE IF NOT EXISTS lottery_tickets (
  id                   UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  round_id             BIGINT        NOT NULL REFERENCES lottery_rounds(id) ON DELETE CASCADE,
  territory_id         INTEGER       NOT NULL CHECK (territory_id BETWEEN 1 AND 195),
  player_id            UUID          NOT NULL REFERENCES players(id),
  quantity             INTEGER       NOT NULL CHECK (quantity > 0),
  price_per_ticket_wei NUMERIC(36,0) NOT NULL DEFAULT 0,
  total_paid_wei       NUMERIC(36,0) NOT NULL DEFAULT 0,
  tx_hash              VARCHAR(66)   UNIQUE,          -- on-chain tx; prevents double-credit
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX idx_lottery_tickets_round      ON lottery_tickets(round_id, territory_id);
CREATE INDEX idx_lottery_tickets_player     ON lottery_tickets(player_id, round_id);
CREATE INDEX idx_lottery_tickets_territory  ON lottery_tickets(round_id, territory_id, player_id);

-- ============================================================
--  LOTTERY PAYOUTS
-- ============================================================
CREATE TABLE IF NOT EXISTS lottery_payouts (
  id           UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  round_id     BIGINT        NOT NULL REFERENCES lottery_rounds(id),
  player_id    UUID          NOT NULL REFERENCES players(id),
  territory_id INTEGER       NOT NULL,
  ticket_count INTEGER       NOT NULL,
  payout_wei   NUMERIC(36,0) NOT NULL,
  claimed_at   TIMESTAMPTZ,
  tx_hash      VARCHAR(66),
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),

  UNIQUE(round_id, player_id)   -- one payout record per player per round
);

CREATE INDEX idx_lottery_payouts_round  ON lottery_payouts(round_id);
CREATE INDEX idx_lottery_payouts_player ON lottery_payouts(player_id);
