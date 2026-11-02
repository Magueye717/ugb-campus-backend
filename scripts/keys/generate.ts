import { generateKeyPairSync } from 'node:crypto';

// Prints an Ed25519 key pair for JWT signing, as one-line base64 PEM values for .env.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const b64 = (pem: string) => Buffer.from(pem).toString('base64');
console.log(`JWT_PRIVATE_KEY_B64=${b64(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())}`);
console.log(`JWT_PUBLIC_KEY_B64=${b64(publicKey.export({ type: 'spki', format: 'pem' }).toString())}`);
