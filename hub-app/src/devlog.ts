// Development-only event feed. The Even app's WebView keeps console output to
// itself, so when the page is loaded from a dev server with `?devlog=1` every
// notable thing is POSTed back to that server's /__log route instead. Off in
// a packaged build: without the flag nothing is sent.

const ENABLED = new URLSearchParams(location.search).get('devlog') === '1'
const MAX_BYTES = 8192
let seq = 0

export function devlogEnabled(): boolean {
  return ENABLED
}

export function devlog(tag: string, data?: unknown): void {
  if (!ENABLED) return
  seq += 1
  let body: string
  try {
    body = JSON.stringify({ seq, t: Date.now(), tag, data: data ?? null })
  } catch {
    body = JSON.stringify({ seq, t: Date.now(), tag, data: '(unserialisable)' })
  }
  if (body.length > MAX_BYTES) body = body.slice(0, MAX_BYTES)
  try {
    void fetch('/__log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => undefined)
  } catch {
    // A failed log line must never affect the app.
  }
}
