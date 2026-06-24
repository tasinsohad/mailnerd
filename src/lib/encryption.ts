import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import { EncryptionError } from '../types'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 16
const TAG_LENGTH = 16

function getKey(): Buffer {
  const keyBase64 = process.env.ENCRYPTION_KEY
  if (!keyBase64) {
    throw new EncryptionError('ENCRYPTION_KEY environment variable is not set')
  }
  const key = Buffer.from(keyBase64, 'base64')
  if (key.length !== 32) {
    throw new EncryptionError('ENCRYPTION_KEY must decode to exactly 32 bytes (256 bits)')
  }
  return key
}

export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  let encrypted = cipher.update(plaintext, 'utf8', 'base64')
  encrypted += cipher.final('base64')
  const authTag = cipher.getAuthTag()

  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`
}

export function decrypt(ciphertext: string): string {
  const key = getKey()
  const parts = ciphertext.split(':')
  if (parts.length !== 3) {
    throw new EncryptionError('Invalid ciphertext format')
  }

  const [ivBase64, authTagBase64, encryptedBase64] = parts
  if (!ivBase64 || !authTagBase64 || !encryptedBase64) {
    throw new EncryptionError('Invalid ciphertext format')
  }

  const iv = Buffer.from(ivBase64, 'base64')
  const authTag = Buffer.from(authTagBase64, 'base64')

  if (iv.length !== IV_LENGTH) {
    throw new EncryptionError('Invalid IV length in ciphertext')
  }

  if (authTag.length !== TAG_LENGTH) {
    throw new EncryptionError('Invalid auth tag length in ciphertext')
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  let decrypted = decipher.update(encryptedBase64, 'base64', 'utf8')
  decrypted += decipher.final('utf8')

  return decrypted
}
