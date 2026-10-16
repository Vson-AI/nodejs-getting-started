const crypto = require('crypto')

/**
 * Encryption at rest for tenant secrets (NFR-013, BR-16).
 *
 * The SRS specifies SQL Server Always Encrypted with a customer-managed key.
 * On PostgreSQL the equivalent guarantee is kept by encrypting in the
 * application with AES-256-GCM under a key that lives outside the database
 * (APP_ENCRYPTION_KEY), so a database dump or backup never contains a usable
 * SMTP password. Ciphertext layout: version(1) | iv(12) | tag(16) | payload.
 */
const VERSION = 1
const IV_BYTES = 12
const TAG_BYTES = 16

let cachedKey = null

function getKey () {
  if (cachedKey) return cachedKey
  const raw = process.env.APP_ENCRYPTION_KEY
  if (!raw) {
    throw new Error('APP_ENCRYPTION_KEY is not set; tenant secrets cannot be encrypted')
  }
  // Accept a 64-char hex key, a 44-char base64 key, or any passphrase.
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    cachedKey = Buffer.from(raw, 'hex')
  } else {
    const decoded = Buffer.from(raw, 'base64')
    cachedKey = decoded.length === 32
      ? decoded
      : crypto.scryptSync(raw, 'ip-pms-secret-key', 32)
  }
  return cachedKey
}

function encrypt (plaintext) {
  if (plaintext == null || plaintext === '') return null
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv)
  const payload = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, payload])
}

function decrypt (buffer) {
  if (!buffer || buffer.length < 1 + IV_BYTES + TAG_BYTES) return null
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (buf[0] !== VERSION) throw new Error('Unsupported ciphertext version')
  const iv = buf.subarray(1, 1 + IV_BYTES)
  const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES)
  const payload = buf.subarray(1 + IV_BYTES + TAG_BYTES)
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8')
}

function sha256 (input) {
  return crypto.createHash('sha256').update(input).digest('hex')
}

function randomToken (bytes = 9) {
  return crypto.randomBytes(bytes).toString('base64url')
}

module.exports = { encrypt, decrypt, sha256, randomToken }
