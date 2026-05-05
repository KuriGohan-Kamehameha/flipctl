import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  ImageContainerProperty,
  ImageRawDataUpdate,
  CreateStartUpPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

import {
  INPUT_UP, INPUT_DOWN, INPUT_LEFT, INPUT_RIGHT, INPUT_OK, INPUT_BACK,
  type Command,
} from './commands'
import { pickTransport, type Transport } from './transport'
import { flipperFrameToPng } from './screen'

const TEXT_ID  = 1
const IMAGE_ID = 2
const MENU_ID  = 4
const TAP_WAIT_MS = 450
const STATUS_FADE_MS = 3000     // hide status line after this much steady mirroring
const MENU_OPEN_TAPS = 4        // 4+ rapid taps in mirror mode opens the menu
const MENU_VISIBLE_LINES = 8    // viewport size for the menu list

// Image dimensions kept small to minimize BLE bytes pushed to the glasses each
// frame — that leg of the pipeline is the actual bottleneck. 192×96 = 1.5× the
// Flipper's native 128×64.
const SCREEN_W = 192, SCREEN_H = 96

// Position is configurable via URL ?pos=tl | tr | c (default center).
const positionParam = new URLSearchParams(location.search).get('pos') ?? 'c'
const HUD_W = 576
const MARGIN = 8
let SCREEN_X: number, SCREEN_Y: number, STATUS_Y: number
switch (positionParam) {
  case 'tl':
    SCREEN_X = MARGIN
    SCREEN_Y = MARGIN
    STATUS_Y = SCREEN_Y + SCREEN_H + 8
    break
  case 'tr':
    SCREEN_X = HUD_W - SCREEN_W - MARGIN
    SCREEN_Y = MARGIN
    STATUS_Y = SCREEN_Y + SCREEN_H + 8
    break
  default: // 'c'
    SCREEN_X = (HUD_W - SCREEN_W) >> 1
    SCREEN_Y = 16
    STATUS_Y = SCREEN_Y + SCREEN_H + 8
}

interface State {
  status: string
  transport: Transport
  lastFrameLen: number
  lastRenderResult: string
}
const state: State = {
  status: 'starting',
  transport: pickTransport(),
  lastFrameLen: 0,
  lastRenderResult: '',
}

const bridge = await waitForEvenAppBridge()

// Image containers can't capture events, so we put a full-canvas
// invisible text container BEHIND the image to receive ring taps.
const EVENT_ID = 3
const created = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 4,
    textObject: [
      new TextContainerProperty({
        xPosition: 0, yPosition: 0,
        width: 576, height: 288,
        borderWidth: 0, borderColor: 0, paddingLength: 0,
        containerID: EVENT_ID, containerName: 'event',
        content: ' ',
        isEventCapture: 1,
      }),
      new TextContainerProperty({
        xPosition: 0,
        yPosition: STATUS_Y,
        width: 576,
        height: 32,
        borderWidth: 0, borderColor: 5, paddingLength: 4,
        containerID: TEXT_ID,
        containerName: 'status',
        content: 'starting',
        isEventCapture: 0,
      }),
      // Menu overlay: full-canvas, blank when closed (' '), populated with
      // line-broken menu text when opened. Drawn after the image container so
      // it renders on top of the mirror.
      new TextContainerProperty({
        xPosition: 0, yPosition: 0,
        width: 576, height: 288,
        borderWidth: 0, borderColor: 0, paddingLength: 8,
        containerID: MENU_ID, containerName: 'menu',
        content: ' ',
        isEventCapture: 0,
      }),
    ],
    imageObject: [
      new ImageContainerProperty({
        xPosition: SCREEN_X,
        yPosition: SCREEN_Y,
        width: SCREEN_W,
        height: SCREEN_H,
        containerID: IMAGE_ID,
        containerName: 'flipper',
      }),
    ],
  }),
)
if (created !== 0) console.error('createStartUpPageContainer:', created)

// Fade the status line to a single space (effectively blank) after a sustained
// period of successful mirroring; bring it back the moment something changes.
let statusFadeTimer: number | undefined
let statusVisible = true

async function setStatus(s: string, persist = true): Promise<void> {
  state.status = s
  statusVisible = true
  if (statusFadeTimer !== undefined) {
    clearTimeout(statusFadeTimer)
    statusFadeTimer = undefined
  }
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({ containerID: TEXT_ID, content: s }),
  )
  if (!persist) {
    statusFadeTimer = window.setTimeout(() => {
      void hideStatus()
    }, STATUS_FADE_MS)
  }
}

async function hideStatus(): Promise<void> {
  if (!statusVisible) return
  statusVisible = false
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({ containerID: TEXT_ID, content: ' ' }),
  )
}

void (async () => {
  await setStatus('connecting…')
  try {
    await state.transport.connect()
    // Tell the bridge to start streaming the Flipper screen.
    await state.transport.send({ id: 'sstart', kind: 'screen.start', label: '' })
    await setStatus('mirror on', /* persist */ false)
    pollLoop()
  } catch {
    // Most common case: the Flipctl Bridge isn't running on the phone. Show a
    // friendly explanation rather than the raw fetch error — this is what
    // someone reviewing the app cold will see if they don't have the bridge
    // installed yet.
    await setStatus('Flipctl Bridge not detected on phone')
  }
})()

/**
 * Latest-frame-only mirror pipeline:
 *   fetcher  : long-polls /frame, drops any prior unfetched frame into a
 *              single-slot mailbox (no queue — newer frames evict older ones).
 *   renderer : pulls the freshest frame whenever it's free, encodes + pushes.
 *
 * The previous design pre-fetched the next frame *before* render started, so
 * by the time the ~200ms render finished, the held frame was already stale
 * (newer frames had arrived at the bridge during render but were ignored
 * until the held one was processed). The mailbox below makes each render
 * use the truly-latest frame at the instant render begins.
 */
const debugTimings = new URLSearchParams(location.search).get('debug') === '1'

interface MirrorFrame { id: number; data: Uint8Array }

let mailbox: MirrorFrame | null = null
let mailboxWaiter: ((f: MirrorFrame) => void) | null = null

function offerFrame(f: MirrorFrame): void {
  if (mailboxWaiter) {
    const r = mailboxWaiter
    mailboxWaiter = null
    r(f)
  } else {
    // Drop whatever was sitting here unread — renderer will only ever see latest.
    mailbox = f
  }
}

function takeFrame(): Promise<MirrorFrame> {
  if (mailbox) {
    const f = mailbox
    mailbox = null
    return Promise.resolve(f)
  }
  return new Promise(r => { mailboxWaiter = r })
}

async function pollLoop(): Promise<void> {
  if (state.transport.name !== 'http') return
  const baseUrl = (state.transport as { baseUrl?: string }).baseUrl ?? 'http://127.0.0.1:8765'

  void fetcherLoop(baseUrl)
  void rendererLoop()
}

async function fetcherLoop(baseUrl: string): Promise<void> {
  let sinceId = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(`${baseUrl}/frame?since=${sinceId}`)
      if (res.status === 200) {
        const id = parseInt(res.headers.get('X-Frame-Id') ?? '0', 10)
        const data = new Uint8Array(await res.arrayBuffer())
        sinceId = id
        offerFrame({ id, data })
      }
    } catch {
      // Bridge transient — back off briefly so we don't hot-spin on a dead bridge.
      await new Promise(r => setTimeout(r, 100))
    }
  }
}

async function rendererLoop(): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const frame = await takeFrame()
    const tStart = debugTimings ? performance.now() : 0
    try {
      const png = await flipperFrameToPng(frame.data)
      const tEncoded = debugTimings ? performance.now() : 0
      const result = await bridge.updateImageRawData(
        new ImageRawDataUpdate({
          containerID: IMAGE_ID,
          containerName: 'flipper',
          imageData: png,
        }),
      )
      if (debugTimings) {
        const tDone = performance.now()
        const enc = (tEncoded - tStart) | 0
        const push = (tDone - tEncoded) | 0
        await setStatus(`enc ${enc}ms push ${push}ms ${png.length}B`)
      } else if (result !== 'success' && state.lastRenderResult !== 'err') {
        state.lastRenderResult = 'err'
        await setStatus('render error', /* persist */ false)
      } else if (result === 'success' && state.lastRenderResult !== 'ok') {
        state.lastRenderResult = 'ok'
        await setStatus('mirror on', /* persist */ false)
      }
    } catch {
      if (state.lastRenderResult !== 'err') {
        state.lastRenderResult = 'err'
        await setStatus('render error', /* persist */ false)
      }
    }
  }
}


// ── Menu overlay (favourites picker) ───────────────────────────────────────
//
// Trigger: 4+ rapid ring taps while the mirror is showing. Inside the menu,
// scroll moves the cursor, 1 tap selects, 2+ taps (or text-double-click)
// closes back to the mirror. Mirror keeps streaming underneath — we never
// stop the screen stream, so dropping out of the menu is instant.
//
// Items: every entry from /ext/favorites.txt on the Flipper, plus a single
// "Exit Flipper app" recovery item that drops the foreground app back to
// the desktop (handy if a previous favourite left the Flipper in a state
// the next run can't preempt).
interface MenuItem {
  label: string
  /** Returns the status string shown after the action fires. */
  run: () => Promise<string>
}

const menu: { open: boolean; items: MenuItem[]; cursor: number } = {
  open: false,
  items: [],
  cursor: 0,
}

interface FavoriteRow { name: string; path: string; app: string }

async function fetchFavorites(): Promise<FavoriteRow[]> {
  if (state.transport.name !== 'http') return []
  const baseUrl = (state.transport as { baseUrl?: string }).baseUrl ?? 'http://127.0.0.1:8765'
  try {
    const res = await fetch(`${baseUrl}/favorites`)
    if (!res.ok) return []
    const body = await res.json() as { favorites?: FavoriteRow[] }
    return body.favorites ?? []
  } catch {
    return []
  }
}

async function buildMenuItems(): Promise<MenuItem[]> {
  const items: MenuItem[] = []
  const favs = await fetchFavorites()
  if (favs.length === 0) {
    items.push({
      label: '(no favourites on Flipper)',
      run: async () => '',
    })
  } else {
    for (const f of favs) {
      items.push({
        label: f.name + (f.app ? `  · ${f.app}` : ''),
        run: async () => {
          const r = await state.transport.send({
            id: 'fr', kind: 'favorite.run', label: '', arg: f.path,
          })
          return r.ok ? `running: ${f.name}` : `${f.name}: ${r.message}`
        },
      })
    }
  }
  items.push({ label: '── recovery', run: async () => '' })
  items.push({
    label: 'Exit Flipper app',
    run: async () => {
      const r = await state.transport.send({ id: 'xa', kind: 'app.exit', label: '' })
      return r.ok ? 'exited' : r.message
    },
  })
  return items
}

function renderMenuText(): string {
  const total = menu.items.length
  if (total === 0) return '(no items)'
  const half = MENU_VISIBLE_LINES >> 1
  let start = Math.max(0, menu.cursor - half)
  const end = Math.min(total, start + MENU_VISIBLE_LINES)
  start = Math.max(0, end - MENU_VISIBLE_LINES)
  const lines: string[] = []
  if (start > 0) lines.push('  ↑ more')
  for (let i = start; i < end; i++) {
    const cursor = i === menu.cursor ? '> ' : '  '
    lines.push(cursor + menu.items[i]!.label)
  }
  if (end < total) lines.push('  ↓ more')
  return lines.join('\n')
}

async function pushMenu(content: string): Promise<void> {
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({ containerID: MENU_ID, content }),
  )
}

async function openMenu(): Promise<void> {
  menu.open = true
  menu.cursor = 0
  // Show "loading" instantly, then fill once /favorites returns.
  menu.items = [
    { label: 'Scan NFC',  run: async () => '' },
    { label: 'Scan RFID', run: async () => '' },
    { label: '── loading favourites…', run: async () => '' },
  ]
  await pushMenu(renderMenuText())
  menu.items = await buildMenuItems()
  if (menu.open) await pushMenu(renderMenuText())
}

async function closeMenu(): Promise<void> {
  menu.open = false
  await pushMenu(' ')
}

function isSelectable(item: MenuItem | undefined): boolean {
  return !!item && !item.label.startsWith('──')
}

async function menuMove(delta: number): Promise<void> {
  if (menu.items.length === 0) return
  let i = menu.cursor + delta
  // Skip past separators ("── …").
  while (i >= 0 && i < menu.items.length && !isSelectable(menu.items[i])) i += delta
  if (i < 0 || i >= menu.items.length) return
  menu.cursor = i
  await pushMenu(renderMenuText())
}

async function menuSelect(): Promise<void> {
  const item = menu.items[menu.cursor]
  if (!isSelectable(item)) return
  await closeMenu()
  await setStatus(`… ${item!.label}`, /* persist */ false)
  try {
    const result = await item!.run()
    if (result) await setStatus(result, /* persist */ false)
  } catch (e) {
    await setStatus(`menu: ${(e as Error).message}`, /* persist */ false)
  }
}

// ── Ring → Flipper input dispatch ──────────────────────────────────────────
let tapCount = 0
let tapTimer: number | undefined

function recordTaps(n: number): void {
  tapCount += n
  if (tapTimer !== undefined) clearTimeout(tapTimer)
  tapTimer = window.setTimeout(() => {
    const final = tapCount
    tapCount = 0
    tapTimer = undefined
    if (menu.open) {
      // Inside menu: 1 tap = select, 2+ taps = bail out.
      if (final === 1) void menuSelect()
      else void closeMenu()
      return
    }
    // Mirror mode: 1=OK, 2=LEFT, 3=RIGHT, 4+=open menu.
    if (final >= MENU_OPEN_TAPS) { void openMenu(); return }
    let cmd: Command
    if (final >= 3)      cmd = INPUT_RIGHT
    else if (final === 2) cmd = INPUT_LEFT
    else                  cmd = INPUT_OK
    void dispatch(cmd)
  }, TAP_WAIT_MS)
}

async function dispatch(cmd: Command): Promise<void> {
  // Don't update the on-HUD status for input events — keep the line stable
  // so the user can see persistent state. Could add a transient flash later.
  void state.transport.send(cmd).catch(() => undefined)
}

const unsubscribe = bridge.onEvenHubEvent(async event => {
  if (event.sysEvent) {
    const t = event.sysEvent.eventType ?? OsEventTypeList.CLICK_EVENT
    if (t === OsEventTypeList.SYSTEM_EXIT_EVENT || t === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      try { await state.transport.send({ id: 'sstop', kind: 'screen.stop', label: '' }) } catch {}
      unsubscribe()
      return
    }
    if (t === OsEventTypeList.CLICK_EVENT) { recordTaps(1); return }
    if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) { recordTaps(2); return }
  }
  if (event.textEvent) {
    const t = event.textEvent.eventType ?? OsEventTypeList.CLICK_EVENT
    if (menu.open) {
      if (t === OsEventTypeList.SCROLL_TOP_EVENT)    { void menuMove(-1); return }
      if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) { void menuMove(+1); return }
      if (t === OsEventTypeList.DOUBLE_CLICK_EVENT)  { void closeMenu(); return }
      return
    }
    if (t === OsEventTypeList.SCROLL_TOP_EVENT)    { void dispatch(INPUT_UP); return }
    if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) { void dispatch(INPUT_DOWN); return }
    if (t === OsEventTypeList.DOUBLE_CLICK_EVENT)  { void dispatch(INPUT_BACK); return }
  }
})
