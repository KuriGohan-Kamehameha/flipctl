import type { Command } from '../commands'

export interface TransportResult {
  ok: boolean
  message: string
}

export interface Transport {
  readonly name: string
  connect(): Promise<void>
  send(cmd: Command): Promise<TransportResult>
  isConnected(): boolean
}
