import { Client, SFTPWrapper } from 'ssh2'
import { SSHAuth, CommandResult, SSHConnectionError, SSHCommandError, SSHTimeoutError } from '../types'
import { withRetry } from '../utils/retry'
import { logger } from './logger'

const DEFAULT_CONNECT_TIMEOUT_MS = 30000
const DEFAULT_COMMAND_TIMEOUT_MS = 300000
const DEFAULT_MAX_RETRIES = 3

export class SSHManager {
  private client: Client | null = null
  private sftp: SFTPWrapper | null = null
  private connected = false

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly username: string,
    private readonly auth: SSHAuth
  ) {}

  async connect(opts?: { timeoutMs?: number; maxRetries?: number }): Promise<void> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES

    if (this.connected) {
      return
    }

    await withRetry(
      async () => {
        await new Promise<void>((resolve, reject) => {
          const client = new Client()

          const timeout = setTimeout(() => {
            client.end()
            reject(new SSHTimeoutError(`SSH connection timed out after ${timeoutMs}ms to ${this.host}:${this.port}`))
          }, timeoutMs)

          client.on('ready', () => {
            clearTimeout(timeout)
            this.client = client
            this.connected = true
            resolve()
          })

          client.on('error', (err: Error) => {
            clearTimeout(timeout)
            if (err.message.includes('All configured authentication methods failed')) {
              reject(new SSHConnectionError(`Authentication failed for ${this.username}@${this.host}`))
            } else {
              reject(new SSHConnectionError(`SSH connection failed to ${this.host}:${this.port}: ${err.message}`))
            }
          })

          const config: import('ssh2').ConnectConfig = {
            host: this.host,
            port: this.port,
            username: this.username,
            readyTimeout: timeoutMs,
            keepaliveInterval: 10000,
            keepaliveCountMax: 3,
          }

          if (this.auth.type === 'key') {
            config.privateKey = this.auth.privateKey
          } else {
            config.password = this.auth.password
          }

          client.connect(config)
        })
      },
      {
        maxAttempts: maxRetries,
        baseDelayMs: 2000,
        maxDelayMs: 15000,
        onRetry: (err, attempt) => {
          logger.warn('SSH connection attempt failed, retrying', {
            host: this.host,
            attempt: attempt + 1,
            error: err instanceof Error ? err.message : String(err),
          })
        },
        retryOn: (err) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          return !errMsg.includes('Authentication failed');
        }
      }
    )
  }

  async executeCommand(cmd: string, opts?: { timeoutMs?: number; onData?: (chunk: string) => void }): Promise<CommandResult> {
    if (!this.client || !this.connected) {
      throw new SSHConnectionError('Not connected. Call connect() first.')
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS

    return new Promise<CommandResult>((resolve, reject) => {
      this.client!.exec(cmd, (err: Error | undefined, channel: any) => {
        if (err) {
          reject(new SSHCommandError(`Failed to execute command: ${err.message}`, {
            stdout: '', stderr: '', exitCode: -1,
          }))
          return
        }

        const timeout = setTimeout(() => {
          channel.close()
          reject(new SSHTimeoutError(`Command timed out after ${timeoutMs}ms: ${cmd.substring(0, 100)}`))
        }, timeoutMs)

        let stdout = ''
        let stderr = ''

        channel.on('data', (data: string | Buffer) => {
          const str = data.toString()
          stdout += str
          if (opts?.onData) {
            opts.onData(str)
          }
        })

        channel.stderr.on('data', (data: string | Buffer) => {
          const str = data.toString()
          stderr += str
          if (opts?.onData) {
            opts.onData(str)
          }
        })

        channel.on('exit', (exitCode: number | null) => {
          clearTimeout(timeout)
          const code = exitCode ?? -1
          const result: CommandResult = { stdout, stderr, exitCode: code }

          if (code !== 0) {
            reject(new SSHCommandError(
              `Command exited with code ${code}: ${cmd.substring(0, 100)}`,
              result
            ))
          } else {
            resolve(result)
          }
        })

        channel.on('error', (channelErr: Error) => {
          clearTimeout(timeout)
          reject(new SSHCommandError(`Channel error: ${channelErr.message}`, {
            stdout, stderr, exitCode: -1,
          }))
        })
      })
    })
  }

  async uploadFile(content: string | Buffer, remotePath: string): Promise<void> {
    if (!this.client || !this.connected) {
      throw new SSHConnectionError('Not connected. Call connect() first.')
    }

    const sftp = await this.getSFTP()
    const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content

    return new Promise<void>((resolve, reject) => {
      const writeStream = sftp.createWriteStream(remotePath)
      writeStream.on('error', (err: Error) => {
        reject(new SSHCommandError(`SFTP upload failed to ${remotePath}: ${err.message}`, {
          stdout: '', stderr: '', exitCode: -1,
        }))
      })
      writeStream.on('close', () => resolve())
      writeStream.end(buffer)
    })
  }

  async downloadFile(remotePath: string): Promise<Buffer> {
    if (!this.client || !this.connected) {
      throw new SSHConnectionError('Not connected. Call connect() first.')
    }

    const sftp = await this.getSFTP()

    return new Promise<Buffer>((resolve, reject) => {
      const readStream = sftp.createReadStream(remotePath)
      const chunks: Buffer[] = []

      readStream.on('data', (chunk: Buffer) => chunks.push(chunk))
      readStream.on('error', (err: Error) => {
        reject(new SSHCommandError(`SFTP download failed from ${remotePath}: ${err.message}`, {
          stdout: '', stderr: '', exitCode: -1,
        }))
      })
      readStream.on('end', () => resolve(Buffer.concat(chunks)))
    })
  }

  private async getSFTP(): Promise<SFTPWrapper> {
    if (this.sftp) {
      return this.sftp
    }

    return new Promise<SFTPWrapper>((resolve, reject) => {
      if (!this.client) {
        reject(new SSHConnectionError('Not connected'))
        return
      }

      this.client.sftp((err: Error | undefined, sftp: any) => {
        if (err) {
          reject(new SSHCommandError(`SFTP subsystem error: ${err.message}`, {
            stdout: '', stderr: '', exitCode: -1,
          }))
          return
        }
        this.sftp = sftp
        resolve(sftp)
      })
    })
  }

  async dispose(): Promise<void> {
    if (this.sftp) {
      this.sftp.end()
      this.sftp = null
    }
    if (this.client) {
      this.client.end()
      this.client = null
    }
    this.connected = false
  }
}
