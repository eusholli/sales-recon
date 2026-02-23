/**
 * Device Identity for OpenClaw Gateway authentication.
 *
 * Generates and persists an Ed25519 keypair. The device ID is the SHA-256
 * fingerprint of the raw public key bytes. The Gateway uses this to bind
 * scopes to a stable device identity.
 *
 * Compatible with the OpenClaw device-identity.ts / device-auth.ts protocol.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// ─────────────────────────────────────────────────────────────────────────────
// Encoding helpers
// ─────────────────────────────────────────────────────────────────────────────

function base64UrlEncode(buf) {
    return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

/** Extract the raw 32-byte Ed25519 public key from SPKI DER. */
function derivePublicKeyRaw(publicKeyPem) {
    const key = crypto.createPublicKey(publicKeyPem);
    const spki = key.export({ type: 'spki', format: 'der' });
    if (
        spki.length === ED25519_SPKI_PREFIX.length + 32 &&
        spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    ) {
        return spki.subarray(ED25519_SPKI_PREFIX.length);
    }
    return spki;
}

/** SHA-256 hex fingerprint of the raw public key → device ID. */
function fingerprintPublicKey(publicKeyPem) {
    const raw = derivePublicKeyRaw(publicKeyPem);
    return crypto.createHash('sha256').update(raw).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Identity persistence
// ─────────────────────────────────────────────────────────────────────────────

function generateIdentity() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const deviceId = fingerprintPublicKey(publicKeyPem);
    return { deviceId, publicKeyPem, privateKeyPem };
}

/**
 * Load an existing device identity from disk, or create a new one.
 * @param {string} dir - Directory to store the identity file in.
 * @returns {{ deviceId: string, publicKeyPem: string, privateKeyPem: string }}
 */
export function loadOrCreateDeviceIdentity(dir) {
    const filePath = path.join(dir, 'device.json');
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw);
            if (
                parsed?.version === 1 &&
                typeof parsed.deviceId === 'string' &&
                typeof parsed.publicKeyPem === 'string' &&
                typeof parsed.privateKeyPem === 'string'
            ) {
                return {
                    deviceId: parsed.deviceId,
                    publicKeyPem: parsed.publicKeyPem,
                    privateKeyPem: parsed.privateKeyPem,
                };
            }
        }
    } catch {
        // fall through to regenerate
    }

    const identity = generateIdentity();
    fs.mkdirSync(dir, { recursive: true });
    const stored = {
        version: 1,
        deviceId: identity.deviceId,
        publicKeyPem: identity.publicKeyPem,
        privateKeyPem: identity.privateKeyPem,
        createdAtMs: Date.now(),
    };
    fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    return identity;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload building and signing (matches OpenClaw device-auth.ts v2 format)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the canonical payload string that the Gateway expects to verify.
 * Format: "v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce"
 */
export function buildDeviceAuthPayload({ deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce }) {
    const scopeStr = scopes.join(',');
    const tokenStr = token ?? '';
    return ['v2', deviceId, clientId, clientMode, role, scopeStr, String(signedAtMs), tokenStr, nonce].join('|');
}

/**
 * Sign the payload with the device private key (Ed25519).
 * Returns a base64url-encoded signature.
 */
export function signDevicePayload(privateKeyPem, payload) {
    const key = crypto.createPrivateKey(privateKeyPem);
    const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
    return base64UrlEncode(sig);
}

/**
 * Get the public key as base64url-encoded raw bytes (what the Gateway expects).
 */
export function publicKeyToBase64Url(publicKeyPem) {
    return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}
