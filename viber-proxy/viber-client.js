/**
 * Thin wrapper around the Viber Public Account REST API.
 *
 * Docs: https://developers.viber.com/docs/api/rest-bot-api/
 */

const VIBER_API = 'https://chatapi.viber.com/pa';
const TEXT_LIMIT = 7000;

function parseRow(line) {
    return line.replace(/^\||\|$/g, '').split('|');
}

// Strip inline markdown markers (*bold*, _italic_, etc.) from a plain string.
function stripInlineMarkdown(s) {
    return s
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/_([^_]+)_/g, '$1')
        .trim();
}

// Convert markdown tables to a Viber-safe bullet layout (Viber ignores | syntax).
function convertTables(text) {
    return text.replace(
        /^(\|[^\n]+\|)\n\|[-| :]+\|\n((?:\|[^\n]+\|[ \t]*\n?)+)/gm,
        (_match, headerLine, bodyLines) => {
            const headers = parseRow(headerLine).map(h => stripInlineMarkdown(h));
            const rows = bodyLines.trim().split('\n').map(parseRow);
            const headerLabel = headers.map(h => `*${h}*`).join(' | ');
            const dataLines = rows.map(row =>
                '• ' + headers.map((h, i) => `*${h}:* ${stripInlineMarkdown(row[i] || '')}`).join('  ')
            );
            return [headerLabel, ...dataLines].join('\n');
        }
    );
}

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
            throw new Error(`Viber API ${path} status=${json.status} ${json.status_message || ''}`);
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
     * Convert AI-generated markdown to the subset supported by Viber clients.
     * Viber supports: *bold*, _italic_, ~strikethrough~, ```monospace```
     * Rules: no inner spaces around markers; closing marker needs a space before
     * an adjacent word character.
     */
    static convertMarkdown(text) {
        // convertTables runs last so its *bold* markers aren't re-processed by
        // the outer-space-fix rule below (which would corrupt * col* separators).
        const processed = text
            // ATX headers (###/##/#) → bold on own line
            .replace(/^#{1,3} (.+)$/gm, '*$1*')
            // **bold** → *bold*
            .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
            // __bold__ → *bold*
            .replace(/__([^_\n]+)__/g, '*$1*')
            // ~~strikethrough~~ → ~strikethrough~
            .replace(/~~([^~\n]+)~~/g, '~$1~')
            // Inline `code` → plain text (triple-backtick monospace blocks preserved)
            .replace(/(?<!`)`(?!`)([^`\n]+)(?<!`)`(?!`)/g, '$1')
            // [link text](url) → link text
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            // Horizontal rules → removed
            .replace(/^[-*]{3,}$/gm, '')
            // Outer-space fix: Viber requires a space between closing marker and adjacent word
            .replace(/(\*[^*\n]+\*)(?=\w)/g, '$1 ')
            .replace(/(_[^_\n]+_)(?=\w)/g, '$1 ')
            .replace(/(~[^~\n]+~)(?=\w)/g, '$1 ')
            // Collapse runs of blank lines left by removed content
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        return convertTables(processed);
    }

    /**
     * Split text into Viber-sized chunks (≤ CHUNK_LIMIT chars).
     * Prefers splitting at section-header boundaries (lines starting with *,
     * #, or an emoji after a blank line), then paragraph breaks, line breaks,
     * sentence breaks, and finally a hard cut.
     * @param {string} text
     * @returns {string[]}
     */
    static chunk(text) {
        if (!text) return [];
        if (text.length <= CHUNK_LIMIT) return [text];

        const out = [];
        let remaining = text;

        while (remaining.length > CHUNK_LIMIT) {
            let cut = -1;

            // 1. Section boundary: scan back from CHUNK_LIMIT for \n\n followed
            //    by *, #, or a non-ASCII character (emoji used as section markers).
            let probe = Math.min(CHUNK_LIMIT, remaining.length - 1);
            while (probe > CHUNK_LIMIT / 4) {
                const pos = remaining.lastIndexOf('\n\n', probe);
                if (pos < CHUNK_LIMIT / 4) break;
                const cc = remaining.charCodeAt(pos + 2);
                if (cc === 0x2A || cc === 0x23 || cc > 0x7E) { cut = pos; break; }
                probe = pos - 1;
            }

            // 2. Paragraph break
            if (cut < 0) {
                const pp = remaining.lastIndexOf('\n\n', CHUNK_LIMIT);
                if (pp >= CHUNK_LIMIT / 4) cut = pp;
            }

            // 3. Line break
            if (cut < 0) {
                const lp = remaining.lastIndexOf('\n', CHUNK_LIMIT);
                if (lp >= CHUNK_LIMIT / 4) cut = lp;
            }

            // 4. Sentence break
            if (cut < 0) {
                const sp = remaining.lastIndexOf('. ', CHUNK_LIMIT);
                if (sp >= 0) cut = sp + 1;
            }

            // 5. Hard cut
            if (cut <= 0) cut = CHUNK_LIMIT;

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
