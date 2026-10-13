/**
 * npm run icon — offline SVG → PNG / multi-resolution ICO / 24-bit BMP + proof.
 * Requires Python 3.12 and packages pinned in scripts/requirements-brand.txt.
 * Setup if needed: python -m pip install -r scripts/requirements-brand.txt
 * Set PYTHON to override the interpreter. Uses existing React / TypeScript packages.
 * Sources: resources/brand/*.svg and the actual React illustration components.
 */
import fs from 'node:fs/promises'
import { mkdtempSync, writeFileSync, openSync, closeSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resource = (file) => path.join(root, 'resources', file)
const read = (file) => fs.readFile(file, 'utf8')
const appSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const traySizes = [16, 20, 24, 32]

function raster(jobs) {
  const tempRoot = path.resolve(os.tmpdir())
  const dir = mkdtempSync(path.join(tempRoot, 'octopus-brand-'))
  const input = path.join(dir, 'input.json')
  const output = path.join(dir, 'output.json')
  const error = path.join(dir, 'error.log')
  const handles = []
  try {
    writeFileSync(input, JSON.stringify(jobs))
    handles.push(openSync(input, 'r'), openSync(output, 'w'), openSync(error, 'w'))
    // File handles also work in Windows environments that restrict named pipes.
    const child = spawnSync(process.env.PYTHON || 'python', [path.join(root, 'scripts/render-brand.py')], {
      stdio: handles, windowsHide: true, timeout: 120_000,
    })
    if (child.error) throw child.error
    if (child.status !== 0) throw new Error(readFileSync(error, 'utf8').split('\n').slice(-30).join('\n'))
    return JSON.parse(readFileSync(output, 'utf8')).map((png) => Buffer.from(png, 'base64'))
  } finally {
    handles.forEach(closeSync)
    if (path.dirname(path.resolve(dir)) !== tempRoot || !path.basename(dir).startsWith('octopus-brand-')) {
      throw new Error(`Unexpected temporary directory: ${dir}`)
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

function ico(frames) {
  const header = Buffer.alloc(6 + frames.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)
  let offset = header.length
  frames.forEach(({ size, png }, index) => {
    const at = 6 + index * 16
    header[at] = header[at + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(png.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...frames.map(({ png }) => png)])
}

async function illustrationMarkup() {
  const ts = require('typescript')
  const source = await read(path.join(root, 'src/renderer/src/components/illustrations.tsx'))
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const module = { exports: {} }
  // Evaluate only this local, trusted component module; no app or store imports.
  new Function('require', 'module', 'exports', compiled.outputText)(require, module, module.exports)
  const components = module.exports
  const { createElement } = require('react')
  const { renderToStaticMarkup } = require('react-dom/server')
  const names = ['InboxZero', 'NoSelection', 'NoResults', 'NoDrafts', 'NoScheduled', 'NoContact', 'Welcome', 'AskAI']
  return names.map((name) => ({ name, svg: renderToStaticMarkup(createElement(components[name])) }))
}

function themeTokens(css, selector) {
  const block = css.match(selector)?.[1]
  if (!block) throw new Error(`Missing theme: ${selector}`)
  return Object.fromEntries(Array.from(block.matchAll(/(--[\w-]+):\s*([^;]+);/g), ([, key, value]) => [key, value.trim()]))
}

function resolveTokens(svg, tokens) {
  return svg.replace(/var\((--[\w-]+)\)/g, (_, name) => {
    if (!tokens[name]) throw new Error(`Missing theme token ${name}`)
    return tokens[name]
  })
}

function placeSvg(svg, x, y, width, height) {
  const [, attributes, content] = svg.match(/<svg\b([^>]*)>([^]*)<\/svg>/) || []
  const viewBox = attributes?.match(/viewBox="([^"]+)"/)?.[1].split(/\s+/).map(Number)
  if (!viewBox || viewBox.length !== 4) throw new Error('SVG source must define a viewBox')
  const scale = Math.min(width / viewBox[2], height / viewBox[3])
  const dx = x + (width - viewBox[2] * scale) / 2
  const dy = y + (height - viewBox[3] * scale) / 2
  return `<g transform="translate(${dx} ${dy}) scale(${scale}) translate(${-viewBox[0]} ${-viewBox[1]})" fill="none">${content}</g>`
}

function proofSvg(appFrames, trayFrames, unreadFrames, illustrations, themes, installerPng) {
  const text = (x, y, value, color, size = 12, weight = 400) =>
    `<text x="${x}" y="${y}" fill="${color}" font-family="Arial, sans-serif" font-size="${size}" font-weight="${weight}">${value}</text>`
  const image = (x, y, w, h, png) => `<image x="${x}" y="${y}" width="${w}" height="${h}" xlink:href="data:image/png;base64,${png.toString('base64')}"/>`
  const sample = (frames, size, x, y, color) => image(x, y, size, size, frames.find((f) => f.size === size).png) + text(x, y + size + 18, `${size} px`, color, 10)
  const content = [
    '<rect width="1200" height="1560" fill="#eeedf5"/>',
    text(40, 49, 'Octopus Mail', '#292538', 28, 600),
    text(40, 74, 'Identyfikacja wizualna / SVG / Windows / jasny i ciemny motyw', '#6b6b78', 13),
    text(959, 49, 'ARKUSZ PODGLĄDU', '#6b6b78', 11),
  ]
  themes.forEach((theme, i) => {
    const x = 24 + i * 584
    const t = theme.tokens
    const muted = t['--muted']
    content.push(`<rect x="${x}" y="100" width="568" height="1232" rx="16" fill="${t['--bg']}" stroke="${t['--border']}"/>`)
    content.push(text(x + 24, 137, theme.name, t['--text'], 18, 600), text(x + 365, 137, '01 / ZNAK APLIKACJI', muted, 10))
    content.push(sample(appFrames, 256, x + 36, 166, muted))
    ;[[64, 336, 178], [48, 438, 194], [32, 346, 290], [24, 450, 298], [16, 354, 368]].forEach(([size, dx, y]) => content.push(sample(appFrames, size, x + dx, y, muted)))
    content.push(`<path d="M${x + 24} 462H${x + 544}M${x + 24} 574H${x + 544}" stroke="${t['--border']}"/>`)
    content.push(text(x + 24, 487, '02 / ZASOBNIK', muted, 10), text(x + 300, 487, 'NOWA POCZTA', muted, 10))
    ;[16, 24, 32].forEach((size, index) => {
      content.push(sample(trayFrames, size, x + 36 + index * 74, 530 - size, muted))
      content.push(sample(unreadFrames, size, x + 312 + index * 74, 530 - size, muted))
    })
    content.push(text(x + 24, 605, '03 / PUSTE STANY', muted, 10))
    illustrations.forEach((scene, index) => {
      const sx = x + 52 + (index % 2) * 260
      const sy = 620 + Math.floor(index / 2) * 174
      // Render the same component geometry at its actual UI dimensions.
      const svg = placeSvg(resolveTokens(scene.svg, t), sx, sy, 176, 141)
      content.push(svg, text(sx + 50, sy + 158, scene.name, muted, 11))
    })
  })
  content.push('<rect x="24" y="1354" width="1152" height="184" rx="16" fill="#e5e2ef"/>')
  content.push(image(48, 1367, 82, 157, installerPng), text(160, 1400, 'Jeden znak. Osiem spokojnych scen.', '#292538', 19, 600))
  content.push(text(160, 1431, 'Ikony w rzeczywistych rozmiarach. Osobny rysunek dla 16–32 px.', '#6b6b78', 13))
  content.push(text(160, 1456, 'Ilustracje: komponenty React, kolory bezpośrednio z index.css.', '#6b6b78', 13))
  content.push(text(160, 1481, 'Instalator: podgląd 50% / BMP 164 × 314 px, 24 bity. Eksport: npm run icon.', '#6b6b78', 13))
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="1560" viewBox="0 0 1200 1560">${content.join('')}</svg>`
}

const icon = await read(resource('brand/icon.svg'))
const small = await read(resource('brand/icon-small.svg'))
const tray = await read(resource('brand/tray.svg'))
const unread = tray.replace('</svg>', '<circle cx="25" cy="7" r="5.3" fill="#5b4cf0" stroke="#f6f4ff" stroke-width="1.8"/></svg>')
const frames = (sizes, source) => {
  const pngs = raster(sizes.map((size) => ({ svg: source(size), width: size, height: size })))
  return sizes.map((size, index) => ({ size, png: pngs[index] }))
}
const appFrames = frames(appSizes, (size) => size <= 32 ? small : icon)
const trayFrames = frames(traySizes, () => tray)
const unreadFrames = frames(traySizes, () => unread)
const [iconPng] = raster([{ svg: icon, width: 512, height: 512 }])
const installer = (await read(resource('brand/installer-sidebar.svg'))).replace('<g id="brand-icon"/>',
  placeSvg(icon, 32, 73, 100, 100))
const [installerPng, installerBmp] = raster([
  { svg: installer, width: 164, height: 314 }, { svg: installer, width: 164, height: 314, format: 'bmp' },
])
const css = await read(path.join(root, 'src/renderer/src/index.css'))
const themes = [
  { name: 'Motyw jasny', tokens: themeTokens(css, /:root\s*\{([^]*?)\}/) },
  { name: 'Motyw ciemny', tokens: themeTokens(css, /\[data-theme="dark"\]\s*\{([^]*?)\}/) },
]
const proof = proofSvg(appFrames, trayFrames, unreadFrames, await illustrationMarkup(), themes, installerPng)
const [preview] = raster([{ svg: proof, width: 1200, height: 1560 }])
const logo = small.replace(/<!--[^]*?-->/g, '').replace(/>\s+</g, '><').trim() + '\n'
await fs.mkdir(path.join(root, 'src/renderer/src/assets'), { recursive: true })
await fs.mkdir(path.join(root, 'out'), { recursive: true })
// Write only after every source has rendered successfully.
for (const [file, buffer] of [
  [resource('icon.png'), iconPng], [resource('icon.ico'), ico(appFrames)],
  [resource('tray.ico'), ico(trayFrames)], [resource('tray-unread.ico'), ico(unreadFrames)],
  // Linux/macOS trays take PNG (ICO works only on Windows)
  [resource('tray.png'), trayFrames.find((f) => f.size === 32).png], [resource('tray-unread.png'), unreadFrames.find((f) => f.size === 32).png],
  [resource('brand/tray-unread.svg'), unread], [resource('installerSidebar.bmp'), installerBmp],
  [path.join(root, 'src/renderer/src/assets/logo.svg'), logo], [path.join(root, 'out/brand-preview.png'), preview],
]) await fs.writeFile(file, buffer)
console.log('OK: icon.png (512), icon.ico (16/20/24/32/40/48/64/128/256), tray + unread (ICO 16/20/24/32, PNG 32)')
console.log('OK: logo.svg, tray-unread.svg, installerSidebar.bmp (164×314, 24-bit), out/brand-preview.png')
