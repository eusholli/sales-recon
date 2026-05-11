/**
 * Thin wrapper around the Viber Public Account REST API.
 *
 * Docs: https://developers.viber.com/docs/api/rest-bot-api/
 */

const VIBER_API = 'https://chatapi.viber.com/pa';
const TEXT_LIMIT = 7000;
// Leave headroom under the 7000-char limit for safety; Viber occasionally
// rejects messages right at the boundary.
const CHUNK_LIMIT = 6500;

export class ViberClient {
    constructor({ token, name, avatarUrl, mockOutbound = false }) {
        if (!token && !mockOutbound) throw new Error('ViberClient requires token');
        this.token = token;
        this.mockOutbound = mockOutbound;
        this.sender = { name: name || 'Sales-Recon', avatar: avatarUrl || undefined };
    }

    async _post(path, body) {
        if (this.mockOutbound) {
            console.log(`[viber-client] (mock) ${path} ←`, JSON.stringify(body));
            return { status: 0, status_message: 'ok-mock' };
        }
        const res = await fetch(`${VIBER_API}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Viber-Auth-Token': this.token,
            },
            body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        if (json.status !== 0) {
            console.warn(`[viber-client] ${path} non-zero status:`, json);
        }
        return json;
    }

    async setWebhook(url, eventTypes = ['message', 'conversation_started', 'subscribed', 'unsubscribed', 'delivered', 'failed']) {
        return this._post('/set_webhook', { url, event_types: eventTypes });
    }

    async sendText(receiver, text, opts = {}) {
        // If receiver is an object, treat it as addressing fields to spread at
        // the top level (used for community/public-account messages which use
        // chat_id + from instead of a plain receiver string).
        const addressing = typeof receiver === 'object' && receiver !== null
            ? receiver
            : { receiver };
        return this._post('/send_message', {
            ...addressing,
            sender: this.sender,
            type: 'text',
            text,
            ...opts,
        });
    }

    async sendLongTextTo(addressing, text) {
        const parts = ViberClient.chunk(text);
        for (const part of parts) {
            await this.sendText(addressing, part);
        }
    }

    /**
     * Split long markdown text into chunks ≤ CHUNK_LIMIT, preferring paragraph
     * breaks → line breaks → sentence breaks → hard cut.
     * @param {string} text
     * @returns {string[]}
     */
    static chunk(text) {
        if (!text) return [];
        if (text.length <= CHUNK_LIMIT) return [text];

        const out = [];
        let remaining = text;
        while (remaining.length > CHUNK_LIMIT) {
            let cut = remaining.lastIndexOf('\n\n', CHUNK_LIMIT);
            if (cut < CHUNK_LIMIT / 2) cut = remaining.lastIndexOf('\n', CHUNK_LIMIT);
            if (cut < CHUNK_LIMIT / 2) cut = remaining.lastIndexOf('. ', CHUNK_LIMIT);
            if (cut < CHUNK_LIMIT / 2) cut = CHUNK_LIMIT;
            out.push(remaining.slice(0, cut).trimEnd());
            remaining = remaining.slice(cut).trimStart();
        }
        if (remaining) out.push(remaining);
        return out;
    }

    async sendLongText(receiver, text) {
        const parts = ViberClient.chunk(text);
        for (const part of parts) {
            await this.sendText(receiver, part);
        }
    }
}

export { TEXT_LIMIT, CHUNK_LIMIT };
