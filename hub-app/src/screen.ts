/**
 * Render a Flipper Zero raw screen frame (128×64, 1bpp, vertical-page LSB-top
 * — the SSD1306-style layout the firmware uses) into a PNG ready for
 * `bridge.updateImageRawData`.
 *
 * The G2 SDK accepts encoded PNG/JPEG bytes; it decodes, resizes and
 * converts to 4-bit greyscale internally — so we don't pack bits ourselves,
 * we just paint pixels onto a canvas and PNG-encode it.
 */
const FW = 128, FH = 64
const OUT_W = 192
const OUT_H = 96

// Render the app dimmer than the rest of the device — lit pixels go out at
// 70% of full intensity instead of 100%. The G2 SDK quantises to 4-bit grey
// (16 levels), so 178 maps roughly to grey level 11 of 15 instead of 15/15.
const BRIGHTNESS = 0.7
const LIT_VALUE = Math.round(255 * BRIGHTNESS)

// Two canvases: a 128×64 source we paint pixels onto, and a 256×128 output
// the source gets drawImage'd onto with image-smoothing disabled (nearest-
// neighbour). The output is what gets PNG-encoded — its dimensions match the
// ImageContainerProperty so the SDK doesn't have to guess.
const srcCanvas = document.createElement('canvas')
srcCanvas.width = FW
srcCanvas.height = FH
const srcCtx = srcCanvas.getContext('2d')!
const srcImg = srcCtx.createImageData(FW, FH)

const outCanvas = document.createElement('canvas')
outCanvas.width = OUT_W
outCanvas.height = OUT_H
const outCtx = outCanvas.getContext('2d')!
outCtx.imageSmoothingEnabled = false

export async function flipperFrameToPng(flipper: Uint8Array): Promise<Uint8Array> {
  const buf = srcImg.data
  for (let y = 0; y < FH; y++) {
    const page = y >> 3
    const bit  = y & 7
    const pageOff = page * FW
    const rowOff = y * FW * 4
    for (let x = 0; x < FW; x++) {
      const lit = (flipper[pageOff + x]! >> bit) & 1
      const o = rowOff + x * 4
      const v = lit ? LIT_VALUE : 0
      buf[o]     = v
      buf[o + 1] = v
      buf[o + 2] = v
      buf[o + 3] = 255
    }
  }
  srcCtx.putImageData(srcImg, 0, 0)
  outCtx.imageSmoothingEnabled = false
  outCtx.drawImage(srcCanvas, 0, 0, OUT_W, OUT_H)
  const blob = await new Promise<Blob>((resolve, reject) => {
    outCanvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  })
  return new Uint8Array(await blob.arrayBuffer())
}
