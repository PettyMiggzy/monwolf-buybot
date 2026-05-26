// =============================================================
//  MONWOLF BUY BOT
//  - Watches Crust V3 LP pair for Swap events
//  - Posts buy alerts in TG with Monwolf pack lineage voice
//  - Commands: /mc /price /chart /buy /ca /lp /holders /stats /pack
//  - AI pack interaction (OpenAI) - replies to mentions + random pack chatter
// =============================================================
import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { ethers } from 'ethers';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUY_GIF_PATH = path.resolve(__dirname, '..', 'assets', 'buy-alert.mp4');
const HAS_BUY_GIF = fs.existsSync(BUY_GIF_PATH);

// ----------------------------------------------------------------
// CONFIG
// ----------------------------------------------------------------
const C = {
  TG_BOT_TOKEN:   process.env.TG_BOT_TOKEN,
  TG_CHAT_ID:     process.env.TG_CHAT_ID,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL:   process.env.OPENAI_MODEL || 'gpt-4o-mini',
  RPC_URL:        process.env.RPC_URL,
  TOKEN:          process.env.MONWOLF_TOKEN,
  LP:             process.env.MONWOLF_LP_PAIR,
  WMON:           process.env.WMON,
  MIN_BUY_USD:    +process.env.MIN_BUY_USD     || 1,
  WHALE_USD:      +process.env.WHALE_BUY_USD   || 500,
  POLL_MS:        +process.env.POLL_INTERVAL_MS|| 3000,
  AI_CHANCE:      +process.env.AI_REPLY_CHANCE || 0.35,
  AI_COOLDOWN:    +process.env.AI_COOLDOWN_SEC || 20,
  LP_DROP_PCT:    +process.env.LP_DROP_ALERT_PCT || 15,
};

// Premium custom emoji slots — fallback to regular emoji if no ID set
// (Currently only money has a premium ID; the rest stay plain emojis.)
const EMOJI = {
  money:   { fallback: '🤑', id: process.env.EMOJI_MONEY_ID   },
};

// Wrap an emoji in <tg-emoji> only when a custom ID is configured.
// Premium users see the animated version, others see the fallback.
function e(key) {
  const slot = EMOJI[key];
  if (!slot) return '';
  return slot.id
    ? `<tg-emoji emoji-id="${slot.id}">${slot.fallback}</tg-emoji>`
    : slot.fallback;
}

// HTML-escape user-supplied/dynamic strings going into HTML messages
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

['TG_BOT_TOKEN','TG_CHAT_ID','OPENAI_API_KEY','RPC_URL','TOKEN','LP'].forEach(k => {
  if (!C[k]) { console.error(`❌ Missing env: ${k}`); process.exit(1); }
});

// ----------------------------------------------------------------
// SETUP
// ----------------------------------------------------------------
const tg = new TelegramBot(C.TG_BOT_TOKEN, { polling: true });
const ai = new OpenAI({ apiKey: C.OPENAI_API_KEY });
const provider = new ethers.JsonRpcProvider(C.RPC_URL);

// Crust V3 (Uniswap V3 fork) Pool ABI - just what we need
const POOL_ABI = [
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function liquidity() view returns (uint128)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
];

const pool   = new ethers.Contract(C.LP, POOL_ABI, provider);
const token  = new ethers.Contract(C.TOKEN, ERC20_ABI, provider);

let TOKEN_IS_0 = null; // figured out at boot — which side of the pair is $MONWOLF
let LAST_LP_USD = 0;
let AI_LAST_REPLY = 0;
let buyTracker = new Map(); // wallet -> count of buys seen (tier system)

// ----------------------------------------------------------------
// HELPERS
// ----------------------------------------------------------------
const shortAddr = (a) => `${a.slice(0,6)}…${a.slice(-4)}`;
const fmtUsd = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 6 : 2 });
const fmtNum = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));

function tierFor(count) {
  if (count >= 50) return { name: 'ALPHA',  emoji: '🐺👑' };
  if (count >= 16) return { name: 'BETA',   emoji: '🐺⚡' };
  if (count >= 6)  return { name: 'SCOUT',  emoji: '🦊'   };
  if (count >= 2)  return { name: 'PACK',   emoji: '🐺'   };
  return                  { name: 'CUB',    emoji: '🐶'   };
}

// ----------------------------------------------------------------
// DEXSCREENER — single source of truth for price/MC/LP/volume
// ----------------------------------------------------------------
let dsCache = { at: 0, data: null };
async function dex() {
  if (Date.now() - dsCache.at < 8000 && dsCache.data) return dsCache.data;
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${C.TOKEN}`);
    const j = await r.json();
    if (!j.pairs || !j.pairs.length) return null;
    // pick pair with highest liquidity
    const p = j.pairs.sort((a,b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0))[0];
    dsCache = { at: Date.now(), data: p };
    return p;
  } catch (e) {
    console.warn('dex fetch failed', e.message);
    return null;
  }
}

// ----------------------------------------------------------------
// HOLDER COUNT — approximate (Monad explorer scrape, no auth needed)
// ----------------------------------------------------------------
async function holderCount() {
  try {
    const r = await fetch(`https://monadscan.com/token/${C.TOKEN}`);
    const html = await r.text();
    const m = html.match(/Holders[^0-9]*([\d,]+)/i);
    return m ? +m[1].replace(/,/g,'') : null;
  } catch { return null; }
}

// ----------------------------------------------------------------
// BUY ALERT
// ----------------------------------------------------------------
async function postBuyAlert({ buyer, monSpent, tokensGot, txHash }) {
  const d = await dex();
  if (!d) return;
  const priceUsd  = +d.priceUsd || 0;
  const usdSpent  = monSpent * (+d.priceNative ? (priceUsd / +d.priceNative) : 0);
  if (usdSpent < C.MIN_BUY_USD) return;

  // track tier
  const prev = buyTracker.get(buyer.toLowerCase()) || 0;
  buyTracker.set(buyer.toLowerCase(), prev + 1);
  const tier = tierFor(prev + 1);

  const mc       = +d.fdv || 0;
  const lpUsd    = +d.liquidity?.usd || 0;
  const change   = +d.priceChange?.h24 || 0;
  const isWhale  = usdSpent >= C.WHALE_USD;

  // 🤑 meter scaled by buy size. Premium users see the animated version.
  // small buy ($1-25)   → 3-15 emojis
  // medium ($25-100)    → 15-40 emojis
  // big ($100-500)      → 40-80 emojis
  // whale ($500+)       → 80-200 emojis (wall of money)
  let count;
  if (usdSpent < 25)        count = Math.max(3,  Math.floor(usdSpent * 0.6));
  else if (usdSpent < 100)  count = Math.floor(15 + (usdSpent - 25) * 0.33);
  else if (usdSpent < 500)  count = Math.floor(40 + (usdSpent - 100) * 0.1);
  else                      count = Math.min(200, Math.floor(80 + (usdSpent - 500) * 0.12));

  // Break meter into rows of 20 so it wraps nicely in Telegram
  const moneyEmoji = e('money');
  const rows = [];
  for (let i = 0; i < count; i += 20) {
    rows.push(moneyEmoji.repeat(Math.min(20, count - i)));
  }
  const meter = rows.join('\n');

  const header = isWhale
    ? `🚨 <b>PACK ALPHA BITE</b> 🐋🚨`
    : `🐺 <b>PACK ATE</b>`;

  const lines = [
    header,
    '━━━━━━━━━━━━━━━━━━━',
    meter,
    '',
    `${e('money')} <b>Spent:</b> ${monSpent.toFixed(3)} MON · ${esc(fmtUsd(usdSpent))}`,
    `📦 <b>Got:</b> ${esc(fmtNum(tokensGot))} $MONWOLF`,
    `💎 <b>Price:</b> ${esc(fmtUsd(priceUsd))} (${change >= 0 ? '+' : ''}${change.toFixed(1)}% 24h)`,
    `🌕 <b>MC:</b> ${esc(fmtUsd(mc))}`,
    `💧 <b>LP:</b> ${esc(fmtUsd(lpUsd))}`,
    '',
    `${tier.emoji} <b>Buyer:</b> <code>${shortAddr(buyer)}</code> · tier <b>${tier.name}</b> (${prev + 1} bite${prev ? 's' : ''})`,
    '',
    `<a href="https://dexscreener.com/monad/${C.LP}">chart</a> · <a href="https://nad.fun/token/${C.TOKEN}">buy</a> · <a href="https://monadscan.com/tx/${txHash}">tx</a> · <a href="https://monwolf.fun">site</a>`,
  ];

  const caption = lines.join('\n');
  if (HAS_BUY_GIF) {
    try {
      await tg.sendAnimation(C.TG_CHAT_ID, BUY_GIF_PATH, {
        caption,
        parse_mode: 'HTML',
      });
    } catch (e) {
      console.warn('sendAnimation failed, falling back to text:', e.message);
      await tg.sendMessage(C.TG_CHAT_ID, caption, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    }
  } else {
    await tg.sendMessage(C.TG_CHAT_ID, caption, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }

  // LP drop alert
  if (LAST_LP_USD && lpUsd < LAST_LP_USD * (1 - C.LP_DROP_PCT / 100)) {
    await tg.sendMessage(C.TG_CHAT_ID,
      `⚠️ <b>LP DROP WARNING</b> ⚠️\nLP fell from ${esc(fmtUsd(LAST_LP_USD))} → ${esc(fmtUsd(lpUsd))} (${(((lpUsd - LAST_LP_USD)/LAST_LP_USD)*100).toFixed(1)}%)\nKeep eyes on the pack 🐺`,
      { parse_mode: 'HTML' });
  }
  LAST_LP_USD = lpUsd;
}

// ----------------------------------------------------------------
// SWAP LISTENER
// ----------------------------------------------------------------
async function initListener() {
  const t0 = (await pool.token0()).toLowerCase();
  TOKEN_IS_0 = (t0 === C.TOKEN.toLowerCase());
  console.log(`✅ LP pair confirmed · token0=${t0} · monwolf is ${TOKEN_IS_0 ? 'token0' : 'token1'}`);

  pool.on('Swap', async (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick, event) => {
    try {
      const a0 = Number(ethers.formatEther(amount0));
      const a1 = Number(ethers.formatEther(amount1));
      // For a buy: token amount comes OUT of the pool (negative), WMON goes IN (positive)
      const monwolfDelta = TOKEN_IS_0 ? a0 : a1;
      const wmonDelta    = TOKEN_IS_0 ? a1 : a0;
      const isBuy = monwolfDelta < 0 && wmonDelta > 0;
      if (!isBuy) return;
      const tokensGot = Math.abs(monwolfDelta);
      const monSpent  = wmonDelta;
      console.log(`🐺 buy detected · ${shortAddr(recipient)} · ${monSpent.toFixed(2)} MON → ${fmtNum(tokensGot)} $MONWOLF`);
      await postBuyAlert({
        buyer:     recipient,
        monSpent,
        tokensGot,
        txHash:    event.log.transactionHash,
      });
    } catch (e) {
      console.error('swap handler error', e.message);
    }
  });

  console.log('🎧 listening for swaps on', C.LP);
}

// ----------------------------------------------------------------
// COMMANDS
// ----------------------------------------------------------------
async function statsBlock() {
  const d = await dex();
  if (!d) return '⚠️ market data unavailable, try again in a sec';
  const hc = await holderCount();
  return [
    '🐺 *$MONWOLF · pack stats* 🌿',
    '━━━━━━━━━━━━━━━━━━━',
    `💎 *Price:* ${fmtUsd(+d.priceUsd)}`,
    `🌕 *MC:* ${fmtUsd(+d.fdv)}`,
    `💧 *LP:* ${fmtUsd(+d.liquidity?.usd || 0)}`,
    `📊 *24h Vol:* ${fmtUsd(+d.volume?.h24 || 0)}`,
    `📈 *24h Δ:* ${(+d.priceChange?.h24 >= 0 ? '+' : '')}${(+d.priceChange?.h24 || 0).toFixed(1)}%`,
    hc ? `🐾 *Holders:* ${fmtNum(hc)}` : '',
    '',
    `🔗 CA: \`${C.TOKEN}\``,
    `[chart](https://dexscreener.com/monad/${C.LP}) · [buy](https://nad.fun/token/${C.TOKEN}) · [site](https://monwolf.fun)`,
  ].filter(Boolean).join('\n');
}

tg.onText(/^\/(start|help|commands)(@\w+)?$/i, (msg) => {
  tg.sendMessage(msg.chat.id, [
    '🐺 *MONWOLF PACK BOT* 🌿',
    '',
    'Commands:',
    '• /mc · market cap',
    '• /price · current price',
    '• /chart · DexScreener',
    '• /buy · swap on Crust',
    '• /ca · contract address',
    '• /lp · liquidity',
    '• /holders · holder count',
    '• /stats · everything at once',
    '• /pack · pack lore + classifier',
    '• /site · monwolf.fun',
    '',
    'I also chat with the pack 🐺 — just @ me or say my name.',
  ].join('\n'), { parse_mode: 'Markdown' });
});

tg.onText(/^\/(mc)(@\w+)?$/i, async (msg) => {
  const d = await dex();
  if (!d) return tg.sendMessage(msg.chat.id, '⚠️ no data');
  tg.sendMessage(msg.chat.id, `🌕 *MC:* ${fmtUsd(+d.fdv)} · pack growing`, { parse_mode: 'Markdown' });
});

tg.onText(/^\/(price)(@\w+)?$/i, async (msg) => {
  const d = await dex();
  if (!d) return tg.sendMessage(msg.chat.id, '⚠️ no data');
  tg.sendMessage(msg.chat.id, `💎 *${fmtUsd(+d.priceUsd)}* (${(+d.priceChange?.h24 || 0).toFixed(1)}% 24h)`, { parse_mode: 'Markdown' });
});

tg.onText(/^\/(chart)(@\w+)?$/i, (msg) => {
  tg.sendMessage(msg.chat.id, `📊 chart: https://dexscreener.com/monad/${C.LP}`);
});

tg.onText(/^\/(buy)(@\w+)?$/i, (msg) => {
  tg.sendMessage(msg.chat.id, `💊 buy: https://nad.fun/token/${C.TOKEN}`);
});

tg.onText(/^\/(ca)(@\w+)?$/i, (msg) => {
  tg.sendMessage(msg.chat.id, `🔗 CA:\n\`${C.TOKEN}\``, { parse_mode: 'Markdown' });
});

tg.onText(/^\/(lp)(@\w+)?$/i, async (msg) => {
  const d = await dex();
  if (!d) return tg.sendMessage(msg.chat.id, '⚠️ no data');
  tg.sendMessage(msg.chat.id, `💧 LP: *${fmtUsd(+d.liquidity?.usd || 0)}*`, { parse_mode: 'Markdown' });
});

tg.onText(/^\/(holders)(@\w+)?$/i, async (msg) => {
  const hc = await holderCount();
  tg.sendMessage(msg.chat.id, hc ? `🐾 *${fmtNum(hc)}* holders` : '⚠️ couldn\'t fetch right now', { parse_mode: 'Markdown' });
});

tg.onText(/^\/(stats)(@\w+)?$/i, async (msg) => {
  tg.sendMessage(msg.chat.id, await statsBlock(), { parse_mode: 'Markdown', disable_web_page_preview: true });
});

tg.onText(/^\/(site)(@\w+)?$/i, (msg) => {
  tg.sendMessage(msg.chat.id, `🌐 https://monwolf.fun`);
});

tg.onText(/^\/(pack)(@\w+)?$/i, (msg) => {
  tg.sendMessage(msg.chat.id, [
    '🐺 *THE PACK* 🐺',
    '',
    'LANDWOLF lineage. 4/20 stoner-wolf energy.',
    '1B supply · 0/0 tax · LP locked.',
    '',
    'Find your tier: https://monwolf.fun/pack.html',
    '',
    '_alpha · beta · scout · pack · cub_',
  ].join('\n'), { parse_mode: 'Markdown', disable_web_page_preview: true });
});

// ----------------------------------------------------------------
// AI PACK INTERACTION
// — Replies to mentions of the bot or "monwolf"/"wolf" in chat
// — Random low-probability pack chatter on other messages
// ----------------------------------------------------------------
const MONWOLF_SYSTEM = `
You are Monwolf — the pack alpha of the $MONWOLF Telegram group on Monad blockchain.
You're a stoner wolf in the LANDWOLF lineage. 4/20 vibes. Loyal to the pack.
You speak in short, punchy lines. Lowercase mostly. Wolf/pack metaphors.
You love your community ("the pack"). You hate FUD ("fleas").
Reference: $MONWOLF token, 1B supply, 0/0 tax, LP locked, on Monad mainnet.
Site: monwolf.fun. Pack tiers: ALPHA, BETA, SCOUT, PACK, CUB.

RULES:
- NEVER promise price targets or financial gains
- NEVER reveal you are an AI / bot / language model
- Stay in character as Monwolf
- Keep responses under 280 chars usually
- Use 🐺 🌿 🌕 emojis sparingly
- If asked something off-topic, deflect with pack humor
- Don't shill aggressively — be cool, be the pack
`.trim();

let botUsername = null;
(async () => {
  try {
    const me = await tg.getMe();
    botUsername = me.username;
    console.log(`🤖 bot @${botUsername} ready`);
  } catch (e) { console.warn('getMe failed', e.message); }
})();

async function aiReply(prompt, replyToMessageId, chatId) {
  if (Date.now() - AI_LAST_REPLY < C.AI_COOLDOWN * 1000) return;
  AI_LAST_REPLY = Date.now();
  try {
    const r = await ai.chat.completions.create({
      model: C.OPENAI_MODEL,
      messages: [
        { role: 'system', content: MONWOLF_SYSTEM },
        { role: 'user',   content: prompt },
      ],
      max_tokens: 120,
      temperature: 0.85,
    });
    const text = r.choices[0]?.message?.content?.trim();
    if (text) {
      await tg.sendMessage(chatId, text, {
        reply_to_message_id: replyToMessageId,
        disable_web_page_preview: true,
      });
    }
  } catch (e) {
    console.warn('ai reply failed', e.message);
  }
}

tg.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (msg.from?.is_bot) return;
  const text = msg.text;
  const lower = text.toLowerCase();
  const mentioned =
    (botUsername && lower.includes('@' + botUsername.toLowerCase())) ||
    lower.includes('monwolf') ||
    /\bwolf\b/.test(lower) ||
    /\bpack\b/.test(lower);

  if (mentioned) {
    await aiReply(text, msg.message_id, msg.chat.id);
    return;
  }

  // Random low-probability pack chatter on other messages (keeps the chat alive)
  if (Math.random() < C.AI_CHANCE * 0.15) { // ~5% on non-mentions
    await aiReply(text, msg.message_id, msg.chat.id);
  }
});

// ----------------------------------------------------------------
// MILESTONE PINGS (MC round-numbers)
// ----------------------------------------------------------------
const MILESTONES = [100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000];
let nextMilestoneIdx = 0;
async function checkMilestones() {
  const d = await dex();
  if (!d || !d.fdv) return;
  while (nextMilestoneIdx < MILESTONES.length && +d.fdv >= MILESTONES[nextMilestoneIdx]) {
    const m = MILESTONES[nextMilestoneIdx];
    await tg.sendMessage(C.TG_CHAT_ID, [
      `🌕🌕🌕 <b>MILESTONE</b> 🌕🌕🌕`,
      `$MONWOLF just crossed <b>${esc(fmtUsd(m))}</b> MC`,
      `the pack runs together 🐺`,
    ].join('\n'), { parse_mode: 'HTML' });
    nextMilestoneIdx++;
  }
}

// Find current milestone index at boot so we don't spam on start
(async () => {
  const d = await dex();
  if (d?.fdv) {
    while (nextMilestoneIdx < MILESTONES.length && +d.fdv >= MILESTONES[nextMilestoneIdx]) {
      nextMilestoneIdx++;
    }
  }
})();

// ----------------------------------------------------------------
// BOOT
// ----------------------------------------------------------------
(async () => {
  console.log('🐺 monwolf-buybot starting…');
  console.log(HAS_BUY_GIF ? `🎬 buy-alert.mp4 loaded (${(fs.statSync(BUY_GIF_PATH).size/1024).toFixed(0)} KB)` : '⚠️  assets/buy-alert.mp4 missing — alerts will be text only');
  await initListener();
  // Periodic checks (milestones every 60s)
  setInterval(checkMilestones, 60_000);
  // Initial LP snapshot
  const d = await dex();
  LAST_LP_USD = +d?.liquidity?.usd || 0;
  console.log(`🚀 ready · LP baseline ${fmtUsd(LAST_LP_USD)}`);
})();

process.on('uncaughtException', (e) => console.error('uncaught', e));
process.on('unhandledRejection', (e) => console.error('unhandled', e));
