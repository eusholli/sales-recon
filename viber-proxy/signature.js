/**
 * Viber webhook signature verification.
 *
 * Viber signs every callback with HMAC-SHA256 using the bot auth token as the
 * key and the raw JSON body as the value. The hex digest is sent in the
 * X-Viber-Content-Signature header.
 */

import crypto from 'node:crypto';

/**
 * @param {string} token - VIBER_BOT_TOKEN
 * @param {Buffer|string} rawBody - the raw request body bytes
 * @param {string} signature - value of X-Viber-Content-Signature header
 */
export function verifyViberSignature(token, rawBody, signature) {
    if (!token || !signature || !rawBody) return false;
    const expected = crypto
        .createHmac('sha256', token)
        .update(rawBody)
        .digest('hex');
    // Use timing-safe comparison.
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}
