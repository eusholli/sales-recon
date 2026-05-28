/**
 * viber-proxy — HTTP webhook bridge between Viber Bot API and OpenClaw.
 *
 * Mirrors the OpenClaw side of ws-proxy/index.js, but accepts Viber webhook
 * deliveries instead of browser WS connections. Each inbound user message is
 * mapped to a clerk userId via the event-planner webapp, an action token is
 * minted server-side, and the message is dispatched to OpenClaw using the same
 * sessionKey convention as the browser surface so chat history stays merged.
 */

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LRUCache } from './lru.js';
import { verifyViberSignature } from './signature.js';
import { ViberClient } from './viber-client.js';
import { OpenClawClient } from './openclaw-client.js';
import { loadOrCreateDeviceIdentity } from './device.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || '8081', 10);
const OPENCLAW_URL = process.env.OPENCLAW_URL || 'ws://sales-recon-openclaw:50045';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN;
// In mock mode, fall back to a fixed local-test secret so local-test.sh can
// sign synthetic webhooks without a real Viber bot token.
const VIBER_BOT_TOKEN = process.env.VIBER_BOT_TOKEN
    || (process.env.MOCK_VIBER_OUTBOUND === 'true' ? 'local-test-token' : '');
const VIBER_BOT_NAME = process.env.VIBER_BOT_NAME || 'Sales-Recon';
const VIBER_BOT_AVATAR_URL = process.env.VIBER_BOT_AVATAR_URL || '';
const WEBAPP_URL = (process.env.WEBAPP_URL || '').replace(/\/$/, '');
const VIBER_APP_URL = (process.env.VIBER_APP_URL || WEBAPP_URL).replace(/\/$/, '');
const CRON_SECRET_KEY = process.env.CRON_SECRET_KEY;
const MOCK_VIBER_OUTBOUND = process.env.MOCK_VIBER_OUTBOUND === 'true';

if (!OPENCLAW_TOKEN) {
    console.error('[viber-proxy] OPENCLAW_TOKEN env var is required');
    process.exit(1);
}
if (!VIBER_BOT_TOKEN && !MOCK_VIBER_OUTBOUND) {
    console.error('[viber-proxy] VIBER_BOT_TOKEN env var is required (or set MOCK_VIBER_OUTBOUND=true)');
    process.exit(1);
}
if (!WEBAPP_URL) {
    console.error('[viber-proxy] WEBAPP_URL env var is required');
    process.exit(1);
}
if (!CRON_SECRET_KEY) {
    console.error('[viber-proxy] CRON_SECRET_KEY env var is required');
    process.exit(1);
}

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const deviceIdentity = loadOrCreateDeviceIdentity(dataDir);
console.log(`[viber-proxy] Device id: ${deviceIdentity.deviceId}`);

const viber = new ViberClient({
    token: VIBER_BOT_TOKEN,
    name: VIBER_BOT_NAME,
    avatarUrl: VIBER_BOT_AVATAR_URL,
    mockOutbound: MOCK_VIBER_OUTBOUND,
});
if (MOCK_VIBER_OUTBOUND) {
    console.log('[viber-proxy] MOCK_VIBER_OUTBOUND=true — outbound Viber calls will be logged, not sent');
}

const openclaw = new OpenClawClient({
    url: OPENCLAW_URL,
    token: OPENCLAW_TOKEN,
    deviceIdentity,
    displayName: 'Sales-Recon-Viber-Proxy',
});
openclaw.connect();

// Dedupe webhook deliveries — Viber may retry on transient failure.
const recentTokens = new LRUCache(1000);

// Post a structured TargetUpdate to the event-planner intel-report webhook so
// the intelligenceReport table is updated immediately after every Viber
// intelligence response. Mirrors ws-proxy/index.js postIntelligenceReport so
// the agent never needs to shell out to sync_db.py.
async function postIntelligenceReport(report) {
    if (!WEBAPP_URL || !CRON_SECRET_KEY) {
        console.warn('[viber-proxy] WEBAPP_URL or CRON_SECRET_KEY not set — skipping intel report sync');
        return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const target = {
        type: report.type,
        name: report.name,
        summary: report.summary,
        salesAngle: report.salesAngle,
        fullReport: report.fullReport,
        ...(report.recommendedAction ? { recommendedAction: report.recommendedAction } : {}),
    };
    const payload = {
        runId: `${today}-adhoc`,
        timestamp: new Date().toISOString(),
        silent: true,
        updatedTargets: [target],
    };
    try {
        const res = await fetch(`${WEBAPP_URL}/api/webhooks/intel-report`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${CRON_SECRET_KEY}`,
            },
            body: JSON.stringify(payload),
        });
        if (res.ok) {
            console.log(`[viber-proxy] Intel report synced: ${report.type} '${report.name}'`);
        } else {
            const text = await res.text();
            console.error(`[viber-proxy] Intel report sync failed: ${res.status} ${text}`);
        }
    } catch (err) {
        console.error('[viber-proxy] Intel report sync error:', err.message);
    }
}

function isLinkedReply(viberName) {
    const url = `${WEBAPP_URL}/account/link-viber`;
    return `Hi${viberName ? ' ' + viberName : ''}! To use this bot, link your account first:\n${url}`;
}

async function callWebapp(pathname, body) {
    const res = await fetch(`${WEBAPP_URL}${pathname}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${CRON_SECRET_KEY}`,
        },
        body: JSON.stringify(body || {}),
    });
    let json = null;
    try { json = await res.json(); } catch { /* non-json */ }
    return { status: res.status, json };
}

async function lookupViberUser(viberUserId) {
    const { status, json } = await callWebapp('/api/viber/lookup', { viberUserId });
    if (status !== 200 || !json) return { linked: false };
    return json;
}

async function redeemLinkCode({ code, viberUserId, viberName }) {
    const { status, json } = await callWebapp('/api/viber/link/redeem', { code, viberUserId, viberName });
    if (status !== 200 || !json) return null;
    return json;
}


function isGroupMessage(body) {
    // Viber community/group messages carry chat_id and a sender that is a member of the chat.
    // DMs do not have chat_id.
    return Boolean(body && body.chat_id);
}

function deriveSessionKey({ group, clerkUserId, chatId }) {
    return group ? `viber-group-${chatId}` : `user-${clerkUserId}`;
}

// Group messages must begin with /<VIBER_BOT_NAME> (case-insensitive) to be
// forwarded. Returns the stripped user text, or null if the message is not
// addressed to this bot and must be dropped silently.
function extractGroupCommand(text) {
    const prefix = `/${VIBER_BOT_NAME}`;
    if (!text.toLowerCase().startsWith(prefix.toLowerCase())) return null;
    const rest = text.slice(prefix.length);
    if (rest.length > 0 && !/^\s/.test(rest)) return null;
    return rest.trim();
}

async function handleConversationStarted(req, res) {
    const body = req.body;
    const ctx = body.context;
    const sender = body.user || {};

    if (!ctx) {
        return res.json({
            sender: { name: VIBER_BOT_NAME, avatar: VIBER_BOT_AVATAR_URL || undefined },
            type: 'text',
            text: `Welcome! To use this bot, link your account at ${VIBER_APP_URL}/account/link-viber`,
        });
    }

    const redeem = await redeemLinkCode({
        code: ctx,
        viberUserId: sender.id,
        viberName: sender.name || '',
    });

    if (redeem && redeem.clerkUserId) {
        return res.json({
            sender: { name: VIBER_BOT_NAME, avatar: VIBER_BOT_AVATAR_URL || undefined },
            type: 'text',
            text: `Account linked${redeem.clerkName ? ' for ' + redeem.clerkName : ''}! You can now ask me for intel anytime.`,
        });
    }

    return res.json({
        sender: { name: VIBER_BOT_NAME, avatar: VIBER_BOT_AVATAR_URL || undefined },
        type: 'text',
        text: `That link code is invalid or expired. Please generate a new one at ${VIBER_APP_URL}/account/link-viber`,
    });
}

async function handleMessageEvent(body) {
    const message = body.message || {};
    const sender = body.sender || {};
    const messageToken = body.message_token;
    const chatId = body.chat_id || null;
    const group = isGroupMessage(body);

    if (messageToken && recentTokens.has(messageToken)) {
        console.log('[viber-proxy] dedupe message_token', messageToken);
        return;
    }
    if (messageToken) recentTokens.set(messageToken, true);

    if (message.type !== 'text' || !message.text) {
        if (!group && sender.id) {
            await viber.sendText(sender.id, 'Only text messages are supported right now.');
        }
        return;
    }

    const userText = String(message.text).trim();
    if (!userText) return;

    let effectiveText = userText;
    if (group) {
        const stripped = extractGroupCommand(userText);
        if (stripped === null) return;
        if (!stripped) return;
        effectiveText = stripped;
    }

    const lookup = await lookupViberUser(sender.id);

    if (!lookup.linked) {
        const linkUrl = `${WEBAPP_URL}/account/link-viber`;
        if (group) {
            await viber.sendText(
                { type: 'public_account', chat_id: chatId, from: sender.id },
                `${sender.name || 'There'} — link your account first to use me here: ${linkUrl}`,
            );
        } else {
            await viber.sendText(sender.id, isLinkedReply(sender.name || ''));
        }
        return;
    }

    const sessionKey = deriveSessionKey({ group, clerkUserId: lookup.clerkUserId, chatId }).toLowerCase();

    const replyTarget = group
        ? { type: 'public_account', chat_id: chatId, from: sender.id }
        : sender.id;

    // Intercept special commands before forwarding to OpenClaw.
    if (effectiveText === '/new') {
        openclaw.resetSession(sessionKey);
        await viber.sendText(replyTarget, 'Session cleared. What would you like to research?');
        return;
    }

    if (effectiveText === '/history') {
        openclaw.fetchHistory(sessionKey, async (messages) => {
            const formatted = messages.length === 0
                ? 'No conversation history yet.'
                : '**Conversation History:**\n\n' + messages
                    .map(m => `**${m.role === 'user' ? 'You' : 'Assistant'}:** ${m.content}`)
                    .join('\n\n---\n\n');
            const text = ViberClient.convertMarkdown(formatted);
            try {
                if (group) {
                    for (const part of ViberClient.chunk(text)) {
                        await viber.sendText(replyTarget, part);
                    }
                } else {
                    await viber.sendLongText(sender.id, text);
                }
            } catch (e) {
                console.error('[viber-proxy] failed to deliver history reply:', e.message);
            }
        });
        return;
    }

    // Acknowledge fast so the user sees activity.
    try {
        await viber.sendText(replyTarget, 'Working on it…');
    } catch (e) {
        console.warn('[viber-proxy] ack send failed:', e.message);
    }

    const role = lookup.role || 'user';
    const userMessage = group
        ? `[from: ${lookup.clerkName || sender.name || 'unknown'}, role: ${role}] ${effectiveText}`
        : effectiveText;

    openclaw.sendMessage({
        sessionKey,
        message: userMessage,
        onFinal: async ({ text, report }) => {
            const finalText = ViberClient.convertMarkdown((text && text.trim()) || 'No response.');
            console.log(`[viber-proxy] onFinal: sending reply (${finalText.length} chars)`);
            try {
                if (group) {
                    const parts = ViberClient.chunk(finalText);
                    for (const part of parts) {
                        await viber.sendText({ type: 'public_account', chat_id: chatId, from: sender.id }, part);
                    }
                } else {
                    await viber.sendLongText(sender.id, finalText);
                }
                console.log('[viber-proxy] reply delivered ok');
            } catch (e) {
                console.error('[viber-proxy] failed to deliver final reply:', e.message);
            }
            if (report) {
                console.log(`[viber-proxy] structured report: type=${report.type} name=${report.name}`);
                postIntelligenceReport(report).catch(() => {});
            }
        },
    });
}

const app = express();

// Capture raw body for signature verification while still parsing JSON.
app.use('/viber/webhook', express.json({
    verify: (req, _res, buf) => { req.rawBody = buf; },
    limit: '1mb',
}));

app.get('/healthz', (_req, res) => {
    res.json({ ok: true, openclaw: openclaw.isConnected });
});

app.post('/viber/webhook', async (req, res) => {
    const sig = req.get('X-Viber-Content-Signature');
    if (!verifyViberSignature(VIBER_BOT_TOKEN, req.rawBody, sig)) {
        console.warn('[viber-proxy] signature mismatch');
        return res.status(403).json({ error: 'invalid_signature' });
    }

    const body = req.body || {};
    const event = body.event;

    if (process.env.DEBUG === 'true') {
        console.log('[viber-proxy] webhook', event, JSON.stringify(body).slice(0, 500));
    }

    try {
        switch (event) {
            case 'webhook':
                return res.json({});
            case 'conversation_started':
                return await handleConversationStarted(req, res);
            case 'message':
                res.json({});
                handleMessageEvent(body).catch(err =>
                    console.error('[viber-proxy] message handler error:', err)
                );
                return;
            case 'subscribed':
            case 'unsubscribed':
            case 'delivered':
            case 'seen':
            case 'failed':
                return res.json({});
            default:
                console.log('[viber-proxy] unhandled event:', event);
                return res.json({});
        }
    } catch (err) {
        console.error('[viber-proxy] webhook error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'internal' });
    }
});

app.listen(PORT, () => {
    console.log(`[viber-proxy] Listening on :${PORT}`);
});
