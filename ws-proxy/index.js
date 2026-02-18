/**
 * WebSocket Proxy for OpenClaw Sales-Recon
 * 
 * - Connects to sales-recon with the gateway token
 * - Exposes a public WebSocket for browser clients
 * - Routes messages between browsers and OpenClaw
 */

import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { createClerkClient, verifyToken } from '@clerk/backend';
import crypto from 'node:crypto';

// Device Auth Helpers
import {
    loadOrCreateDeviceIdentity,
    buildDeviceAuthPayload,
    signDevicePayload
} from './device.js';

// Initialize Device Identity
const DATA_DIR = process.env.DATA_DIR || './data';
const deviceIdentity = loadOrCreateDeviceIdentity(DATA_DIR);

const clerkClient = createClerkClient({
    secretKey: process.env.CLERK_SECRET_KEY,
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY
});

const OPENCLAW_URL = process.env.OPENCLAW_URL || 'ws://sales-recon:50045';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN;
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8080', 10);

if (!OPENCLAW_TOKEN) {
    console.error('[ws-proxy] OPENCLAW_TOKEN is required');
    process.exit(1);
}

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
// Maps sessionKey -> browser WebSocket
const sessionToBrowser = new Map();
// Maps request ID -> { browserWs, sessionKey }
const pendingRequests = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// OpenClaw Connection
// ─────────────────────────────────────────────────────────────────────────────

function connectToOpenClaw() {
    // Append token to URL for initial connection if supported, or rely on connect frame
    const url = `${OPENCLAW_URL}?token=${OPENCLAW_TOKEN}`;
    console.log(`[ws-proxy] Connecting to OpenClaw: ${OPENCLAW_URL}`);

    openclawWs = new WebSocket(url);

    openclawWs.on('open', () => {
        console.log('[ws-proxy] Connected to OpenClaw');
        reconnectDelay = 1000; // Reset backoff
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

function getNextId() {
    return `proxy-${++requestId}`;
}

function handleOpenClawMessage(msg) {
    console.log('[ws-proxy] OpenClaw:', JSON.stringify(msg));

    // Handle connect challenge
    if (msg.event === 'connect.challenge') {
        const nonce = msg.payload?.nonce;
        if (!nonce) {
            console.error('[ws-proxy] Received connect.challenge without nonce');
            return;
        }

        const clientId = 'cli'; // Or 'ws-proxy'
        const clientMode = 'cli'; // Or 'gateway-proxy'
        const role = 'operator';
        const scopes = ['operator.read', 'operator.write'];
        const ts = Date.now();

        // 1. Build Payload
        const payloadParams = {
            version: 'v2',
            deviceId: deviceIdentity.deviceId,
            clientId: clientId,
            clientMode: clientMode,
            role: role,
            scopes: scopes,
            signedAtMs: ts,
            token: process.env.OPENCLAW_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || undefined,
            nonce: nonce,
        };

        const payload = buildDeviceAuthPayload(payloadParams);

        // 2. Sign Payload
        const signature = signDevicePayload(deviceIdentity.privateKeyPem, payload);

        // 3. Send Response
        const response = {
            type: 'req',
            id: getNextId(),
            method: 'connect',
            params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: {
                    id: clientId,
                    version: '1.0.0',
                    platform: 'linux',
                    mode: clientMode,
                },
                role: role,
                scopes: scopes,
                device: {
                    id: deviceIdentity.deviceId,
                    publicKey: deviceIdentity.publicKeyPem, // Logic inside gateway will normalize this
                    signature: signature,
                    signedAt: ts,
                    nonce: nonce
                },
                auth: { token: payloadParams.token },
            },
        };
        console.log(`[ws-proxy] Sending device-authenticated handshake for ${deviceIdentity.deviceId}`);
        openclawWs.send(JSON.stringify(response));
        return;
    }


    // Handle connect response
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

    // Handle agent events (streaming delta)
    if (msg.type === 'event' && msg.event === 'agent') {
        const payload = msg.payload || {};
        let sessionKey = payload.sessionKey;

        // Fix for session key mismatch (agent:main: prefix)
        // Format is typically agent:agentId:sessionKey
        if (sessionKey && sessionKey.includes(':')) {
            const parts = sessionKey.split(':');
            sessionKey = parts[parts.length - 1]; // Take the last part which is the browser-... UUID
        }

        const browserWs = sessionToBrowser.get(sessionKey);

        // Capture assistant content from stream
        if (browserWs && payload.stream === 'assistant' && payload.data?.delta) {
            sendToBrowser(browserWs, { type: 'chunk', content: payload.data.delta });
        }

        // Also capture non-streaming assistant content (just in case)
        if (browserWs && payload.message?.role === 'assistant' && payload.message?.content) {
            sendToBrowser(browserWs, { type: 'chunk', content: payload.message.content });
        }
        return;
    }

    // Handle chat events (status updates / final)
    if (msg.type === 'event' && msg.event === 'chat') {
        const payload = msg.payload || {};
        const sessionKey = payload.sessionKey;
        const browserWs = sessionToBrowser.get(sessionKey);

        if (!browserWs) {
            return;
        }

        // We use 'agent' event for chunks, 'chat' event with state='final' signals completion
        if (payload.state === 'final') {
            // Check if there's any final content in this message to flush
            if (payload.message?.content) {
                sendToBrowser(browserWs, { type: 'chunk', content: payload.message.content });
            }

            sendToBrowser(browserWs, { type: 'final' });

            // Clean up the pending request for this session
            for (const [id, req] of pendingRequests) {
                if (req.sessionKey === sessionKey) {
                    pendingRequests.delete(id);
                    break;
                }
            }
        }
    }
}

function sendToOpenClaw(browserWs, sessionKey, message, entityType, entityName) {
    if (!isConnected || !openclawWs) {
        sendToBrowser(browserWs, { type: 'error', message: 'Not connected to agent' });
        return;
    }

    const id = getNextId();
    const fullMessage = entityType && entityName
        ? `Generate an intelligence report for ${entityType} "${entityName}". User request: ${message}`
        : message;

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

wss.on('listening', () => {
    console.log(`[ws-proxy] Listening for browser clients on port ${PROXY_PORT}`);
});

wss.on('connection', async (ws, req) => {
    // 1. Authenticate the connection
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
        console.error('[ws-proxy] Connection rejected: Missing token');
        ws.close(1008, 'Missing authentication token');
        return;
    }

    let userId = null;
    try {
        const verifyResult = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
        userId = verifyResult.sub;
        console.log(`[ws-proxy] User authenticated: ${userId}`);
    } catch (err) {
        console.error('[ws-proxy] Connection rejected: Invalid token', err.message);
        ws.close(1008, 'Invalid authentication token');
        return;
    }

    const sessionKey = `browser-${uuidv4()}`;
    console.log(`[ws-proxy] Browser connected, sessionKey: ${sessionKey}`);
    // console.log(`[ws-proxy] Headers:`, JSON.stringify(req.headers, null, 2));

    browserSessions.set(ws, { sessionKey, userId });
    sessionToBrowser.set(sessionKey, ws);

    // Send connection confirmation
    sendToBrowser(ws, { type: 'connected', sessionKey, userId });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            handleBrowserMessage(ws, msg);
        } catch (e) {
            console.error('[ws-proxy] Failed to parse browser message:', e);
            sendToBrowser(ws, { type: 'error', message: 'Invalid JSON' });
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[ws-proxy] Browser disconnected: ${sessionKey} Code: ${code} Reason: ${reason}`);
        browserSessions.delete(ws);
        sessionToBrowser.delete(sessionKey);
    });

    ws.on('error', (err) => {
        console.error(`[ws-proxy] Browser error (${sessionKey}):`, err.message);
    });
});

function handleBrowserMessage(ws, msg) {
    console.log('[ws-proxy] Browser:', JSON.stringify(msg));

    const session = browserSessions.get(ws);
    if (!session) {
        sendToBrowser(ws, { type: 'error', message: 'Session not found' });
        return;
    }

    if (msg.type === 'message') {
        sendToOpenClaw(ws, session.sessionKey, msg.content, msg.entityType, msg.entityName);
    } else {
        sendToBrowser(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
    }
}

function sendToBrowser(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
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
