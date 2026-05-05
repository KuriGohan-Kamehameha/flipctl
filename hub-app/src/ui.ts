import type { Transport } from './transport'

export interface MirrorState {
  status: string             // last action / connection state
  lastButton: string         // for visual feedback
  transport: Transport
}

export function renderMirror(s: MirrorState): string {
  const conn = s.transport.isConnected() ? 'on' : '--'
  return [
    `FLIPCTL  ${s.transport.name}:${conn}`,
    '',
    `       ${s.lastButton || '·'}`,
    '',
    'scroll  = Up/Down',
    'tap     = OK',
    'double  = Left',
    'triple  = Right',
    'hold    = Back',
    '',
    s.status,
  ].join('\n')
}
