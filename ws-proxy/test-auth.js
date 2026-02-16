
import { loadOrCreateDeviceIdentity, signDevicePayload, buildDeviceAuthPayload, normalizePublicKey } from './device.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_DIR = path.join(__dirname, 'test_data');

try {
    console.log('--- Testing device.js ---');

    // 1. Clean up previous test
    if (fs.existsSync(TEST_DIR)) {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR);

    // 2. Test Identity Generation
    console.log('Testing loadOrCreateDeviceIdentity...');
    const identity1 = loadOrCreateDeviceIdentity(TEST_DIR);
    if (!identity1.deviceId) throw new Error('Invalid deviceId format');
    if (!identity1.privateKeyPem.includes('PRIVATE KEY')) throw new Error('Invalid private key format');
    if (!identity1.publicKeyPem.includes('PUBLIC KEY')) throw new Error('Invalid public key format');
    console.log('  -> Identity 1 generated successfully:', identity1.deviceId);

    // 3. Test Persistence
    console.log('Testing persistence (loading same identity)...');
    const identity2 = loadOrCreateDeviceIdentity(TEST_DIR);
    if (identity1.deviceId !== identity2.deviceId) throw new Error('DeviceId invalid persistence');
    if (identity1.publicKeyPem !== identity2.publicKeyPem) throw new Error('PublicKey invalid persistence');
    console.log('  -> Identity 2 loaded successfully and matches.');

    // 4. Test Payload Signing
    console.log('Testing payload signing...');
    const payloadParams = {
        version: 'v2',
        deviceId: identity1.deviceId,
        clientId: 'test-client',
        clientMode: 'cli',
        role: 'operator',
        scopes: ['read', 'write'],
        signedAtMs: Date.now(),
        nonce: 'test-nonce-123'
    };
    const payload = buildDeviceAuthPayload(payloadParams);
    console.log('  -> Payload:', payload);

    const signature = signDevicePayload(identity1.privateKeyPem, payload);
    console.log('  -> Signature:', signature);

    // 5. Verify Signature (Simulate Gateway Logic)
    console.log('Verifying signature...');
    const key = crypto.createPublicKey(identity1.publicKeyPem);
    const isVerified = crypto.verify(null, Buffer.from(payload), key, Buffer.from(signature, 'base64url'));
    
    if (!isVerified) throw new Error('Signature verification failed!');
    console.log('  -> Signature verified successfully!');

    // Cleanup
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    console.log('--- Tests Passed ---');

} catch (err) {
    console.error('--- Test Failed ---');
    console.error(err);
    process.exit(1);
}
