// Persisted user preferences. Lives in localStorage so it survives reloads
// of the Hub webview without round-tripping through the bridge or the SDK.

export type MirrorPosition = 'tl' | 'tm' | 'tr' | 'c' | 'bl' | 'bm' | 'br'
export type StandbyCorner  = 'tl' | 'tr' | 'bl' | 'br'
export type Colours        = 'normal' | 'inverted'

export interface Settings {
  mirrorPosition: MirrorPosition
  standbyCorner:  StandbyCorner
  colours:        Colours
}

const KEY = 'flipctl.settings.v1'
const DEFAULTS: Settings = { mirrorPosition: 'c', standbyCorner: 'tr', colours: 'normal' }

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const p = JSON.parse(raw) as Partial<Settings>
    return {
      mirrorPosition: p.mirrorPosition ?? DEFAULTS.mirrorPosition,
      standbyCorner:  p.standbyCorner  ?? DEFAULTS.standbyCorner,
      colours:        p.colours        ?? DEFAULTS.colours,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* ignored */ }
}

export const MIRROR_POSITIONS: { value: MirrorPosition; label: string }[] = [
  { value: 'tl', label: 'Top left' },
  { value: 'tm', label: 'Top middle' },
  { value: 'tr', label: 'Top right' },
  { value: 'c',  label: 'Centre' },
  { value: 'bl', label: 'Bottom left' },
  { value: 'bm', label: 'Bottom middle' },
  { value: 'br', label: 'Bottom right' },
]

export const STANDBY_CORNERS: { value: StandbyCorner; label: string }[] = [
  { value: 'tl', label: 'Top left' },
  { value: 'tr', label: 'Top right' },
  { value: 'bl', label: 'Bottom left' },
  { value: 'br', label: 'Bottom right' },
]

export const COLOURS: { value: Colours; label: string }[] = [
  { value: 'normal',   label: 'Normal' },
  { value: 'inverted', label: 'Inverted' },
]
