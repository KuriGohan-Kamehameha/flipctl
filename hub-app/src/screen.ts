/**
 * Render a Flipper Zero raw screen frame (128×64, 1bpp, vertical-page LSB-top
 * — the SSD1306-style layout the firmware uses) into a PNG ready for
 * `bridge.updateImageRawData`.
 *
 * The G2 SDK accepts encoded PNG/JPEG bytes; it decodes, resizes and
 * converts to 4-bit greyscale internally — so we encode at the Flipper's
 * native 128×64 and let the SDK upscale to the ImageContainer's displayed
 * dimensions (MIRROR_W × MIRROR_H). Shipping native instead of pre-upscaling
 * to 256×128 cuts the JS-side PNG encode by ~4× and the WebView→host→BLE
 * payload by ~4×, at the cost of leaving final scaling to whatever filter
 * the SDK uses.
 */
const FW = 128, FH = 64
// Displayed mirror size on the HUD — owns the ImageContainer geometry in
// main.ts. The PNG bytes we ship are smaller (FW×FH); the SDK resizes.
export const MIRROR_W = 256
export const MIRROR_H = 128

// Render the app dimmer than the rest of the device — lit pixels go out at
// 70% of full intensity instead of 100%. The G2 SDK quantises to 4-bit grey
// (16 levels), so 178 maps roughly to grey level 11 of 15 instead of 15/15.
const BRIGHTNESS = 0.7
const LIT_VALUE = Math.round(255 * BRIGHTNESS)

const outCanvas = document.createElement('canvas')
outCanvas.width = FW
outCanvas.height = FH
const outCtx = outCanvas.getContext('2d')!
const outImg = outCtx.createImageData(FW, FH)

export async function flipperFrameToPng(flipper: Uint8Array, invert = false): Promise<Uint8Array> {
  const inv = invert ? 1 : 0
  const buf = outImg.data
  for (let y = 0; y < FH; y++) {
    const page = y >> 3
    const bit  = y & 7
    const pageOff = page * FW
    const rowOff = y * FW * 4
    for (let x = 0; x < FW; x++) {
      const lit = ((flipper[pageOff + x]! >> bit) & 1) ^ inv
      const o = rowOff + x * 4
      const v = lit ? LIT_VALUE : 0
      buf[o]     = v
      buf[o + 1] = v
      buf[o + 2] = v
      buf[o + 3] = 255
    }
  }
  outCtx.putImageData(outImg, 0, 0)
  const blob = await new Promise<Blob>((resolve, reject) => {
    outCanvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  })
  return new Uint8Array(await blob.arrayBuffer())
}
