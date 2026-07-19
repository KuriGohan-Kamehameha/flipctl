import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  ImageContainerProperty,
  ImageRawDataUpdate,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

import {
  INPUT_UP, INPUT_DOWN, INPUT_LEFT, INPUT_RIGHT, INPUT_OK, INPUT_BACK,
  type Command,
} from './commands'
import { pickTransport, type Transport } from './transport'
import { flipperFrameToPng, MIRROR_W, MIRROR_H } from './screen'
import {
  loadSettings, saveSettings,
  MIRROR_POSITIONS, STANDBY_CORNERS, COLOURS,
  type Settings, type MirrorPosition, type StandbyCorner,
} from './settings'

// ── Layout constants ──────────────────────────────────────────────────────
const HUD_W  = 576
const HUD_H  = 288
const MARGIN = 8

// ── Container IDs (stable across rebuilds) ─────────────────────────────────
const ID_EVENT  = 1
const ID_STATUS = 2
const ID_MAIN   = 3   // menu list OR standby legend
const ID_IMAGE  = 4   // mirror image

// ── Behaviour tuning ──────────────────────────────────────────────────────
const TAP_WAIT_MS      = 450
const STATUS_FADE_MS   = 3000
const MENU_OPEN_TAPS   = 4
const MENU_VISIBLE_LINES = 8
// Render error / mirror-on toggled per individual frame is noisy under any
// network jitter. Hysteresis: only flip the displayed status after this many
// consecutive frames in the new state.
const RENDER_HYSTERESIS = 5

// ── Settings & transport ──────────────────────────────────────────────────
const settings: Settings = loadSettings()
const transport: Transport = pickTransport()
const debugTimings = new URLSearchParams(location.search).get('debug') === '1'

const bridge = await waitForEvenAppBridge()

// ── View state machine ───────────────────────────────────────────────────
interface FavoriteRow { name: string; path: string; app: string }

interface MenuItem {
  label: string
  selectable: boolean        // separators / hints are not selectable
  action?: () => Promise<void>
}

interface MenuView {
  title: string
  items: MenuItem[]
  cursor: number
  back: () => Promise<void>  // 2+ taps or text-double-click closes the menu
}

type View =
  | { kind: 'menu',    menu: MenuView }
  | { kind: 'mirror' }
  | { kind: 'standby', fav: FavoriteRow, fired: boolean }

let currentView: View = { kind: 'menu', menu: makeBootMenu('starting…') }

// ── Layout helpers ────────────────────────────────────────────────────────
function mirrorXY(p: MirrorPosition): { x: number; y: number } {
  switch (p) {
    case 'tl': return { x: MARGIN,                          y: MARGIN }
    case 'tm': return { x: (HUD_W - MIRROR_W) >> 1,         y: MARGIN }
    case 'tr': return { x: HUD_W - MIRROR_W - MARGIN,       y: MARGIN }
    case 'c':  return { x: (HUD_W - MIRROR_W) >> 1,         y: (HUD_H - MIRROR_H) >> 1 }
    case 'bl': return { x: MARGIN,                          y: HUD_H - MIRROR_H - MARGIN }
    case 'bm': return { x: (HUD_W - MIRROR_W) >> 1,         y: HUD_H - MIRROR_H - MARGIN }
    case 'br': return { x: HUD_W - MIRROR_W - MARGIN,       y: HUD_H - MIRROR_H - MARGIN }
  }
}

const STANDBY_W = 280
const STANDBY_H = 32
function standbyXY(c: StandbyCorner): { x: number; y: number } {
  switch (c) {
    case 'tl': return { x: MARGIN,                       y: MARGIN }
    case 'tr': return { x: HUD_W - STANDBY_W - MARGIN,   y: MARGIN }
    case 'bl': return { x: MARGIN,                       y: HUD_H - STANDBY_H - MARGIN }
    case 'br': return { x: HUD_W - STANDBY_W - MARGIN,   y: HUD_H - STANDBY_H - MARGIN }
  }
}

// Status line sits below the mirror unless that would push off-screen, in
// which case it tucks above. Keeps the line near the user's gaze either way.
function statusY(p: MirrorPosition): number {
  const { y } = mirrorXY(p)
  const below = y + MIRROR_H + 8
  if (below + 32 <= HUD_H - MARGIN) return below
  return Math.max(MARGIN, y - 32 - 8)
}

// ── Container factories ───────────────────────────────────────────────────
function eventCapture(): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0, yPosition: 0,
    width: HUD_W, height: HUD_H,
    borderWidth: 0, borderColor: 0, paddingLength: 0,
    containerID: ID_EVENT, containerName: 'event',
    content: ' ',
    isEventCapture: 1,
  })
}

function fullCanvasText(id: number, content: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0, yPosition: 0,
    width: HUD_W, height: HUD_H,
    borderWidth: 0, borderColor: 0, paddingLength: 8,
    containerID: id, containerName: `c${id}`,
    content,
    isEventCapture: 0,
  })
}

function statusBar(content: string, y: number): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0, yPosition: y,
    width: HUD_W, height: 32,
    borderWidth: 0, borderColor: 5, paddingLength: 4,
    containerID: ID_STATUS, containerName: 'status',
    content,
    isEventCapture: 0,
  })
}

function mirrorImage(p: MirrorPosition): ImageContainerProperty {
  const { x, y } = mirrorXY(p)
  return new ImageContainerProperty({
    xPosition: x, yPosition: y,
    width: MIRROR_W, height: MIRROR_H,
    containerID: ID_IMAGE, containerName: 'flipper',
  })
}

function standbyLegend(text: string): TextContainerProperty {
  const { x, y } = standbyXY(settings.standbyCorner)
  return new TextContainerProperty({
    xPosition: x, yPosition: y,
    width: STANDBY_W, height: STANDBY_H,
    borderWidth: 0, borderColor: 0, paddingLength: 4,
    containerID: ID_MAIN, containerName: 'standby',
    content: text,
    isEventCapture: 0,
  })
}

// ── View application (rebuilds the page) ─────────────────────────────────
async function applyView(view: View): Promise<void> {
  currentView = view
  let textObject: TextContainerProperty[]
  let imageObject: ImageContainerProperty[] | undefined

  if (view.kind === 'menu') {
    textObject = [eventCapture(), fullCanvasText(ID_MAIN, renderMenuText(view.menu))]
  } else if (view.kind === 'mirror') {
    textObject = [eventCapture(), statusBar(' ', statusY(settings.mirrorPosition))]
    imageObject = [mirrorImage(settings.mirrorPosition)]
  } else {
    textObject = [eventCapture(), standbyLegend(legendText(view.fav, view.fired))]
  }

  const total = textObject.length + (imageObject?.length ?? 0)
  await bridge.rebuildPageContainer(new RebuildPageContainer({
    containerTotalNum: total,
    textObject,
    imageObject,
  }))

  if (view.kind === 'mirror') {
    lastStatus = ' '
    renderErrCount = 0
    renderOkCount = 0
    await startStream()
  } else {
    await stopStream()
  }
}

function legendText(fav: FavoriteRow, fired: boolean): string {
  return `${fav.name}  ${fired ? 'FIRED' : 'READY'}`
}

// ── Stream lifecycle ─────────────────────────────────────────────────────
let streamingActive = false

async function startStream(): Promise<void> {
  if (streamingActive) return
  streamingActive = true
  try { await transport.send({ id: 'sstart', kind: 'screen.start', label: '' }) } catch { /* ignore */ }
}

async function stopStream(): Promise<void> {
  if (!streamingActive) return
  streamingActive = false
  try { await transport.send({ id: 'sstop', kind: 'screen.stop', label: '' }) } catch { /* ignore */ }
}

// ── Status line with hysteresis & fade ───────────────────────────────────
let statusFadeTimer: number | undefined
let lastStatus = ''

async function setStatus(s: string, persist = true): Promise<void> {
  if (currentView.kind !== 'mirror') return
  if (s === lastStatus) return
  lastStatus = s
  if (statusFadeTimer !== undefined) {
    clearTimeout(statusFadeTimer)
    statusFadeTimer = undefined
  }
  await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: ID_STATUS, content: s }))
  if (!persist) {
    statusFadeTimer = window.setTimeout(() => {
      lastStatus = ' '
      void bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: ID_STATUS, content: ' ' }))
    }, STATUS_FADE_MS)
  }
}

// ── Mirror frame pipeline (latest-frame-only mailbox) ────────────────────
interface MirrorFrame { id: number; data: Uint8Array }
let mailbox: MirrorFrame | null = null
let mailboxWaiter: ((f: MirrorFrame) => void) | null = null

function offerFrame(f: MirrorFrame): void {
  if (mailboxWaiter) {
    const r = mailboxWaiter
    mailboxWaiter = null
    r(f)
  } else {
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

async function fetcherLoop(): Promise<void> {
  if (transport.name !== 'http') return
  const baseUrl = (transport as { baseUrl?: string }).baseUrl ?? 'http://127.0.0.1:8765'
  let sinceId = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!streamingActive) {
      await new Promise(r => setTimeout(r, 200))
      continue
    }
    try {
      const res = await fetch(`${baseUrl}/frame?since=${sinceId}`)
      if (res.status === 200) {
        const id = parseInt(res.headers.get('X-Frame-Id') ?? '0', 10)
        const data = new Uint8Array(await res.arrayBuffer())
        sinceId = id
        offerFrame({ id, data })
      }
    } catch {
      await new Promise(r => setTimeout(r, 100))
    }
  }
}

let renderErrCount = 0
let renderOkCount  = 0

async function rendererLoop(): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const frame = await takeFrame()
    if (currentView.kind !== 'mirror') continue
    const tStart = debugTimings ? performance.now() : 0
    try {
      const png = await flipperFrameToPng(frame.data, settings.colours === 'inverted')
      const tEnc = debugTimings ? performance.now() : 0
      const result = await bridge.updateImageRawData(new ImageRawDataUpdate({
        containerID: ID_IMAGE, containerName: 'flipper', imageData: png,
      }))
      if (debugTimings) {
        const tDone = performance.now()
        await setStatus(`enc ${(tEnc - tStart) | 0}ms push ${(tDone - tEnc) | 0}ms ${png.length}B`)
        continue
      }
      if (result === 'success') {
        renderErrCount = 0
        if (++renderOkCount === RENDER_HYSTERESIS && lastStatus === 'render error') {
          await setStatus('mirror on', /* persist */ false)
        }
      } else {
        renderOkCount = 0
        if (++renderErrCount === RENDER_HYSTERESIS && lastStatus !== 'render error') {
          await setStatus('render error')
        }
      }
    } catch {
      renderOkCount = 0
      if (++renderErrCount === RENDER_HYSTERESIS && lastStatus !== 'render error') {
        await setStatus('render error')
      }
    }
  }
}

// ── Menu rendering & navigation ──────────────────────────────────────────
function renderMenuText(menu: MenuView): string {
  const total = menu.items.length
  const lines: string[] = [menu.title, '']
  if (total === 0) {
    lines.push('(no items)')
    return lines.join('\n')
  }
  const half = MENU_VISIBLE_LINES >> 1
  let start = Math.max(0, menu.cursor - half)
  const end = Math.min(total, start + MENU_VISIBLE_LINES)
  start = Math.max(0, end - MENU_VISIBLE_LINES)
  if (start > 0) lines.push('  ↑ more')
  for (let i = start; i < end; i++) {
    const cursor = i === menu.cursor ? '> ' : '  '
    lines.push(cursor + menu.items[i]!.label)
  }
  if (end < total) lines.push('  ↓ more')
  return lines.join('\n')
}

async function redrawMenu(): Promise<void> {
  if (currentView.kind !== 'menu') return
  await bridge.textContainerUpgrade(new TextContainerUpgrade({
    containerID: ID_MAIN,
    content: renderMenuText(currentView.menu),
  }))
}

async function menuMove(delta: number): Promise<void> {
  if (currentView.kind !== 'menu') return
  const m = currentView.menu
  if (m.items.length === 0) return
  let i = m.cursor + delta
  while (i >= 0 && i < m.items.length && !m.items[i]!.selectable) i += delta
  if (i < 0 || i >= m.items.length) return
  m.cursor = i
  await redrawMenu()
}

async function menuSelect(): Promise<void> {
  if (currentView.kind !== 'menu') return
  const item = currentView.menu.items[currentView.menu.cursor]
  if (!item || !item.selectable || !item.action) return
  await item.action()
}

// Place cursor on the first selectable item, skipping leading separators.
function firstSelectable(items: MenuItem[]): number {
  for (let i = 0; i < items.length; i++) if (items[i]!.selectable) return i
  return 0
}

// ── Menus ────────────────────────────────────────────────────────────────
function makeBootMenu(message: string): MenuView {
  return {
    title: 'Flipctl',
    cursor: 0,
    back: async () => { /* noop */ },
    items: [{ label: message, selectable: false }],
  }
}

function homeMenu(): MenuView {
  const items: MenuItem[] = [
    { label: 'Favourites',   selectable: true, action: openFavouritesMenu },
    { label: 'Mirror',       selectable: true, action: enterMirror },
    { label: 'Standby Mode', selectable: true, action: openStandbyPicker },
    { label: 'Settings',     selectable: true, action: openSettingsMenu },
  ]
  return { title: 'Flipctl', cursor: firstSelectable(items), items, back: async () => { /* root */ } }
}

async function openHome(): Promise<void> {
  await applyView({ kind: 'menu', menu: homeMenu() })
}

async function openFavouritesMenu(): Promise<void> {
  await applyView({ kind: 'menu', menu: {
    title: 'Favourites', cursor: 0, back: openHome,
    items: [{ label: '── loading…', selectable: false }],
  }})
  const favs = await fetchFavorites()
  const items: MenuItem[] = []
  if (favs.length === 0) {
    items.push({ label: '(no favourites on Flipper)', selectable: false })
  } else {
    for (const f of favs) {
      items.push({
        label: f.name + (f.app ? `  · ${f.app}` : ''),
        selectable: true,
        action: async () => {
          await runFavourite(f)
          await enterMirror()
        },
      })
    }
  }
  items.push({ label: '── recovery', selectable: false })
  items.push({
    label: 'Exit Flipper app',
    selectable: true,
    action: async () => {
      await transport.send({ id: 'xa', kind: 'app.exit', label: '' }).catch(() => undefined)
      await openHome()
    },
  })
  items.push({ label: '── back', selectable: false })
  items.push({ label: 'Back', selectable: true, action: openHome })

  await applyView({ kind: 'menu', menu: {
    title: 'Favourites', cursor: firstSelectable(items), items, back: openHome,
  }})
}

async function openStandbyPicker(): Promise<void> {
  await applyView({ kind: 'menu', menu: {
    title: 'Standby — pick favourite', cursor: 0, back: openHome,
    items: [{ label: '── loading…', selectable: false }],
  }})
  const favs = await fetchFavorites()
  const items: MenuItem[] = []
  if (favs.length === 0) {
    items.push({ label: '(no favourites on Flipper)', selectable: false })
  } else {
    for (const f of favs) {
      items.push({
        label: f.name + (f.app ? `  · ${f.app}` : ''),
        selectable: true,
        action: async () => { await applyView({ kind: 'standby', fav: f, fired: false }) },
      })
    }
  }
  items.push({ label: '── back', selectable: false })
  items.push({ label: 'Back', selectable: true, action: openHome })

  await applyView({ kind: 'menu', menu: {
    title: 'Standby — pick favourite', cursor: firstSelectable(items), items, back: openHome,
  }})
}

function settingsMenu(): MenuView {
  const mp = MIRROR_POSITIONS.find(p => p.value === settings.mirrorPosition)?.label ?? settings.mirrorPosition
  const sc = STANDBY_CORNERS .find(c => c.value === settings.standbyCorner )?.label ?? settings.standbyCorner
  const co = COLOURS         .find(c => c.value === settings.colours       )?.label ?? settings.colours
  const items: MenuItem[] = [
    { label: `Mirror position  · ${mp}`, selectable: true, action: openMirrorPositionMenu },
    { label: `Standby corner  · ${sc}`,  selectable: true, action: openStandbyCornerMenu },
    { label: `Colours  · ${co}`,         selectable: true, action: openColoursMenu },
    { label: '── back', selectable: false },
    { label: 'Back', selectable: true, action: openHome },
  ]
  return { title: 'Settings', cursor: firstSelectable(items), items, back: openHome }
}

async function openSettingsMenu(): Promise<void> {
  await applyView({ kind: 'menu', menu: settingsMenu() })
}

async function openMirrorPositionMenu(): Promise<void> {
  const items: MenuItem[] = MIRROR_POSITIONS.map(p => ({
    label: (settings.mirrorPosition === p.value ? '◉ ' : '○ ') + p.label,
    selectable: true,
    action: async () => {
      settings.mirrorPosition = p.value
      saveSettings(settings)
      await openSettingsMenu()
    },
  }))
  items.push({ label: '── back', selectable: false })
  items.push({ label: 'Back', selectable: true, action: openSettingsMenu })
  await applyView({ kind: 'menu', menu: {
    title: 'Mirror position', cursor: firstSelectable(items), items, back: openSettingsMenu,
  }})
}

async function openStandbyCornerMenu(): Promise<void> {
  const items: MenuItem[] = STANDBY_CORNERS.map(c => ({
    label: (settings.standbyCorner === c.value ? '◉ ' : '○ ') + c.label,
    selectable: true,
    action: async () => {
      settings.standbyCorner = c.value
      saveSettings(settings)
      await openSettingsMenu()
    },
  }))
  items.push({ label: '── back', selectable: false })
  items.push({ label: 'Back', selectable: true, action: openSettingsMenu })
  await applyView({ kind: 'menu', menu: {
    title: 'Standby corner', cursor: firstSelectable(items), items, back: openSettingsMenu,
  }})
}

async function openColoursMenu(): Promise<void> {
  const items: MenuItem[] = COLOURS.map(c => ({
    label: (settings.colours === c.value ? '◉ ' : '○ ') + c.label,
    selectable: true,
    action: async () => {
      settings.colours = c.value
      saveSettings(settings)
      await openSettingsMenu()
    },
  }))
  items.push({ label: '── back', selectable: false })
  items.push({ label: 'Back', selectable: true, action: openSettingsMenu })
  await applyView({ kind: 'menu', menu: {
    title: 'Colours', cursor: firstSelectable(items), items, back: openSettingsMenu,
  }})
}

// ── Mirror, standby, exit actions ───────────────────────────────────────
async function enterMirror(): Promise<void> {
  await applyView({ kind: 'mirror' })
}

async function fireFavourite(fav: FavoriteRow): Promise<{ ok: boolean; message: string }> {
  return transport.send({ id: 'fr', kind: 'favorite.run', label: '', arg: fav.path })
}

async function runFavourite(fav: FavoriteRow): Promise<void> {
  await fireFavourite(fav)
}

async function exitApp(): Promise<void> {
  try { await stopStream() } catch { /* ignore */ }
  try { await bridge.shutDownPageContainer(0) } catch { /* ignore */ }
}

async function fetchFavorites(): Promise<FavoriteRow[]> {
  if (transport.name !== 'http') return []
  const baseUrl = (transport as { baseUrl?: string }).baseUrl ?? 'http://127.0.0.1:8765'
  try {
    const res = await fetch(`${baseUrl}/favorites`)
    if (!res.ok) return []
    const body = await res.json() as { favorites?: FavoriteRow[] }
    return body.favorites ?? []
  } catch {
    return []
  }
}

// ── Tap recording & dispatch ────────────────────────────────────────────
let tapCount = 0
let tapTimer: number | undefined

function recordTaps(n: number): void {
  tapCount += n
  if (tapTimer !== undefined) clearTimeout(tapTimer)
  tapTimer = window.setTimeout(() => {
    const final = tapCount
    tapCount = 0
    tapTimer = undefined
    void handleTaps(final)
  }, TAP_WAIT_MS)
}

async function handleTaps(final: number): Promise<void> {
  if (currentView.kind === 'menu') {
    if (final === 1) return menuSelect()
    return currentView.menu.back()
  }

  if (currentView.kind === 'standby') {
    const v = currentView
    if (final === 1) {
      await fireFavourite(v.fav)
      if (v.fired) return exitApp()  // second single tap repeats then dismisses
      v.fired = true
      await bridge.textContainerUpgrade(new TextContainerUpgrade({
        containerID: ID_MAIN, content: legendText(v.fav, true),
      }))
      return
    }
    return exitApp()                  // double-tap dismisses
  }

  // Mirror screen
  if (final >= MENU_OPEN_TAPS) return openHome()
  let cmd: Command
  if (final >= 3)        cmd = INPUT_RIGHT
  else if (final === 2)  cmd = INPUT_LEFT
  else                   cmd = INPUT_OK
  void transport.send(cmd).catch(() => undefined)
}

// ── Boot ─────────────────────────────────────────────────────────────────
void (async () => {
  // First-time page must use createStartUpPageContainer; subsequent layouts
  // come from rebuildPageContainer via applyView.
  await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({
    containerTotalNum: 2,
    textObject: [
      eventCapture(),
      fullCanvasText(ID_MAIN, 'Flipctl\n\nstarting…'),
    ],
  }))

  void fetcherLoop()
  void rendererLoop()

  try {
    await transport.connect()
    await openHome()
  } catch {
    // Bridge missing — show an actionable home screen with retry instead of
    // a blank "starting…" page that looks frozen.
    const items: MenuItem[] = [
      { label: 'Flipctl Bridge not detected', selectable: false },
      { label: 'Start the bridge on your phone', selectable: false },
      { label: '── retry', selectable: false },
      { label: 'Retry connection', selectable: true, action: async () => {
        try { await transport.connect(); await openHome() } catch { /* stay on retry screen */ }
      }},
    ]
    await applyView({ kind: 'menu', menu: {
      title: 'Flipctl', cursor: firstSelectable(items), items, back: async () => { /* noop */ },
    }})
  }
})()

// ── Event subscription ──────────────────────────────────────────────────
const unsubscribe = bridge.onEvenHubEvent(async event => {
  if (event.sysEvent) {
    const t = event.sysEvent.eventType ?? OsEventTypeList.CLICK_EVENT
    if (t === OsEventTypeList.SYSTEM_EXIT_EVENT || t === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      try { await stopStream() } catch { /* ignore */ }
      unsubscribe()
      return
    }
    if (t === OsEventTypeList.CLICK_EVENT)        { recordTaps(1); return }
    if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) { recordTaps(2); return }
  }
  if (event.textEvent) {
    const t = event.textEvent.eventType ?? OsEventTypeList.CLICK_EVENT
    if (currentView.kind === 'menu') {
      if (t === OsEventTypeList.SCROLL_TOP_EVENT)    { void menuMove(-1); return }
      if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) { void menuMove(+1); return }
      if (t === OsEventTypeList.DOUBLE_CLICK_EVENT)  { void currentView.menu.back(); return }
      return
    }
    if (currentView.kind === 'standby') {
      // Any non-tap interaction also dismisses (text double-click).
      if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) { void exitApp(); return }
      return
    }
    // Mirror
    if (t === OsEventTypeList.SCROLL_TOP_EVENT)    { void transport.send(INPUT_UP).catch(() => undefined);   return }
    if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) { void transport.send(INPUT_DOWN).catch(() => undefined); return }
    if (t === OsEventTypeList.DOUBLE_CLICK_EVENT)  { void transport.send(INPUT_BACK).catch(() => undefined); return }
  }
})
