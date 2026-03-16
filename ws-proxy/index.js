/**
 * WebSocket Proxy for OpenClaw Sales-Recon
 * 
 * - Connects to sales-recon with the gateway token
 * - Exposes a public WebSocket for browser clients
 * - Routes messages between browsers and OpenClaw
 */

import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { verifyToken } from '@clerk/backend';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadOrCreateDeviceIdentity, buildDeviceAuthPayloadV3, signDevicePayload, publicKeyToBase64Url } from './device.js';

const OPENCLAW_URL = process.env.OPENCLAW_URL || 'ws://openclaw:50045';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN;
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8080', 10);
const DEVICE_DATA_DIR = process.env.DEVICE_DATA_DIR || '/app/data';

if (!OPENCLAW_TOKEN) {
    console.error('[ws-proxy] OPENCLAW_TOKEN is required');
    process.exit(1);
}

// Load or create a persistent device identity (Ed25519 keypair)
const deviceIdentity = loadOrCreateDeviceIdentity(DEVICE_DATA_DIR);
console.log(`[ws-proxy] Device ID: ${deviceIdentity.deviceId}`);

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let openclawWs = null;
let isConnected = false;
let requestId = 0;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

// Maps browser WebSocket -> session info
const browserSessions = new Map();
// Maps sessionKey -> Set<WebSocket>
const sessionToBrowser = new Map();
// Maps request ID -> { browserWs, sessionKey }
const pendingRequests = new Map();
// Buffer for accumulating assistant response per session
const assistantBuffers = new Map();
// Parser state for thinking tags (stream=assistant)
const sessionParsingState = new Map();
// Maps sessionKey -> { [actionId]: { tool, eventId, args, timestamp } }
const sessionPendingActions = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// Chat History Persistence
// ─────────────────────────────────────────────────────────────────────────────

const HISTORY_DIR = path.join(DEVICE_DATA_DIR, 'history');
fs.mkdirSync(HISTORY_DIR, { recursive: true });

function getHistoryPath(userId) {
    return path.join(HISTORY_DIR, `${userId}.json`);
}

function loadHistory(userId) {
    try {
        const data = fs.readFileSync(getHistoryPath(userId), 'utf8');
        return JSON.parse(data);
    } catch {
        return [];
    }
}

// Strip <think>/<thinking> blocks so history content matches what was rendered
// in the browser (ReactMarkdown drops raw HTML tags and their content).
function stripThinkingBlocks(content) {
    return content.replace(/<(?:think|thinking)[^>]*>[\s\S]*?<\/(?:think|thinking)>/gi, '').trim();
}

function appendToHistory(userId, message) {
    const history = loadHistory(userId);
    const entry = message.role === 'assistant' && message.content
        ? { ...message, content: stripThinkingBlocks(message.content) }
        : message;
    history.push(entry);
    fs.writeFileSync(getHistoryPath(userId), JSON.stringify(history, null, 2), 'utf8');
}

function sendHistory(ws, userId) {
    const history = loadHistory(userId);
    if (history.length > 0) {
        sendToBrowser(ws, { type: 'history', messages: history });
        console.log(`[ws-proxy] Sent ${history.length} history messages to user ${userId}`);
    }
}

function archiveAndResetHistory(userId) {
    const historyPath = getHistoryPath(userId);
    try {
        const data = fs.readFileSync(historyPath, 'utf8');
        const history = JSON.parse(data);
        if (history.length > 0) {
            // Build a filesystem-safe ISO timestamp: 2026-03-02T04-35-00
            const now = new Date();
            const ts = now.toISOString().replace(/:/g, '-').replace(/\..*$/, '');
            const archivePath = path.join(HISTORY_DIR, `${userId}_${ts}.json`);
            fs.renameSync(historyPath, archivePath);
            console.log(`[ws-proxy] Archived history for ${userId} -> ${archivePath}`);
        }
    } catch {
        // No history file or empty — nothing to archive
    }
    // Create a fresh empty history file
    fs.writeFileSync(historyPath, '[]', 'utf8');
    console.log(`[ws-proxy] Created fresh history for ${userId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenClaw Connection
// ─────────────────────────────────────────────────────────────────────────────

function connectToOpenClaw() {
    const url = `${OPENCLAW_URL}?token=${OPENCLAW_TOKEN}`;
    console.log(`[ws-proxy] Connecting to OpenClaw: ${OPENCLAW_URL}`);

    openclawWs = new WebSocket(url);

    openclawWs.on('open', () => {
        console.log('[ws-proxy] Connected to OpenClaw');
        reconnectDelay = 1000;
    });

    openclawWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            handleOpenClawMessage(msg);
        } catch (e) {
            console.error('[ws-proxy] Failed to parse OpenClaw message:', e);
        }
    });

    openclawWs.on('close', (code, reason) => {
        console.log(`[ws-proxy] OpenClaw connection closed: ${code} - ${reason}`);
        isConnected = false;
        scheduleReconnect();
    });

    openclawWs.on('error', (err) => {
        console.error('[ws-proxy] OpenClaw connection error:', err.message);
    });
}

function scheduleReconnect() {
    console.log(`[ws-proxy] Reconnecting in ${reconnectDelay}ms...`);
    setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
        connectToOpenClaw();
    }, reconnectDelay);
}

async function getValidToken(session) {
    const thirtyMin = 30 * 60 * 1000;
    const ctx = session.sessionCtx;
    if (!ctx) return null;
    const expiresAt = ctx.expiresAt ? new Date(ctx.expiresAt).getTime() : 0;
    if (!ctx.actionToken || (expiresAt && Date.now() > expiresAt - thirtyMin)) {
        const webappUrl = process.env.WEBAPP_URL;
        const cronSecretKey = process.env.CRON_SECRET_KEY;
        if (!webappUrl || !cronSecretKey) return ctx.actionToken;
        try {
            const sessionRes = await fetch(`${webappUrl}/api/intelligence/session`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${cronSecretKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ clerkToken: session.token, eventId: session.eventId ?? undefined })
            });
            if (sessionRes.ok) {
                const data = await sessionRes.json();
                ctx.actionToken = data.actionToken;
                ctx.expiresAt = data.expiresAt;
                console.log(`[ws-proxy] Token refreshed for session`);
            }
        } catch (err) {
            console.warn('[ws-proxy] Token refresh failed:', err.message);
        }
    }
    return ctx?.actionToken ?? null;
}

async function callEventPlannerAction(token, { tool, eventId, args }) {
    const webappUrl = process.env.WEBAPP_URL;
    if (!webappUrl) return { ok: false, data: { error: 'WEBAPP_URL not configured' } };
    try {
        const res = await fetch(`${webappUrl}/api/intelligence/actions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ tool, eventId, args: { ...args, confirmed: true } })
        });
        const data = await res.json();
        return { ok: res.ok, data };
    } catch (err) {
        return { ok: false, data: { error: err.message } };
    }
}

function formatActionPreview(tool, args) {
    switch (tool) {
        case 'createMeeting':
            return `Create meeting: "${args.title || 'Untitled'}" on ${args.date || '?'} ${args.startTime || ''}–${args.endTime || ''}`;
        case 'cancelMeeting':
            return `Cancel meeting ID: ${args.meetingId || '?'}`;
        case 'updateMeeting':
            return `Update meeting ID: ${args.meetingId || '?'}`;
        case 'addAttendee':
            return `Add attendee: ${args.name || '?'} (${args.email || '?'})`;
        case 'updateCompany':
            return `Update company ID: ${args.companyId || '?'}`;
        case 'updateROITargets':
            return `Update ROI targets for event: ${args.eventId || '?'}`;
        default:
            return `${tool}: ${JSON.stringify(args)}`;
    }
}

function getNextId() {
    return `proxy-${++requestId}`;
}

function handleOpenClawMessage(msg) {
    if (process.env.DEBUG === 'true') {
        console.log('[ws-proxy] OpenClaw:', JSON.stringify(msg));
    }

    // Handle connect challenge — respond with device-signed auth
    if (msg.event === 'connect.challenge') {
        const nonce = msg.payload?.nonce;
        const signedAt = Date.now();
        const role = 'operator';
        const scopes = ['operator.read', 'operator.write'];
        const clientId = 'gateway-client';
        const clientMode = 'backend';

        const platform = 'linux';
        const deviceFamily = 'server';

        // Build and sign the device auth payload (v3 format)
        const authPayload = buildDeviceAuthPayloadV3({
            deviceId: deviceIdentity.deviceId,
            clientId,
            clientMode,
            role,
            scopes,
            signedAtMs: signedAt,
            token: OPENCLAW_TOKEN,
            nonce,
            platform,
            deviceFamily,
        });
        const signature = signDevicePayload(deviceIdentity.privateKeyPem, authPayload);

        const response = {
            type: 'req',
            id: getNextId(),
            method: 'connect',
            params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                    id: clientId,
                    displayName: 'Sales-Recon-Proxy-Dallas',
                    version: '1.0.0',
                    platform,
                    deviceFamily,
                    mode: clientMode,
                },
                role,
                scopes,
                caps: ['tool-events'],
                auth: { token: OPENCLAW_TOKEN },
                device: {
                    id: deviceIdentity.deviceId,
                    publicKey: publicKeyToBase64Url(deviceIdentity.publicKeyPem),
                    signature,
                    signedAt,
                    nonce,
                },
                locale: 'en-US',
                userAgent: 'sales-recon-ws-proxy/1.0.0',
            },
        };
        console.log('[ws-proxy] Sending connect handshake (protocol v3, device-signed)');
        const frame = JSON.stringify(response);
        console.log('[ws-proxy] -> OpenClaw (Handshake):', frame);
        openclawWs.send(frame);
        return;
    }

    // Handle connect response (hello-ok)
    if (msg.type === 'res' && msg.ok && !isConnected) {
        isConnected = true;
        console.log('[ws-proxy] Handshake complete, ready for clients');
        return;
    }

    // Handle chat.send response (OK acknowledgment)
    if (msg.type === 'res' && typeof msg.id === 'string') {
        const pending = pendingRequests.get(msg.id);
        if (pending && !msg.ok) {
            // Error response
            const error = msg.error?.message || 'Unknown error';
            sendToBrowser(pending.browserWs, { type: 'error', message: error });
            pendingRequests.delete(msg.id);
        }
        // OK responses are just acknowledgments; actual content comes via events
        return;
    }

    // Helper: resolve the session key from agent events (strip agent:main: prefix)
    function resolveSessionKey(rawKey) {
        if (rawKey && rawKey.includes(':')) {
            const parts = rawKey.split(':');
            return parts[parts.length - 1];
        }
        return rawKey;
    }

    // Helper: find userId for a sessionKey
    function findUserIdForSession(sessionKey) {
        for (const [ws, session] of browserSessions) {
            if (session.sessionKey === sessionKey) return session.userId;
        }
        return null;
    }

    // Handle agent events (streaming delta, status, thinking, tool)
    if (msg.type === 'event' && msg.event === 'agent') {
        const payload = msg.payload || {};
        const rawSessionKey = payload.sessionKey;
        const sessionKey = resolveSessionKey(rawSessionKey);
        const browserWsSet = sessionToBrowser.get(sessionKey);
        const hasClients = browserWsSet && browserWsSet.size > 0;

        console.log(`[ws-proxy] Agent event: stream=${payload.stream}, rawKey=${rawSessionKey}, resolvedKey=${sessionKey}, clientsFound=${hasClients}`);

        // Capture assistant content from stream
        // Buffer accumulation is unconditional (independent of hasClients) so history
        // is always saved even when the browser is temporarily disconnected.
        if (payload.stream === 'assistant' && payload.data?.delta) {
            const delta = payload.data.delta;

            // Buffer raw content for history (thinking blocks stripped at save time)
            const buf = assistantBuffers.get(sessionKey) || '';
            assistantBuffers.set(sessionKey, buf + delta);

            if (hasClients) {
                console.log(`[ws-proxy] -> Browsers for session: chunk (${delta.length} chars)`);

                let state = sessionParsingState.get(sessionKey);
                if (!state) {
                    state = { isThinking: false, buffer: '' };
                    sessionParsingState.set(sessionKey, state);
                }
                state.buffer += delta;

                while (state.buffer.length > 0) {
                    if (!state.isThinking) {
                        const matchStart = state.buffer.match(/<(?:think|thinking)[^>]*>/i);
                        if (matchStart) {
                            const before = state.buffer.substring(0, matchStart.index);
                            if (before) broadcastToSession(sessionKey, { type: 'chunk', content: before });
                            state.isThinking = true;
                            state.buffer = state.buffer.substring(matchStart.index + matchStart[0].length);
                            continue;
                        }
                        const partialMatch = state.buffer.match(/<[^>]*$/);
                        if (partialMatch) {
                            const before = state.buffer.substring(0, partialMatch.index);
                            if (before) broadcastToSession(sessionKey, { type: 'chunk', content: before });
                            state.buffer = state.buffer.substring(partialMatch.index);
                            break;
                        }
                        broadcastToSession(sessionKey, { type: 'chunk', content: state.buffer });
                        state.buffer = '';
                    } else {
                        const matchEnd = state.buffer.match(/<\/(?:think|thinking)>/i);
                        if (matchEnd) {
                            const before = state.buffer.substring(0, matchEnd.index);
                            if (before) broadcastToSession(sessionKey, { type: 'thinking', content: before });
                            state.isThinking = false;
                            state.buffer = state.buffer.substring(matchEnd.index + matchEnd[0].length);
                            continue;
                        }
                        const partialMatch = state.buffer.match(/<[^>]*$/);
                        if (partialMatch) {
                            const before = state.buffer.substring(0, partialMatch.index);
                            if (before) broadcastToSession(sessionKey, { type: 'thinking', content: before });
                            state.buffer = state.buffer.substring(partialMatch.index);
                            break;
                        }
                        broadcastToSession(sessionKey, { type: 'thinking', content: state.buffer });
                        state.buffer = '';
                    }
                }
            }
        }

        // Also capture non-streaming assistant content (just in case)
        if (payload.message?.role === 'assistant' && payload.message?.content) {
            const content = typeof payload.message.content === 'string'
                ? payload.message.content
                : JSON.stringify(payload.message.content);
            const buf = assistantBuffers.get(sessionKey) || '';
            assistantBuffers.set(sessionKey, buf + content);
            if (hasClients) {
                broadcastToSession(sessionKey, { type: 'chunk', content });
            }
        }

        // Forward lifecycle events (processing start/end)
        if (hasClients && payload.stream === 'lifecycle') {
            if (payload.data?.phase === 'start') {
                broadcastToSession(sessionKey, { type: 'status', content: 'Processing…' });
            }
            // 'end' phase is handled by the chat 'final' event
        }

        // Forward status updates (e.g. "Searching the web…", "Analyzing…")
        if (hasClients && payload.stream === 'status') {
            const statusText = payload.data?.delta || payload.data?.status || payload.data?.message || '';
            if (statusText) {
                broadcastToSession(sessionKey, { type: 'status', content: statusText });
            }
        }

        // Forward thinking/reasoning stream
        if (hasClients && payload.stream === 'thinking') {
            const thinkingText = payload.data?.delta || '';
            if (thinkingText) {
                broadcastToSession(sessionKey, { type: 'thinking', content: thinkingText });
            }
        }

        // Forward tool invocations
        if (hasClients && payload.stream === 'tool') {
            broadcastToSession(sessionKey, { type: 'tool', data: payload.data });
        }

        // Log any other streams we haven't handled for discovery
        if (hasClients && payload.stream && !['assistant', 'lifecycle', 'status', 'thinking', 'tool'].includes(payload.stream)) {
            if (process.env.DEBUG === 'true') {
                console.log(`[ws-proxy] Unhandled agent stream '${payload.stream}':`, JSON.stringify(payload.data));
            }
        }

        return;
    }

    // Handle chat events (status updates / final)
    if (msg.type === 'event' && msg.event === 'chat') {
        const payload = msg.payload || {};
        const rawSessionKey = payload.sessionKey;
        const sessionKey = resolveSessionKey(rawSessionKey);
        const browserWsSet = sessionToBrowser.get(sessionKey);
        const hasClients = browserWsSet && browserWsSet.size > 0;

        console.log(`[ws-proxy] Chat event: state=${payload.state}, rawKey=${rawSessionKey}, resolvedKey=${sessionKey}, clientsFound=${hasClients}`);

        if (!hasClients) {
            return;
        }

        // Forward non-final state changes as status updates (ignore delta)
        if (payload.state && payload.state !== 'final' && payload.state !== 'delta') {
            broadcastToSession(sessionKey, { type: 'status', content: payload.state });
        }

        // Final state: flush content and persist history
        if (payload.state === 'final') {
            // Only send final message content if nothing was already streamed
            // Ignore messages that are echoing the "user" role's prompt
            if (payload.message && payload.message.role !== 'assistant') {
                return;
            }

            const existingBuf = assistantBuffers.get(sessionKey) || '';
            if (!existingBuf && payload.message?.content) {
                const content = typeof payload.message.content === 'string'
                    ? payload.message.content
                    : JSON.stringify(payload.message.content);
                broadcastToSession(sessionKey, { type: 'chunk', content });
                assistantBuffers.set(sessionKey, content);
            }

            // Parse [PENDING_ACTION] blocks from the complete response
            const pendingActionRe = /\[PENDING_ACTION\s+id="([^"]+)"\s+tool="([^"]+)"\s+eventId="([^"]+)"\s+args='([\s\S]*?)'\]/g;
            const fullBuf = assistantBuffers.get(sessionKey) || '';
            let hasPendingActions = false;
            let pendingMatch;
            while ((pendingMatch = pendingActionRe.exec(fullBuf)) !== null) {
                const [fullMatch, actionId, tool, eventId, argsStr] = pendingMatch;
                let args;
                try {
                    args = JSON.parse(argsStr);
                } catch (e) {
                    broadcastToSession(sessionKey, { type: 'action_error', error: `Invalid args JSON in [PENDING_ACTION]: ${e.message}` });
                    continue;
                }
                let pending = sessionPendingActions.get(sessionKey);
                if (!pending) {
                    pending = {};
                    sessionPendingActions.set(sessionKey, pending);
                }
                if (pending[actionId]) {
                    console.warn(`[ws-proxy] Duplicate actionId ${actionId} - overwriting`);
                }
                pending[actionId] = { tool, eventId, args, timestamp: Date.now() };
                const preview = formatActionPreview(tool, args);
                broadcastToSession(sessionKey, {
                    type: 'pending_action',
                    actionId,
                    tool,
                    eventId,
                    preview
                });
                hasPendingActions = true;
                console.log(`[ws-proxy] Parsed [PENDING_ACTION] id=${actionId} tool=${tool} eventId=${eventId}`);
            }

            broadcastToSession(sessionKey, { type: 'final' });

            // Persist the complete assistant response to history
            const userId = findUserIdForSession(sessionKey);
            const fullResponse = assistantBuffers.get(sessionKey);
            if (userId && fullResponse) {
                appendToHistory(userId, {
                    role: 'assistant',
                    content: fullResponse,
                    timestamp: Date.now(),
                });
            }
            assistantBuffers.delete(sessionKey);

            // Clean up the pending request for this session
            for (const [id, req] of pendingRequests) {
                if (req.sessionKey === sessionKey) {
                    pendingRequests.delete(id);
                    break;
                }
            }
            sessionParsingState.delete(sessionKey);
        }
    }

    // Log unhandled event types for discovery
    if (msg.type === 'event' && !['agent', 'chat', 'connect.challenge'].includes(msg.event)) {
        if (process.env.DEBUG === 'true') {
            console.log(`[ws-proxy] Unhandled event type '${msg.event}':`, JSON.stringify(msg.payload));
        }
    }
}

function sendToOpenClaw(browserWs, sessionKey, message, entityType, entityName) {
    if (!isConnected || !openclawWs) {
        sendToBrowser(browserWs, { type: 'error', message: 'Not connected to agent' });
        return;
    }

    const id = getNextId();
    const session = browserSessions.get(browserWs);
    const sessionCtx = session?.sessionCtx ?? null;
    const eventIdForCtx = session?.eventId ?? null;

    let baseMessage = entityType && entityName
        ? `Generate an intelligence report for ${entityType} "${entityName}". User request: ${message}`
        : message;

    // Append ActionCtx for OpenClaw to access webapp DB
    let fullMessage = baseMessage;
    if (sessionCtx && sessionCtx.actionToken) {
        // Check if token needs refresh (within 30 minutes of expiry)
        const expiresAt = sessionCtx.expiresAt ? new Date(sessionCtx.expiresAt).getTime() : 0;
        const thirtyMinutes = 30 * 60 * 1000;
        if (expiresAt && Date.now() > expiresAt - thirtyMinutes) {
            console.log(`[ws-proxy] Action token expiring soon for session ${sessionKey}, refresh needed on next opportunity`);
            // Note: async refresh not done inline; will be handled on next connection
        }
        fullMessage += `\n\n[ActionCtx appUrl="${sessionCtx.appUrl}" token="${sessionCtx.actionToken}" eventId="${eventIdForCtx ?? ''}" eventSlug="${sessionCtx.eventSlug ?? ''}" role="${sessionCtx.role}"]`;
    }

    const payload = {
        type: 'req',
        id,
        method: 'chat.send',
        params: {
            sessionKey,
            idempotencyKey: `idem-${Date.now()}-${id}`,
            message: fullMessage,
        },
    };

    pendingRequests.set(id, { browserWs, sessionKey });
    console.log('[ws-proxy] -> OpenClaw:', JSON.stringify(payload));
    openclawWs.send(JSON.stringify(payload));
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser WebSocket Server
// ─────────────────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ port: PROXY_PORT });

wss.on('error', (err) => {
    console.error('[ws-proxy] WebSocket Server error:', err.message);
});

wss.on('connection', async (ws, req) => {
    console.log(`[ws-proxy] Incoming connection attempt from ${req.socket.remoteAddress}`);
    // 1. Authenticate the connection
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
        console.error('[ws-proxy] Connection rejected: Missing token');
        ws.close(1008, 'Missing authentication token');
        return;
    }

    let userId = null;
    let authErrors = [];

    const secretKeysString = process.env.WS_PROXY_CLERK_SECRET_KEYS || process.env.CLERK_SECRET_KEY || '';
    const secretKeys = secretKeysString.split(',').map(k => k.trim()).filter(Boolean);

    if (secretKeys.length === 0) {
        console.error('[ws-proxy] Connection rejected: No Clerk secret keys configured');
        ws.close(1011, 'Server configuration error');
        return;
    }

    for (const secretKey of secretKeys) {
        try {
            const verifyResult = await verifyToken(token, { secretKey });
            userId = verifyResult.sub;
            console.log(`[ws-proxy] User authenticated: ${userId}`);
            break;
        } catch (err) {
            authErrors.push(err.message);
        }
    }

    if (!userId) {
        console.error('[ws-proxy] Connection rejected: Invalid token. Errors:', authErrors.join(' | '));
        ws.close(1008, 'Invalid authentication token');
        return;
    }

    // Exchange Clerk token for action token (for OpenClaw DB access)
    const eventId = url.searchParams.get('eventId');
    let sessionCtx = null;
    const webappUrl = process.env.WEBAPP_URL;
    const cronSecretKey = process.env.CRON_SECRET_KEY;
    if (webappUrl && cronSecretKey) {
        try {
            const sessionRes = await fetch(`${webappUrl}/api/intelligence/session`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${cronSecretKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ clerkToken: token, eventId: eventId ?? undefined })
            });
            if (sessionRes.ok) {
                const data = await sessionRes.json();
                sessionCtx = {
                    actionToken: data.actionToken,
                    role: data.role,
                    appUrl: webappUrl,
                    eventSlug: data.eventSlug ?? null,
                    expiresAt: data.expiresAt
                };
                console.log(`[ws-proxy] Action token obtained for user ${userId}, role: ${data.role}`);
            } else {
                console.warn(`[ws-proxy] Session init failed: ${sessionRes.status}`);
            }
        } catch (err) {
            console.warn('[ws-proxy] Session init error:', err.message);
        }
    }

    // Use a deterministic, user-scoped session key so the same user
    // always resumes the same OpenClaw conversation thread.
    const sessionKey = `user-${userId.toLowerCase()}`;
    console.log(`[ws-proxy] Browser connected, user: ${userId}, sessionKey: ${sessionKey}`);

    browserSessions.set(ws, { sessionKey, userId, sessionCtx, token, eventId: eventId ?? null });

    let wsSet = sessionToBrowser.get(sessionKey);
    if (!wsSet) {
        wsSet = new Set();
        sessionToBrowser.set(sessionKey, wsSet);
    }
    wsSet.add(ws);

    // Send connection confirmation
    sendToBrowser(ws, { type: 'connected', sessionKey, userId });

    // Send chat history if it exists
    sendHistory(ws, userId);

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            handleBrowserMessage(ws, msg).catch(e => {
                console.error('[ws-proxy] handleBrowserMessage error:', e);
                sendToBrowser(ws, { type: 'error', message: 'Internal error processing message' });
            });
        } catch (e) {
            console.error('[ws-proxy] Failed to parse browser message:', e);
            sendToBrowser(ws, { type: 'error', message: 'Invalid JSON' });
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[ws-proxy] Browser disconnected: ${sessionKey} Code: ${code} Reason: ${reason}`);
        const wsSet = sessionToBrowser.get(sessionKey);
        if (wsSet) {
            wsSet.delete(ws);
            if (wsSet.size === 0) {
                sessionToBrowser.delete(sessionKey);
            }
        }
        browserSessions.delete(ws);
    });

    ws.on('error', (err) => {
        console.error(`[ws-proxy] Browser error (${sessionKey}):`, err.message);
    });
});

async function handleBrowserMessage(ws, msg) {
    console.log('[ws-proxy] Browser:', JSON.stringify(msg));

    const session = browserSessions.get(ws);
    if (!session) {
        sendToBrowser(ws, { type: 'error', message: 'Session not found' });
        return;
    }

    // Clean up expired pending actions (>10 min)
    const sessionPending = sessionPendingActions.get(session.sessionKey);
    if (sessionPending) {
        for (const [id, action] of Object.entries(sessionPending)) {
            if (Date.now() - action.timestamp > 10 * 60 * 1000) {
                delete sessionPending[id];
                console.log(`[ws-proxy] Auto-expired pending action ${id}`);
            }
        }
    }

    if (msg.type === 'new-session') {
        // Archive existing history and create a fresh empty one
        archiveAndResetHistory(session.userId);

        // Send /new to OpenClaw to start a fresh conversation thread
        sendToOpenClaw(ws, session.sessionKey, '/new');

        // Notify all browser windows for this user to clear their UI
        const wsSet = sessionToBrowser.get(session.sessionKey);
        if (wsSet) {
            for (const browserWs of wsSet) {
                sendToBrowser(browserWs, { type: 'session-cleared' });
            }
        }
        console.log(`[ws-proxy] New session started for user ${session.userId}`);
    } else if (msg.type === 'message') {
        // Persist user message to history
        appendToHistory(session.userId, {
            role: 'user',
            content: msg.content,
            timestamp: Date.now(),
        });

        // Broadcast the user's message to any *other* browser windows for this user
        const wsSet = sessionToBrowser.get(session.sessionKey);
        if (wsSet) {
            let broadcastCount = 0;
            for (const otherWs of wsSet) {
                if (otherWs !== ws) {
                    sendToBrowser(otherWs, { type: 'user-message', content: msg.content });
                    broadcastCount++;
                }
            }
            console.log(`[ws-proxy] Broadcasted user-message to ${broadcastCount} other browser(s)`);
        }

        sendToOpenClaw(ws, session.sessionKey, msg.content, msg.entityType, msg.entityName);
    } else if (msg.type === 'confirm_action') {
        const pending = sessionPendingActions.get(session.sessionKey);
        const action = pending?.[msg.actionId];
        if (!action) {
            sendToBrowser(ws, { type: 'action_result', actionId: msg.actionId, success: false, error: 'Unknown or expired action ID' });
            return;
        }
        // Expire check (10 minutes)
        if (Date.now() - action.timestamp > 10 * 60 * 1000) {
            delete pending[msg.actionId];
            sendToBrowser(ws, { type: 'action_result', actionId: msg.actionId, success: false, data: { error: 'Action expired (>10 minutes)' } });
            return;
        }
        delete pending[msg.actionId];
        const token = await getValidToken(session);
        if (!token) {
            sendToBrowser(ws, { type: 'action_result', actionId: msg.actionId, success: false, data: { error: 'No valid auth token' } });
            return;
        }
        console.log(`[ws-proxy] Executing confirmed action ${msg.actionId}: ${action.tool}`);
        const result = await callEventPlannerAction(token, action);
        sendToBrowser(ws, { type: 'action_result', actionId: msg.actionId, success: result.ok, data: result.data });

        // Broadcast a chat message summarising the outcome
        const preview = formatActionPreview(action.tool, action.args);
        let chatMsg;
        if (result.ok) {
            chatMsg = `✓ Action completed: **${preview}**`;
        } else {
            const errMsg = result.data?.error || 'Unknown error';
            chatMsg = `✗ Action failed: **${preview}**\n\nError: ${errMsg}`;
        }
        broadcastToSession(session.sessionKey, { type: 'chunk', content: chatMsg });
        broadcastToSession(session.sessionKey, { type: 'final' });
        appendToHistory(session.userId, { role: 'assistant', content: chatMsg, timestamp: Date.now() });
    } else if (msg.type === 'reject_action') {
        const pending = sessionPendingActions.get(session.sessionKey);
        const rejectedAction = pending?.[msg.actionId];
        if (pending) delete pending[msg.actionId];
        sendToBrowser(ws, { type: 'action_result', actionId: msg.actionId, success: false, rejected: true });
        console.log(`[ws-proxy] Action ${msg.actionId} rejected by user`);

        // Broadcast a chat message for the rejection
        const rejectPreview = rejectedAction ? formatActionPreview(rejectedAction.tool, rejectedAction.args) : msg.actionId;
        const rejectMsg = `✗ Action rejected: **${rejectPreview}**`;
        broadcastToSession(session.sessionKey, { type: 'chunk', content: rejectMsg });
        broadcastToSession(session.sessionKey, { type: 'final' });
        appendToHistory(session.userId, { role: 'assistant', content: rejectMsg, timestamp: Date.now() });
    } else {
        sendToBrowser(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
}

function sendToBrowser(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}

function broadcastToSession(sessionKey, msg) {
    const wsSet = sessionToBrowser.get(sessionKey);
    if (wsSet) {
        for (const ws of wsSet) {
            sendToBrowser(ws, msg);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

connectToOpenClaw();

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('[ws-proxy] Shutting down...');
    wss.close();
    if (openclawWs) openclawWs.close();
    process.exit(0);
});
