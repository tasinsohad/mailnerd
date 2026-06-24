import axios, { AxiosInstance, AxiosError } from 'axios'
import { withRetry } from '../utils/retry'
import { CloudflareAPIError, CloudflareRateLimitError } from '../types'
import { logger } from './logger'

const API_BASE = 'https://api.cloudflare.com/client/v4'
const RATE_LIMIT_DELAY_MS = 200

interface CFResponse<T> {
  success: boolean
  errors: Array<{ code: number; message: string }>
  result: T | null
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class CloudflareManager {
  private api: AxiosInstance
  private zoneId: string

  constructor(apiToken: string, zoneId: string) {
    this.zoneId = zoneId
    this.api = axios.create({
      baseURL: API_BASE,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    })
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    data?: unknown
  ): Promise<CFResponse<T>> {
    return withRetry(
      async () => {
        try {
          const response = await this.api.request<CFResponse<T>>({
            method,
            url: path,
            data,
          })
          return response.data
        } catch (err: any) {
          if (err instanceof AxiosError && err.response) {
            const status = err.response.status
            const body = err.response.data as CFResponse<unknown>

            if (status === 429) {
              throw new CloudflareRateLimitError('Cloudflare API rate limit exceeded')
            }

            const errorMsg = body?.errors?.[0]?.message ?? err.message
            throw new CloudflareAPIError(`Cloudflare API error (${status}): ${errorMsg}`)
          }
          throw new CloudflareAPIError(`Cloudflare request failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      },
      {
        maxAttempts: 3,
        baseDelayMs: 1000,
        retryOn: (err: any) => err instanceof CloudflareRateLimitError || err instanceof CloudflareAPIError,
      }
    )
  }

  private async findExistingRecord(type: string, name: string): Promise<string | null> {
    const response = await this.request<Array<{ id: string; content: string }>>('GET', `/zones/${this.zoneId}/dns_records`, {
      params: { type, name },
    })

    if (response.success && response.result && response.result.length > 0) {
      return response.result[0]!.id
    }
    return null
  }

  async upsertARecord(subdomain: string, ip: string): Promise<void> {
    const fullName = subdomain
    const type = 'A'

    await delay(RATE_LIMIT_DELAY_MS)
    const existingId = await this.findExistingRecord(type, fullName)

    if (existingId) {
      await this.request('PATCH', `/zones/${this.zoneId}/dns_records/${existingId}`, {
        type,
        name: fullName,
        content: ip,
        ttl: 1,
        proxied: false,
      })
      logger.info('Updated A record', { subdomain, ip })
    } else {
      await this.request('POST', `/zones/${this.zoneId}/dns_records`, {
        type,
        name: fullName,
        content: ip,
        ttl: 1,
        proxied: false,
      })
      logger.info('Created A record', { subdomain, ip })
    }
  }

  async upsertMXRecord(subdomain: string, mailHostname: string): Promise<void> {
    const fullName = subdomain
    const type = 'MX'

    await delay(RATE_LIMIT_DELAY_MS)
    const existingId = await this.findExistingRecord(type, fullName)

    if (existingId) {
      await this.request('PATCH', `/zones/${this.zoneId}/dns_records/${existingId}`, {
        type,
        name: fullName,
        content: mailHostname,
        priority: 10,
        ttl: 1,
      })
      logger.info('Updated MX record', { subdomain, mailHostname })
    } else {
      await this.request('POST', `/zones/${this.zoneId}/dns_records`, {
        type,
        name: fullName,
        content: mailHostname,
        priority: 10,
        ttl: 1,
      })
      logger.info('Created MX record', { subdomain, mailHostname })
    }
  }

  async upsertSPFRecord(subdomain: string, ip: string): Promise<void> {
    const fullName = subdomain
    const type = 'TXT'
    const content = `v=spf1 a mx ip4:${ip} ~all`

    await delay(RATE_LIMIT_DELAY_MS)
    const existingId = await this.findExistingRecord(type, fullName)

    if (existingId) {
      await this.request('PATCH', `/zones/${this.zoneId}/dns_records/${existingId}`, {
        type,
        name: fullName,
        content,
        ttl: 1,
      })
      logger.info('Updated SPF record', { subdomain, ip })
    } else {
      await this.request('POST', `/zones/${this.zoneId}/dns_records`, {
        type,
        name: fullName,
        content,
        ttl: 1,
      })
      logger.info('Created SPF record', { subdomain, ip })
    }
  }

  async upsertDKIMRecord(subdomain: string, selector: string, publicKey: string): Promise<void> {
    const recordName = `${selector}._domainkey.${subdomain}`
    const type = 'TXT'
    const content = `v=DKIM1; k=rsa; p=${publicKey}`

    await delay(RATE_LIMIT_DELAY_MS)
    const existingId = await this.findExistingRecord(type, recordName)

    if (existingId) {
      await this.request('PATCH', `/zones/${this.zoneId}/dns_records/${existingId}`, {
        type,
        name: recordName,
        content,
        ttl: 1,
      })
      logger.info('Updated DKIM record', { subdomain, selector })
    } else {
      await this.request('POST', `/zones/${this.zoneId}/dns_records`, {
        type,
        name: recordName,
        content,
        ttl: 1,
      })
      logger.info('Created DKIM record', { subdomain, selector })
    }
  }

  async upsertDMARCRecord(subdomain: string): Promise<void> {
    const recordName = `_dmarc.${subdomain}`
    const type = 'TXT'
    const content = `v=DMARC1; p=none; rua=mailto:dmarc@${subdomain}; adkim=r; aspf=r`

    await delay(RATE_LIMIT_DELAY_MS)
    const existingId = await this.findExistingRecord(type, recordName)

    if (existingId) {
      await this.request('PATCH', `/zones/${this.zoneId}/dns_records/${existingId}`, {
        type,
        name: recordName,
        content,
        ttl: 1,
      })
      logger.info('Updated DMARC record', { subdomain })
    } else {
      await this.request('POST', `/zones/${this.zoneId}/dns_records`, {
        type,
        name: recordName,
        content,
        ttl: 1,
      })
      logger.info('Created DMARC record', { subdomain })
    }
  }

  async verifyZoneDomain(expectedRootDomain: string): Promise<boolean> {
    const response = await this.request<{ name: string }>('GET', `/zones/${this.zoneId}`)
    if (response.success && response.result) {
      return response.result.name === expectedRootDomain ||
        expectedRootDomain.endsWith(`.${response.result.name}`)
    }
    return false
  }
}
