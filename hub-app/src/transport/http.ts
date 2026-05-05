import type { Command } from '../commands'
import type { Transport, TransportResult } from './types'

// Phone-resident bridge: a process on the same device (phone) that owns the
// BLE link to the Flipper Zero. The Hub app POSTs commands to it.
//
// Candidate hosts for this endpoint:
//   1. A Capacitor/native sidecar app exposing http://127.0.0.1:<port>/cmd
//   2. The official Flipper mobile app, IF it ever exposes a local HTTP API
//   3. Termux on Android running a bleak-equivalent script
//
// Until one of those is wired up, this transport probes the endpoint at
// connect() and surfaces a clear failure to the HUD instead of silently hanging.

export interface HttpTransportOptions {
  baseUrl: string  // e.g. 'http://127.0.0.1:8765'
  timeoutMs?: number
}

export class HttpTransport implements Transport {
  readonly name = 'http'
  private connected = false
  readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(opts: HttpTransportOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.timeoutMs = opts.timeoutMs ?? 3000
  }

  async connect(): Promise<void> {
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/health`, { method: 'GET' })
      if (!res.ok) throw new Error(`/health ${res.status} @ ${this.baseUrl}`)
      this.connected = true
    } catch (e) {
      // Re-throw with the bridge URL so the failure is debuggable from the HUD.
      const msg = (e as Error).message || 'fetch failed'
      throw new Error(`${this.baseUrl}: ${msg}`)
    }
  }

  async send(cmd: Command): Promise<TransportResult> {
    if (!this.connected) {
      try {
        await this.connect()
      } catch (e) {
        return { ok: false, message: `connect ${(e as Error).message}` }
      }
    }
    try {
      const res = await this.fetchWithTimeout(`${this.baseUrl}/cmd`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: cmd.kind, arg: cmd.arg ?? null }),
      })
      const body = await res.json().catch(() => ({}))
      const message = (body && typeof body.message === 'string') ? body.message : `${cmd.kind} ${res.status}`
      return { ok: res.ok, message }
    } catch (e) {
      return { ok: false, message: `${this.baseUrl}: ${(e as Error).message}` }
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), this.timeoutMs)
    try {
      return await fetch(url, { ...init, signal: ctl.signal })
    } finally {
      clearTimeout(t)
    }
  }
}
