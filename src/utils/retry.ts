import { logger } from '../lib/logger'

export interface RetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  retryOn?: (err: unknown, attempt: number) => boolean
  onRetry?: (err: unknown, attempt: number) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function calculateDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * Math.pow(2, attempt)
  const jitter = Math.random() * 1000
  return Math.min(exponential + jitter, maxDelayMs)
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3
  const baseDelayMs = opts?.baseDelayMs ?? 1000
  const maxDelayMs = opts?.maxDelayMs ?? 30000
  const retryOn = opts?.retryOn ?? (() => true)
  const onRetry = opts?.onRetry

  let lastError: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err: unknown) {
      lastError = err

      if (attempt === maxAttempts - 1) {
        break
      }

      if (!retryOn(err, attempt)) {
        break
      }

      const delay = calculateDelay(attempt, baseDelayMs, maxDelayMs)

      if (onRetry) {
        onRetry(err, attempt)
      } else {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.warn('Retryable operation failed, retrying', {
          attempt: attempt + 1,
          maxAttempts,
          delayMs: delay,
          error: errMsg,
        })
      }

      await sleep(delay)
    }
  }

  throw lastError
}
