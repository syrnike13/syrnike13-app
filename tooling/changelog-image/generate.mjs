#!/usr/bin/env node
/**
 * Renders a 1600 × 900 changelog image for a release post.
 *
 *   node tooling/changelog-image/generate.mjs tooling/changelog-image/releases/0.8.1.mjs
 *
 * A release file default-exports { version, theme, tiles }; see releases/ and
 * README.md. Output goes to tooling/changelog-image/out/<version>.{html,png}.
 * Chrome is taken from $CHROME or the usual install paths.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MOCKUP_CSS } from './mockups.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const fileUrl = (p) => pathToFileURL(path.join(repo, p)).href

const releasePath = process.argv[2]
if (!releasePath) {
  console.error('usage: generate.mjs <release-file.mjs>')
  process.exit(1)
}
const { default: release } = await import(pathToFileURL(path.resolve(releasePath)).href)
const { version, theme, tiles } = release

const fontsCss = fs
  .readFileSync(path.join(repo, 'apps/landing/src/fonts.css'), 'utf8')
  .replaceAll('url(/fonts/', `url(${fileUrl('apps/landing/public/fonts')}/`)

const vars = Object.entries(theme.colors)
  .map(([name, value]) => `--${name}:${value};`)
  .join('')

const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>
${fontsCss}
:root{${vars}}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1600px;height:900px;background:var(--bg);overflow:hidden}
body{font-family:'Nunito Sans','Segoe UI Emoji',sans-serif;color:var(--fg);position:relative}
.grid{position:absolute;inset:0;opacity:.06;
  background-image:linear-gradient(var(--fg) 1px,transparent 1px),linear-gradient(90deg,var(--fg) 1px,transparent 1px);
  background-size:24px 24px}
.content{position:absolute;left:72px;top:56px;right:72px;bottom:64px;display:flex;flex-direction:column}
.brand{display:flex;align-items:center;gap:14px;font-family:'Space Grotesk';font-weight:600;font-size:26px;color:var(--muted)}
.brand img{width:40px;height:40px;image-rendering:pixelated}
.version{margin-top:6px;font-family:'Space Grotesk';font-weight:700;font-size:150px;line-height:1;letter-spacing:-.04em;
  color:var(--accent);text-shadow:7px 7px 0 var(--accent-shadow),0 0 60px color-mix(in srgb,var(--accent) 35%,transparent)}
.tiles{margin-top:36px;display:grid;grid-template-columns:repeat(${tiles.length},1fr);gap:20px;flex:1}
.tile{position:relative;border-radius:18px;background:color-mix(in srgb,var(--fg) 5%,transparent);
  border:1px solid color-mix(in srgb,var(--fg) 10%,transparent);padding:24px;display:flex;flex-direction:column;overflow:hidden}
.tile h3{font-weight:900;font-size:26px;margin-bottom:12px}
.stage{flex:1;display:flex;align-items:center;justify-content:center}
.stage>*{zoom:1.3}
${MOCKUP_CSS}
${theme.css ?? ''}
</style></head><body>
${theme.background ?? ''}<div class="grid"></div>${theme.decor ?? ''}
<div class="content">
  <div class="brand"><img src="${fileUrl('apps/web/public/app-logo.png')}">syrnike13</div>
  <div class="version">${version}</div>
  <div class="tiles">
    ${tiles.map((t) => `<div class="tile"><h3>${t.title}</h3><div class="stage">${t.body}</div></div>`).join('')}
  </div>
</div>
</body></html>`

const outDir = path.join(here, 'out')
fs.mkdirSync(outDir, { recursive: true })
const htmlPath = path.join(outDir, `${version}.html`)
const pngPath = path.join(outDir, `${version}.png`)
fs.writeFileSync(htmlPath, html)

const chrome = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && fs.existsSync(p))
if (!chrome) {
  console.error(`Chrome not found; set CHROME. HTML is at ${htmlPath}`)
  process.exit(1)
}

execFileSync(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--allow-file-access-from-files',
    '--force-device-scale-factor=1',
    '--window-size=1600,900',
    '--virtual-time-budget=3000',
    `--screenshot=${pngPath}`,
    pathToFileURL(htmlPath).href,
  ],
  { stdio: 'ignore' },
)
console.log(pngPath)
