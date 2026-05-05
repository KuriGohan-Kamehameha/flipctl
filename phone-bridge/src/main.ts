// Flipctl Bridge — phone-side BLE↔HTTP bridge.
//
// All actual work happens in the Android Foreground Service (Kotlin):
//   - hosts NanoHTTPD on :8765 with /health, /status, /cmd endpoints
//   - owns the BLE central role and talks to the Flipper Zero
//
// This web UI polls /health + /status so the user can see at a glance
// whether the bridge is alive AND whether the Flipper link is up.

const dot = document.getElementById('dot') as HTMLDivElement
const statusEl = document.getElementById('status') as HTMLDivElement
const log = document.getElementById('log') as HTMLPreElement

const BASE = 'http://127.0.0.1:8765'
const POLL_MS = 2000

function append(line: string): void {
  const ts = new Date().toLocaleTimeString()
  log.textContent = `${log.textContent}\n${ts}  ${line}`.slice(-4000)
}

interface BridgeStatus {
  link: string
  port: number
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) throw new Error(`http ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(t)
  }
}

let lastLink = ''

async function poll(): Promise<void> {
  try {
    const status = await fetchJson<BridgeStatus>(`${BASE}/status`, 1500)
    const link = status.link
    const connected = link.startsWith('connected:')
    dot.className = connected ? 'dot ok' : 'dot warn'
    statusEl.textContent = connected
      ? `service up · ${link.replace('connected:', 'flipper: ')}`
      : `service up · flipper: ${link}`
    if (link !== lastLink) {
      append(`link: ${link}`)
      lastLink = link
    }
  } catch (e) {
    dot.className = 'dot bad'
    statusEl.textContent = 'service down'
    if (lastLink !== '__down__') {
      append(`status err: ${(e as Error).message}`)
      lastLink = '__down__'
    }
  }
}

void poll()
setInterval(poll, POLL_MS)
