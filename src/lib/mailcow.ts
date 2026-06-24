import axios, { AxiosInstance, AxiosError } from 'axios'
import { withRetry } from '../utils/retry'
import { MailcowAPIError, DKIMTimeoutError, DKIMResult } from '../types'
import { logger } from './logger'

export class MailcowManager {
  private api: AxiosInstance

  constructor(apiEndpoint: string, apiKey: string) {
    const baseUrl = apiEndpoint.replace(/\/+$/, '')
    this.api = axios.create({
      baseURL: baseUrl,
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    })
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    data?: unknown
  ): Promise<T> {
    return withRetry(
      async () => {
        try {
          const response = await this.api.request<T>({ method, url: path, data, validateStatus: () => true })
          const status = response.status

          if (status >= 400) {
            const body = JSON.stringify(response.data)
            if (body.toLowerCase().includes('object already exists')) {
              return response.data
            }
            throw new MailcowAPIError(`Mailcow API error (${status}): ${body}`)
          }

          return response.data
        } catch (err: any) {
          if (err instanceof MailcowAPIError) throw err
          if (err instanceof AxiosError) {
            throw new MailcowAPIError(`Mailcow request failed: ${err.message}`)
          }
          throw new MailcowAPIError(`Mailcow request failed: ${String(err)}`)
        }
      },
      { maxAttempts: 3, baseDelayMs: 1000 }
    )
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.request<Record<string, unknown>>('GET', '/get/status/containers')
      const containers = Object.values(result)
      return containers.length > 0 && containers.every(c => c !== 'dead' && c !== 'exited')
    } catch {
      return false
    }
  }

  async addDomain(domain: string): Promise<void> {
    await this.request('POST', '/add/domain', {
      domain,
      active: 1,
      restart_sogo: 1,
    })
    logger.info('Mailcow domain added', { domain })
  }

  async getDKIM(
    domain: string,
    opts?: { pollIntervalMs?: number; maxWaitMs?: number }
  ): Promise<DKIMResult> {
    const pollIntervalMs = opts?.pollIntervalMs ?? 3000
    const maxWaitMs = opts?.maxWaitMs ?? 60000
    const startTime = Date.now()

    logger.info('Polling Mailcow DKIM keys', { domain })

    while (Date.now() - startTime < maxWaitMs) {
      const result = await this.request<{
        [domain: string]: {
          dkim_selector?: string
          dkim_public_key?: string
        }
      }>('GET', `/get/dkim/${domain}`)

      const dkimData = result[domain]
      const publicKey = dkimData?.dkim_public_key
      const selector = dkimData?.dkim_selector

      if (publicKey && selector) {
        logger.info('DKIM keys retrieved', { domain, selector })
        return { selector, publicKey }
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }

    throw new DKIMTimeoutError(`Mailcow DKIM key generation timed out for domain ${domain}`)
  }

  async createMailbox(params: {
    domain: string
    username: string
    password: string
    quotaMb?: number
    name?: string
  }): Promise<void> {
    const quotaMb = params.quotaMb ?? parseInt(process.env.MAILCOW_DEFAULT_QUOTA_MB || '1024', 10)
    const localPart = params.username.includes('@') ? params.username.split('@')[0]! : params.username

    await this.request('POST', '/add/mailbox', {
      local_part: localPart,
      domain: params.domain,
      password: params.password,
      password2: params.password,
      quota: quotaMb,
      name: params.name || localPart,
      active: 1,
    })

    logger.info('Mailcow mailbox created', { email: `${localPart}@${params.domain}` })
  }

  async listDomains(): Promise<string[]> {
    const result = await this.request<Array<{ domain: string }>>('GET', '/get/domain/all')
    return result.map(d => d.domain)
  }

  async removeDomain(domain: string): Promise<void> {
    await this.request('DELETE', '/delete/domain', { domain })
    logger.info('Mailcow domain removed', { domain })
  }
}
