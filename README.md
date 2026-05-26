# 🐺 Monwolf Buy Bot

Watches the $MONWOLF / WMON LP on Monad mainnet for buys, posts pack-themed alerts to TG, runs pack commands, and chats with the community via OpenAI.

## Features

- 🌿 **Buy alerts** with MON spent, tokens received, MC, LP, 24h Δ
- 🐺 **Pack tier system** — buyers get CUB/PACK/SCOUT/BETA/ALPHA based on bite count
- 🚨 **Whale alerts** for buys over $500
- 🌕 **Milestone pings** at $100k, $250k, $500k, $1M, $2.5M, $5M, $10M MC
- 💧 **LP drop warning** if LP falls 15%+ between buys
- 🤖 **AI pack chatter** — responds when @-mentioned or when someone says "monwolf"/"wolf"/"pack"
- 📊 **Commands**: `/mc /price /chart /buy /ca /lp /holders /stats /pack /site`

## Premium custom emojis (optional)

The bot supports Telegram Premium animated/custom emojis. Premium users in your chat see the animated version; non-Premium users see the regular fallback. **Your bot doesn't need Premium — just the IDs.**

**How to get a custom emoji ID:**

1. Send the premium emoji you want in any chat
2. Forward that message to **@ShowJsonBot** (or **@RawDataBot**)
3. The bot replies with the message JSON
4. Find the `entities` array, look for the entity with `type: "custom_emoji"` — copy its `custom_emoji_id`
5. Paste into `.env` (e.g. `EMOJI_WOLF_ID=5368324170671202286`)

**Slots available:**

| Env var | Used in | Fallback |
|---|---|---|
| `EMOJI_WOLF_ID`    | Buy alerts header, pack mentions | 🐺 |
| `EMOJI_WHALE_ID`   | Whale alert | 🐋 |
| `EMOJI_MONEY_ID`   | "Spent" line | 💰 |
| `EMOJI_ROCKET_ID`  | (reserved) | 🚀 |
| `EMOJI_WEED_ID`    | Bite meter, header decoration | 🌿 |
| `EMOJI_FIRE_ID`    | (reserved) | 🔥 |
| `EMOJI_MOON_ID`    | MC line, milestones | 🌕 |
| `EMOJI_DIAMOND_ID` | Price line | 💎 |
| `EMOJI_ALERT_ID`   | Whale siren | 🚨 |

Leave any blank to keep the regular emoji. Bot uses HTML parse mode so this all works invisibly.

## Deploy on your server (206.189.216.202)

```bash
# 1. SSH in
ssh root@206.189.216.202

# 2. Pull this repo
cd /root
git clone <YOUR_REPO_URL> monwolf-buybot
cd monwolf-buybot

# 3. Install
npm install

# 4. Configure
cp .env.example .env
nano .env
# Fill in:
#   TG_BOT_TOKEN    (from @BotFather)
#   TG_CHAT_ID      (from @userinfobot — Monwolf group ID, will be negative number)
#   OPENAI_API_KEY  (your existing key)
#   RPC_URL         (Alchemy Monad endpoint)
#   MONWOLF_LP_PAIR (from monadscan token transfers OR ask Monwolf team)

# 5. Run via PM2
pm2 start src/index.js --name monwolf-buybot
pm2 save
pm2 logs monwolf-buybot
```

## Getting the LP pair address

The $MONWOLF token at `0x8361a59d340466211ad4aB41C09a32e4530a7777` is bonded on nad.fun, so it has a Crust V3 pool. To find it:

1. Go to `https://crustfinance.xyz/info/pools` and search MONWOLF
2. OR check DexScreener: `https://dexscreener.com/monad/0x8361a59d340466211ad4aB41C09a32e4530a7777` and copy the pair address shown
3. OR ask the Monwolf team directly

Once you have it, paste into `.env` as `MONWOLF_LP_PAIR=`.

## Tuning

- `AI_REPLY_CHANCE` — how often bot AI-replies to non-mention messages (default 0.35 → ~5% effective rate)
- `AI_COOLDOWN_SEC` — minimum gap between AI replies globally (default 20s; bumps to 60s if chat is spammy)
- `MIN_BUY_USD` — ignore dust below this (default $1)
- `WHALE_BUY_USD` — 🚨 ALPHA siren above this (default $500)
- `POLL_INTERVAL_MS` — how often to re-check (default 3s; Alchemy WSS makes this irrelevant for swaps, only DexScreener cache)

## Troubleshooting

- **No alerts firing** — check `pm2 logs monwolf-buybot`. Most common issue: wrong `MONWOLF_LP_PAIR`.
- **Bot doesn't respond to commands** — make sure the bot is added to the group as ADMIN with "Post Messages" permission.
- **AI replies too often** — lower `AI_REPLY_CHANCE` to 0.15 or bump `AI_COOLDOWN_SEC` to 60.
- **AI replies too rare** — raise `AI_REPLY_CHANCE` to 0.5.
- **Rate-limit issues** — DexScreener responses are cached 8s, so commands cost ~0 API calls; OpenAI cost ~$0.0001/reply on gpt-4o-mini.

## Cost estimate

- **Server** — already running, $0 marginal
- **Alchemy RPC** — included in your existing plan
- **OpenAI** — at gpt-4o-mini, ~$0.0001 per reply · 1000 replies = $0.10
- **DexScreener** — free
- **Total monthly** — under $5 even at heavy use
