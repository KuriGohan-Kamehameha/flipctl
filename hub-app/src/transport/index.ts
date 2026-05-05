import { MockTransport } from './mock'
import { HttpTransport } from './http'
import type { Transport } from './types'

export type { Transport, TransportResult } from './types'
export { MockTransport, HttpTransport }

// Pick a transport based on a URL param (?t=mock|http). Defaults to http so
// a sideloaded production build hits the on-phone bridge automatically.
// Use ?t=mock during simulator development when no bridge is running.
export function pickTransport(): Transport {
  const params = new URLSearchParams(location.search)
  const which = params.get('t') ?? 'http'
  if (which === 'mock') return new MockTransport()
  const url = params.get('bridge') ?? 'http://127.0.0.1:8765'
  return new HttpTransport({ baseUrl: url })
}
