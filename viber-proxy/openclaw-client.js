/**
 * OpenClaw WebSocket client for viber-proxy.
 *
 * Mirrors the connection/handshake/streaming logic in
 * sales-recon/ws-proxy/index.js, but exposes a callback-per-session API
 * suited to the request/response shape of Viber webhooks (one Viber message
 * in → one buffered response out).
 *
 * Each call to sendMessage() registers handlers that fire as agent deltas
 * arrive and once the chat reaches `state: 'final'`. The final handler gets
 * the full assistant text (stripped of <think> blocks and the
 * STRUCTURED_REPORT fence) plus the parsed structured report when present.
 */

import WebSocket from 'ws';
import {
    buildDeviceAuthPayloadV3,
    signDevicePayload,
    publicKeyToBase64Url,
} from './device.js';

const STRUCTURED_REPORT_REGEX = /```json\s+STRUCTURED_REPORT\s*([\s\S]*?)```/i;

function stripThinkingBlocks(content) {
    return content.replace(/<(?:think|thinking)[^>]*>[\s\S]*?<\/(?:think|thinking)>/gi, '').trim();
}

function stripStructuredFence(content) {
    return content.replace(STRUCTURED_REPORT_REGEX, '').trim();
}

function extractStructuredReport(content) {
    if (!content) return null;
    const match = content.match(STRUCTURED_REPORT_REGEX);
    if (!match) return null;
    try {
        const parsed = JSON.parse(match[1]);
        if (!parsed || typeof parsed !== 'object') return null;
        const required = ['type', 'name', 'summary', 'salesAngle', 'fullReport'];
        for (const f of required) {
            if (typeof parsed[f] !== 'string' || parsed[f].length === 0) return null;
        }
        if (!['company', 'attendee', 'event'].includes(parsed.type)) return null;
        return parsed;
    } catch {
        return null;
    }
}

function resolveSessionKey(rawKey) {
    if (rawKey && rawKey.includes(':')) {
        const parts = rawKey.split(':');
        return parts[parts.length - 1];
    }
    return rawKey;
}

export class OpenClawClient {
    /**
     * @param {object} opts
     * @param {string} opts.url               OpenClaw WS URL
     * @param {string} opts.token             OpenClaw gateway token
     * @param {object} opts.deviceIdentity    { deviceId, publicKeyPem, privateKeyPem }
     * @param {string} [opts.displayName]
     */
    constructor({ url, token, deviceIdentity, displayName = 'Sales-Recon-Viber-Proxy' }) {
        this.url = url;
        this.token = token;
        this.deviceIdentity = deviceIdentity;
        this.displayName = displayName;
        this.ws = null;
        this.isConnected = false;
        this.reconnectDelay = 1000;
        this.MAX_RECONNECT_DELAY = 30000;
        this.requestId = 0;
        // sessionKey -> { onDelta(delta), onFinal({ text, report }), buffer }
        this.sessionHandlers = new Map();
        // request id -> sessionKey (so we can clean up handlers if the server
        // returns an error rather than streaming)
        this.pendingRequests = new Map();
        // sessionKey -> sessionId returned by the server (for thread continuity)
        this.sessionIds = new Map();
        // request id -> { sessionKey, onHistory }
        this.historyRequests = new Map();
    }

    connect() {
        const url = `${this.url}?token=${this.token}`;
        console.log(`[openclaw-client] Connecting: ${this.url}`);
        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
            console.log('[openclaw-client] Connected to OpenClaw');
            this.reconnectDelay = 1000;
        });

        this.ws.on('message', (data) => {
            try {
                this._handleMessage(JSON.parse(data.toString()));
            } catch (e) {
                console.error('[openclaw-client] Failed to parse:', e);
            }
        });

        this.ws.on('close', (code, reason) => {
            console.log(`[openclaw-client] Closed: ${code} ${reason}`);
            this.isConnected = false;
            this._scheduleReconnect();
        });

        this.ws.on('error', (err) => {
            console.error('[openclaw-client] Error:', err.message);
        });
    }

    _scheduleReconnect() {
        console.log(`[openclaw-client] Reconnect in ${this.reconnectDelay}ms`);
        setTimeout(() => {
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.MAX_RECONNECT_DELAY);
            this.connect();
        }, this.reconnectDelay);
    }

    _nextId() {
        return `viber-${++this.requestId}`;
    }

    _handleMessage(msg) {
        if (process.env.DEBUG === 'true') {
            console.log('[openclaw-client] <-', JSON.stringify(msg));
        }

        // Connect challenge → respond with device-signed auth
        if (msg.event === 'connect.challenge') {
            this._sendHandshake(msg.payload?.nonce);
            return;
        }

        if (msg.type === 'res' && msg.ok && !this.isConnected) {
            this.isConnected = true;
            console.log('[openclaw-client] Handshake complete');
            return;
        }

        if (msg.type === 'res' && typeof msg.id === 'string' && this.historyRequests.has(msg.id)) {
            const { sessionKey, onHistory } = this.historyRequests.get(msg.id);
            this.historyRequests.delete(msg.id);
            if (msg.payload?.sessionId) {
                this.sessionIds.set(sessionKey, msg.payload.sessionId);
            }
            if (msg.ok) {
                const SILENT_REPLY = /^\s*NO_REPLY\s*$/;
                const rawMessages = Array.isArray(msg.payload?.messages) ? msg.payload.messages : [];
                const clean = rawMessages
                    .filter(m => m.role === 'user' || m.role === 'assistant')
                    .map(m => {
                        let content = typeof m.content === 'string' ? m.content
                            : Array.isArray(m.content)
                                ? m.content.filter(p => p?.type === 'text').map(p => p.text).join('\n')
                                : (m.text || '');
                        if (m.role === 'assistant') {
                            content = stripStructuredFence(stripThinkingBlocks(content));
                        }
                        return { role: m.role, content };
                    })
                    .filter(m => {
                        if (!m.content || SILENT_REPLY.test(m.content)) return false;
                        const t = m.content.trim();
                        if (t.startsWith('{') || t.startsWith('[')) return false;
                        if (m.content.length < 20) return false;
                        return true;
                    });
                onHistory(clean);
            }
            return;
        }

        if (msg.type === 'res' && typeof msg.id === 'string') {
            const sessionKey = this.pendingRequests.get(msg.id);
            if (sessionKey && !msg.ok) {
                const handler = this.sessionHandlers.get(sessionKey);
                if (handler && handler.onFinal) {
                    const errMsg = msg.error?.message || 'Unknown error';
                    handler.onFinal({ text: `Error: ${errMsg}`, report: null });
                }
                this.sessionHandlers.delete(sessionKey);
                this.pendingRequests.delete(msg.id);
            } else if (sessionKey && msg.ok) {
                // Store sessionId for thread continuity on subsequent sends
                if (msg.payload?.sessionId) {
                    this.sessionIds.set(sessionKey, msg.payload.sessionId);
                }
            }
            return;
        }

        if (msg.type === 'event' && msg.event === 'agent') {
            const payload = msg.payload || {};
            const sessionKey = resolveSessionKey(payload.sessionKey);
            const handler = this.sessionHandlers.get(sessionKey);
            if (!handler) return;

            if (payload.stream === 'assistant' && payload.data?.delta) {
                handler.buffer += payload.data.delta;
                if (handler.onDelta) handler.onDelta(payload.data.delta);
            }
            return;
        }

        if (msg.type === 'event' && msg.event === 'chat') {
            const payload = msg.payload || {};
            const sessionKey = resolveSessionKey(payload.sessionKey);
            const handler = this.sessionHandlers.get(sessionKey);
            if (!handler) return;

            if (payload.state === 'final') {
                if (payload.message?.role === 'assistant' && payload.message?.content) {
                    const finalText = typeof payload.message.content === 'string'
                        ? payload.message.content
                        : Array.isArray(payload.message.content)
                            ? payload.message.content.filter(p => p?.type === 'text').map(p => p.text).join('\n')
                            : JSON.stringify(payload.message.content);
                    if (finalText) handler.buffer = finalText;
                }
                if (!handler.buffer) {
                    handler.buffer = "I wasn't able to generate a response. Please try again.";
                }

                const rawBuf = handler.buffer;
                const report = extractStructuredReport(rawBuf);
                const cleaned = stripStructuredFence(stripThinkingBlocks(rawBuf));

                if (handler.onFinal) handler.onFinal({ text: cleaned, report });

                this.sessionHandlers.delete(sessionKey);
                for (const [id, k] of this.pendingRequests) {
                    if (k === sessionKey) this.pendingRequests.delete(id);
                }
            }
        }
    }

    _sendHandshake(nonce) {
        const signedAt = Date.now();
        const role = 'operator';
        const scopes = ['operator.read', 'operator.write'];
        const clientId = 'gateway-client';
        const clientMode = 'backend';
        const platform = 'linux';
        const deviceFamily = 'server';

        const authPayload = buildDeviceAuthPayloadV3({
            deviceId: this.deviceIdentity.deviceId,
            clientId,
            clientMode,
            role,
            scopes,
            signedAtMs: signedAt,
            token: this.token,
            nonce,
            platform,
            deviceFamily,
        });
        const signature = signDevicePayload(this.deviceIdentity.privateKeyPem, authPayload);

        const response = {
            type: 'req',
            id: this._nextId(),
            method: 'connect',
            params: {
                minProtocol: 4,
                maxProtocol: 4,
                client: {
                    id: clientId,
                    displayName: this.displayName,
                    version: '1.0.0',
                    platform,
                    deviceFamily,
                    mode: clientMode,
                },
                role,
                scopes,
                caps: ['tool-events'],
                auth: { token: this.token },
                device: {
                    id: this.deviceIdentity.deviceId,
                    publicKey: publicKeyToBase64Url(this.deviceIdentity.publicKeyPem),
                    signature,
                    signedAt,
                    nonce,
                },
                locale: 'en-US',
                userAgent: 'sales-recon-viber-proxy/1.0.0',
            },
        };
        console.log('[openclaw-client] Sending handshake');
        this.ws.send(JSON.stringify(response));
    }

    /**
     * Send a chat message to OpenClaw and register handlers for the response.
     *
     * @param {object} args
     * @param {string} args.sessionKey
     * @param {string} args.message              raw user message text
     * @param {string} [args.entityType]
     * @param {string} [args.entityName]
     * @param {function(string):void} [args.onDelta]
     * @param {function({text:string, report:object|null}):void} args.onFinal
     */
    sendMessage({ sessionKey, message, entityType, entityName, onDelta, onFinal }) {
        if (!this.isConnected || !this.ws) {
            if (onFinal) onFinal({ text: 'Not connected to agent. Please try again.', report: null });
            return;
        }

        const baseMessage = entityType && entityName
            ? `Generate an intelligence report for ${entityType} "${entityName}". User request: ${message}`
            : message;

        const id = this._nextId();
        this.sessionHandlers.set(sessionKey, { onDelta, onFinal, buffer: '' });
        this.pendingRequests.set(id, sessionKey);

        const sessionId = this.sessionIds.get(sessionKey);
        const payload = {
            type: 'req',
            id,
            method: 'chat.send',
            params: {
                sessionKey,
                ...(sessionId ? { sessionId } : {}),
                idempotencyKey: `idem-${Date.now()}-${id}`,
                message: baseMessage,
            },
        };
        if (process.env.DEBUG === 'true') {
            console.log('[openclaw-client] ->', JSON.stringify(payload));
        }
        this.ws.send(JSON.stringify(payload));
    }

    /**
     * Reset the session for the given sessionKey by sending /new to OpenClaw
     * and clearing the stored sessionId so the next send starts a fresh thread.
     */
    resetSession(sessionKey) {
        this.sessionIds.delete(sessionKey);
        this.sendMessage({
            sessionKey,
            message: '/new',
            onFinal: () => { /* caller sends the confirmation message directly */ },
        });
    }

    /**
     * Fetch conversation history for the given sessionKey.
     * @param {string} sessionKey
     * @param {function(Array<{role:string, content:string}>):void} onHistory
     */
    fetchHistory(sessionKey, onHistory) {
        if (!this.isConnected || !this.ws) {
            onHistory([]);
            return;
        }
        const id = this._nextId();
        this.historyRequests.set(id, { sessionKey, onHistory });
        this.ws.send(JSON.stringify({
            type: 'req',
            id,
            method: 'chat.history',
            params: { sessionKey, limit: 200 },
        }));
    }
}
