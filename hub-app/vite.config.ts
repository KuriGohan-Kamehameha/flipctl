import { defineConfig, type Plugin } from 'vite'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

// Dev-server-only helpers for testing on real glasses through the Even app's
// Prototype mode:
//  - /__log collects the page's devlog feed (see src/devlog.ts) into a file
//    and the terminal, since the Even WebView exposes no console.
//  - /app.json is served with this server's own origin added to the network
//    whitelist, so the page may call /__log. The packaged build keeps the
//    on-disk app.json untouched.
function prototypeDevServer(): Plugin {
  const logPath = process.env.FLIPCTL_DEVLOG ?? resolve(process.cwd(), 'devlog.ndjson')
  return {
    name: 'flipctl-prototype-dev-server',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__log', (req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => { if (chunks.length < 64) chunks.push(c) })
        req.on('end', () => {
          const line = Buffer.concat(chunks).toString('utf8').replace(/\r?\n/g, ' ')
          const stamped = `${new Date().toISOString()} ${line}\n`
          try { appendFileSync(logPath, stamped) } catch { /* the terminal line still shows it */ }
          process.stdout.write(`[devlog] ${line.slice(0, 400)}\n`)
          res.statusCode = 204
          res.end()
        })
      })
      server.middlewares.use('/app.json', (req: IncomingMessage, res: ServerResponse) => {
        const raw = JSON.parse(readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'))
        const origin = `http://${req.headers.host ?? 'localhost'}`
        const perms = Array.isArray(raw.permissions) ? raw.permissions : []
        for (const p of perms) {
          if (p && p.name === 'network' && Array.isArray(p.whitelist) && !p.whitelist.includes(origin)) {
            p.whitelist.push(origin)
          }
        }
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(raw))
      })
    },
  }
}

export default defineConfig({
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
  plugins: [prototypeDevServer()],
})
