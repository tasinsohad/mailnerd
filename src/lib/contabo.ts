import axios, { AxiosInstance, AxiosError } from 'axios'
import { withRetry } from '../utils/retry'
import { ContaboAPIError, ContaboTimeoutError, ContaboAuthError, ContaboInstance } from '../types'
import { logger } from './logger'

export interface ContaboConfig {
  clientId: string
  clientSecret: string
  apiUser: string
  apiPassword: string
  authUrl?: string
  apiBase?: string
  defaultProductId?: string
  defaultRegion?: string
  defaultImage?: string
  maxDomainsPerNode?: number
  // Whether this account's Contabo API can set reverse DNS (PTR) for an instance's IPv4. Contabo's
  // public compute API historically has NO rDNS endpoint, so this defaults to false: provisioning then
  // surfaces a blocking notice instead of silently leaving reverse DNS unset. Enable only when the
  // account actually exposes rDNS via the API.
  supportsReverseDns?: boolean
}

// The PTR (reverse DNS) hostname a mail server's IPv4 should resolve to: mail.<domain>.
export function mailPtrHostname(domain: string): string {
  return `mail.${String(domain).trim().toLowerCase().replace(/\.$/, '')}`
}

// A clear, user-facing blocking notice for when reverse DNS can't be set automatically. rDNS is
// mandatory for deliverability (Gmail/Outlook reject or spam-folder mail from IPs without matching
// reverse DNS), so the setup flow must surface this prominently rather than bury it in a health warning.
export function reverseDnsBlockingNotice(ip: string, hostname: string): string {
  return (
    `Reverse DNS (PTR) for ${ip} must be set to ${hostname} before mailboxes go live, but this ` +
    `provider's API can't set it automatically. Set the PTR for ${ip} to ${hostname} in the ` +
    `provider's control panel, then re-check and continue. Mail from an IP whose reverse DNS doesn't ` +
    `match is rejected or spam-foldered.`
  )
}

// Outcome of trying to set reverse DNS during provisioning.
export interface ReverseDnsResult {
  /** The PTR was set via the provider API. */
  set: boolean
  /** The PTR we wanted (mail.<domain>). */
  hostname: string
  /** The provider API can't set rDNS at all — a blocking notice applies. */
  unsupported: boolean
  /** A set attempt was made but failed for another reason. */
  error?: string
  /** User-facing notice to surface in the setup flow when the PTR wasn't set. */
  blockingNotice?: string
}

export class ContaboManager {
  private authApi: AxiosInstance
  private api: AxiosInstance
  private accessToken: string | null = null
  private tokenExpiresAt: number = 0
  private clientId: string
  private clientSecret: string
  private apiUser: string
  private apiPassword: string
  public readonly defaultProductId: string
  public readonly defaultRegion: string
  public readonly defaultImage: string
  public readonly maxDomainsPerNode: number
  public readonly supportsReverseDns: boolean

  constructor(config: ContaboConfig) {
    this.clientId = config.clientId
    this.clientSecret = config.clientSecret
    this.apiUser = config.apiUser
    this.apiPassword = config.apiPassword
    this.defaultProductId = config.defaultProductId ?? 'V45'
    this.defaultRegion = config.defaultRegion ?? 'EU'
    this.defaultImage = config.defaultImage ?? 'ubuntu-22.04'
    this.maxDomainsPerNode = config.maxDomainsPerNode ?? 10
    this.supportsReverseDns = config.supportsReverseDns ?? false

    const authUrl = config.authUrl || 'https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token'
    const apiBase = config.apiBase || 'https://api.contabo.com/v1'

    this.authApi = axios.create({
      baseURL: authUrl,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    })

    this.api = axios.create({
      baseURL: apiBase,
      timeout: 30000,
    })

    this.api.interceptors.request.use(async (config: any) => {
      const token = await this.getAccessToken()
      config.headers.Authorization = `Bearer ${token}`
      return config
    })
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.accessToken
    }

    logger.info('Obtaining new Contabo OAuth2 token')

    const params = new URLSearchParams({
      grant_type: 'password',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      username: this.apiUser,
      password: this.apiPassword,
    })

    try {
      const response = await this.authApi.post<{
        access_token: string
        expires_in: number
      }>('', params.toString())

      this.accessToken = response.data.access_token
      this.tokenExpiresAt = Date.now() + (response.data.expires_in * 1000)

      return this.accessToken!
    } catch (err: any) {
      if (err instanceof AxiosError && err.response) {
        throw new ContaboAuthError(
          `Contabo OAuth2 authentication failed: ${err.response.status} - ${JSON.stringify(err.response.data)}`
        )
      }
      throw new ContaboAuthError(`Contabo OAuth2 request failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    data?: unknown
  ): Promise<T> {
    return withRetry(
      async () => {
        try {
          const response = await this.api.request<{ data: T }>({
            method,
            url: path,
            data,
          })
          return response.data.data
        } catch (err: any) {
          if (err instanceof AxiosError && err.response) {
            throw new ContaboAPIError(
              `Contabo API error: ${err.response.status} - ${JSON.stringify(err.response.data)}`
            )
          }
          throw new ContaboAPIError(`Contabo request failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      },
      { maxAttempts: 3, baseDelayMs: 2000 }
    )
  }

  async provisionVPS(params: {
    hostname: string
    /** The sending domain. When given, provisioning sets the instance's PTR to mail.<domain>, or
     *  returns a blocking notice (reverseDns) when the API can't set reverse DNS. */
    domain?: string
    productId?: string
    region?: string
    imageId?: string
    sshKeyId?: string
    rootPassword?: string
  }): Promise<{ instanceId: string; ipAddress: string; reverseDns?: ReverseDnsResult }> {
    const productId = params.productId || this.defaultProductId
    const region = params.region || this.defaultRegion
    const imageId = params.imageId || this.defaultImage

    const body: Record<string, unknown> = {
      displayName: params.hostname,
      productId,
      region,
      imageId,
      defaultUser: 'root',
    }

    if (params.sshKeyId) {
      body.sshKeys = [params.sshKeyId]
    }
    if (params.rootPassword) {
      body.rootPassword = params.rootPassword
    }

    logger.info('Provisioning Contabo VPS', { hostname: params.hostname, productId, region })

    const result = await this.request<{
      instanceId: string
      ipConfig: { v4: { ip: string } }
    }>('POST', '/compute/instances', body)

    const instanceId = result.instanceId
    const ipAddress = result.ipConfig?.v4?.ip

    if (!instanceId || !ipAddress) {
      throw new ContaboAPIError('Contabo VPS provisioning response missing instanceId or IP address')
    }

    logger.info('Contabo VPS provisioning initiated', { instanceId, ipAddress })

    // Reverse DNS (PTR) → mail.<domain>. Set it as part of provisioning when the API supports it;
    // otherwise return a blocking notice so the setup flow can stop and tell the user to set it manually.
    let reverseDns: ReverseDnsResult | undefined
    if (params.domain) {
      const ptrHostname = mailPtrHostname(params.domain)
      const outcome = await this.setReverseDns({ instanceId, ipAddress, hostname: ptrHostname })
      reverseDns = {
        set: outcome.set,
        hostname: ptrHostname,
        unsupported: outcome.unsupported,
        error: outcome.error,
        blockingNotice: outcome.set ? undefined : reverseDnsBlockingNotice(ipAddress, ptrHostname),
      }
      if (outcome.set) {
        logger.info('Set reverse DNS (PTR) for the VPS', { ipAddress, ptrHostname })
      } else {
        logger.warn('Reverse DNS not set automatically — surfacing a blocking notice', {
          ipAddress,
          ptrHostname,
          unsupported: outcome.unsupported,
          error: outcome.error,
        })
      }
    }

    return { instanceId, ipAddress, reverseDns }
  }

  // Set the reverse DNS (PTR) for an instance's IPv4 to `hostname`. Guarded by supportsReverseDns
  // because Contabo's public compute API historically has no rDNS endpoint: when the capability is off
  // this reports `unsupported` WITHOUT calling the API, so the caller surfaces a blocking notice.
  async setReverseDns(params: {
    instanceId: string
    ipAddress: string
    hostname: string
  }): Promise<{ set: boolean; unsupported: boolean; error?: string }> {
    if (!this.supportsReverseDns) return { set: false, unsupported: true }
    try {
      await this.request('PATCH', `/compute/instances/${params.instanceId}`, {
        ipv4: { reverseDns: params.hostname },
      })
      return { set: true, unsupported: false }
    } catch (err) {
      return {
        set: false,
        unsupported: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  async pollInstanceStatus(
    instanceId: string,
    opts?: { intervalMs?: number; maxWaitMs?: number }
  ): Promise<void> {
    const intervalMs = opts?.intervalMs ?? 15000
    const maxWaitMs = opts?.maxWaitMs ?? 1200000
    const startTime = Date.now()

    logger.info('Polling Contabo instance status', { instanceId })

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const instance = await this.getInstance(instanceId)

        if (instance.status === 'running') {
          logger.info('Contabo instance is running', { instanceId, elapsedMs: Date.now() - startTime })
          return
        }

        logger.debug('Contabo instance still provisioning', {
          instanceId,
          status: instance.status,
          elapsedMs: Date.now() - startTime,
        })
      } catch (err: unknown) {
        logger.warn('Error polling Contabo instance (may still be initializing)', {
          instanceId,
          error: err instanceof Error ? err.message : String(err),
        })
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }

    throw new ContaboTimeoutError(
      `Contabo instance ${instanceId} did not reach running status within ${maxWaitMs / 1000}s`
    )
  }

  async getInstance(instanceId: string): Promise<ContaboInstance> {
    return this.request<ContaboInstance>('GET', `/compute/instances/${instanceId}`)
  }

  async listInstances(): Promise<ContaboInstance[]> {
    return this.request<ContaboInstance[]>('GET', '/compute/instances')
  }

  async createSecret(name: string, type: 'ssh' | 'password', value: string): Promise<{ secretId: string }> {
    const result = await this.request<{ id: string }>('POST', '/secrets', {
      name,
      type,
      value,
    })
    return { secretId: result.id }
  }

  async deleteInstance(instanceId: string): Promise<void> {
    logger.info('Deleting Contabo instance', { instanceId })
    await this.request('DELETE', `/compute/instances/${instanceId}`)
  }
}
