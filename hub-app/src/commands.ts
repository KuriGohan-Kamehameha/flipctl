export interface Command {
  id: string
  kind: string
  arg?: string
  label: string
}

/**
 * Mirror-mode commands. The ring acts as a remote D-pad/OK/Back for whatever
 * Flipper UI is currently active, by injecting synthetic InputEvents.
 */
export const INPUT_UP:        Command = { id: 'in-up',    kind: 'input.up',        label: 'Up' }
export const INPUT_DOWN:      Command = { id: 'in-down',  kind: 'input.down',      label: 'Down' }
export const INPUT_LEFT:      Command = { id: 'in-left',  kind: 'input.left',      label: 'Left' }
export const INPUT_RIGHT:     Command = { id: 'in-rt',    kind: 'input.right',     label: 'Right' }
export const INPUT_OK:        Command = { id: 'in-ok',    kind: 'input.ok',        label: 'OK' }
export const INPUT_BACK:      Command = { id: 'in-back',  kind: 'input.back',      label: 'Back' }
export const INPUT_LONG_BACK: Command = { id: 'in-lb',    kind: 'input.long_back', label: 'Long Back' }
