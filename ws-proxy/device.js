import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {Object} DeviceIdentity
 * @property {string} deviceId
 * @property {string} publicKeyPem
 * @property {string} privateKeyPem
 */

/**
 * @typedef {Object} StoredIdentity
 * @property {number} version
 * @property {string} deviceId
 * @property {string} publicKeyPem
 * @property {string} privateKeyPem
 * @property {number} createdAtMs
 */

/**
 * Generates a new Ed25519 keypair and derives the device ID.
 * @returns {DeviceIdentity}
 */
export function generateIdentity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519", {
    modulusLength: 4096,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const deviceId = deriveDeviceIdFromPublicKey(publicKey);
  return { deviceId, publicKeyPem: publicKey, privateKeyPem: privateKey };
}

// Ed25519 SPKI Prefix to strip (302a300506032b6570032100)
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Derives the raw public key bytes, stripping the SPKI header if present.
 * @param {string} publicKeyPem
 * @returns {Buffer}
 */
function derivePublicKeyRaw(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

/**
 * Derives a device ID from the public key (SHA256 hex fingerprint of raw key).
 * @param {string} publicKeyPem
 * @returns {string}
 */
export function deriveDeviceIdFromPublicKey(publicKeyPem) {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * Loads the device identity from disk, or generates and saves a new one if it doesn't exist.
 * @param {string} dataDir - Directory to store the device.identity.json file.
 * @returns {DeviceIdentity}
 */
export function loadOrCreateDeviceIdentity(dataDir) {
  const filePath = path.join(dataDir, "device.identity.json");

  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === "string" &&
        typeof parsed.publicKeyPem === "string" &&
        typeof parsed.privateKeyPem === "string"
      ) {
        // Validation: Ensure deviceId matches the public key (self-healing)
        const derivedId = deriveDeviceIdFromPublicKey(parsed.publicKeyPem);
        if (derivedId !== parsed.deviceId) {
             console.warn(`[ws-proxy] Device ID mismatch (stored: ${parsed.deviceId}, derived: ${derivedId}). Healing...`);
             const updated = { ...parsed, deviceId: derivedId };
             fs.writeFileSync(filePath, JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });
             return {
                 deviceId: derivedId,
                 publicKeyPem: parsed.publicKeyPem,
                 privateKeyPem: parsed.privateKeyPem
             };
        }

        console.log(`[ws-proxy] Loaded existing device identity: ${parsed.deviceId}`);
        return {
          deviceId: parsed.deviceId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        };
      }
    }
  } catch (err) {
    console.warn(`[ws-proxy] Failed to load existing identity, generating new one: ${err.message}`);
  }

  console.log(`[ws-proxy] Generating new device identity...`);
  const identity = generateIdentity();
  
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const stored = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  };

  fs.writeFileSync(filePath, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
  console.log(`[ws-proxy] Saved new device identity: ${identity.deviceId}`);
  return identity;
}

/**
 * Signs a payload string with the device's private key.
 * @param {string} privateKeyPem
 * @param {string} payload
 * @returns {string} Base64URL encoded signature
 */
export function signDevicePayload(privateKeyPem, payload) {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return sig.toString("base64url");
}

/**
 * Builds the authentication payload string to be signed.
 * @param {Object} params
 * @param {string} params.version
 * @param {string} params.deviceId
 * @param {string} params.clientId
 * @param {string} params.clientMode
 * @param {string} params.role
 * @param {string[]} params.scopes
 * @param {number} params.signedAtMs
 * @param {string} [params.token]
 * @param {string} [params.nonce]
 * @returns {string}
 */
export function buildDeviceAuthPayload(params) {
  const version = params.version ?? (params.nonce ? "v2" : "v1");
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  const base = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
  ];
  if (version === "v2") {
    base.push(params.nonce ?? "");
  }
  return base.join("|");
}

/**
 * Normalizes the public key to a Base64URL string (stripping headers/footers).
 * @param {string} publicKeyPem 
 * @returns {string}
 */
export function normalizePublicKey(publicKeyPem) {
  const key = crypto.createPublicKey(publicKeyPem);
    const der = key.export({ type: "spki", format: "der" });
    return der.toString("base64url");
}
