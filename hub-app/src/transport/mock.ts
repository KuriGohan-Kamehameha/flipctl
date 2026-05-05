import type { Command } from '../commands'
import type { Transport, TransportResult } from './types'

export class MockTransport implements Transport {
  readonly name = 'mock'
  private connected = false

  async connect(): Promise<void> {
    await delay(50)
    this.connected = true
  }

  async send(cmd: Command): Promise<TransportResult> {
    await delay(120)
    return { ok: true, message: `mock: ${cmd.kind}${cmd.arg ? ' ' + cmd.arg : ''} OK` }
  }

  isConnected(): boolean {
    return this.connected
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
