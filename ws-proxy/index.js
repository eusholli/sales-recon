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
import { loadOrCreateDeviceIdentity, buildDeviceAuthPayload, signDevicePayload, publicKeyToBase64Url } from './device.js';

const clerkClient = createClerkClient({
    secretKey: process.env.CLERK_SECRET_KEY,
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY
});

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
// Maps sessionKey -> browser WebSocket
const sessionToBrowser = new Map();
// Maps request ID -> { browserWs, sessionKey }
const pendingRequests = new Map();

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

        // Build and sign the device auth payload (v2 format)
        const authPayload = buildDeviceAuthPayload({
            deviceId: deviceIdentity.deviceId,
            clientId,
            clientMode,
            role,
            scopes,
            signedAtMs: signedAt,
            token: OPENCLAW_TOKEN,
            nonce,
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
                    platform: 'linux',
                    mode: clientMode,
                },
                role,
                scopes,
                caps: [],
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
