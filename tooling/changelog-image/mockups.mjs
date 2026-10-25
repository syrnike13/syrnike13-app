/**
 * Small HTML mockups of app UI for changelog tiles, plus pixel-art helpers.
 * Mockups read the theme's CSS variables; their styles are in MOCKUP_CSS.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(repo, 'apps/web/package.json'))
const lucide = require('@iconify-json/lucide/icons.json')

export const icon = (name, size = 24) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24">${lucide.icons[name].body}</svg>`

/** Pixel art: each row character is a cell, characters missing from the palette are transparent. */
export const sprite = (rows, palette, ox = 0, oy = 0) =>
  rows
    .flatMap((row, y) =>
      [...row].map((c, x) =>
        palette[c]
          ? `<rect x="${ox + x}" y="${oy + y}" width="1.02" height="1.02" fill="${palette[c]}"/>`
          : '',
      ),
    )
    .join('')

/** The 20 × 26 logo sprite from the web app. */
export const logoPixels = () =>
  [
    ...fs
      .readFileSync(path.join(repo, 'apps/web/src/components/layout/cake-logo-data.ts'), 'utf8')
      .matchAll(/x:\s*(\d+),\s*y:\s*(\d+),\s*fill:\s*'(#[0-9a-f]{6})'/gi),
  ]
    .map(([, x, y, fill]) => `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${fill}"/>`)
    .join('')

export const emojiPicker = ({ query, emoji }) => `<div class="picker">
  <div class="search">${icon('search', 18)}<span>${query}</span></div>
  <div class="emoji">${emoji.map((e, i) => `<i class="${i === 0 ? 'on' : ''}">${e}</i>`).join('')}</div>
</div>`

export const cropper = () => `<div class="crop">
  <svg viewBox="-3 -2 26 30" shape-rendering="crispEdges">${logoPixels()}</svg>
  <div class="hole"></div>
  <div class="bar"><div></div></div>
</div>`

const avatar = ({ letter, color, speaking }) =>
  `<b class="av${speaking ? ' speak' : ''}" style="background:${color}">${letter}</b>`

export const call = ({ people }) => `<div class="call">
  <div class="people">${people.map(avatar).join('')}</div>
  <div class="ctrls"><i>${icon('mic')}</i><i>${icon('headphones')}</i><i>${icon('monitor-up')}</i><i class="end">${icon('phone-off')}</i></div>
</div>`

/** Messages: { letter, color, name, nameColor, time, text, status?: 'online' | 'idle', unread? } */
export const feed = ({ messages }) => `<div class="feed">${messages
  .map(
    (m) => `<div class="msg"><b class="av" style="background:${m.color}">${m.letter}${
      m.status ? `<s class="${m.status}"></s>` : ''
    }${m.unread ? `<u>${m.unread}</u>` : ''}</b><div><p><em style="color:${m.nameColor}">${m.name}</em><small>${m.time}</small></p><p>${m.text}</p></div></div>`,
  )
  .join('')}</div>`

export const MOCKUP_CSS = `
.picker{width:230px;background:var(--surface);border-radius:12px;padding:10px;border:1px solid color-mix(in srgb,var(--fg) 8%,transparent)}
.search{display:flex;gap:8px;align-items:center;height:34px;padding:0 10px;border-radius:8px;background:var(--bg);color:var(--muted);font-size:16px}
.emoji{margin-top:8px;display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.emoji i{font-style:normal;font-size:30px;text-align:center;line-height:44px;border-radius:8px}
.emoji i.on{background:color-mix(in srgb,var(--accent) 25%,transparent);outline:2px solid var(--accent)}
.crop{position:relative;width:190px;height:190px;border-radius:10px;overflow:hidden;background:var(--surface-strong)}
.crop svg{width:100%;height:100%}
.crop .hole{position:absolute;left:20px;top:16px;width:150px;height:150px;border-radius:50%;box-shadow:0 0 0 200px rgba(10,5,18,.62);outline:2px dashed var(--fg);outline-offset:-1px}
.crop .bar{position:absolute;left:14px;right:14px;bottom:8px;height:6px;border-radius:3px;background:color-mix(in srgb,var(--fg) 20%,transparent)}
.crop .bar div{width:60%;height:100%;border-radius:3px;background:var(--accent)}
.av{position:relative;display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;font-weight:900;font-size:22px;color:var(--bg);flex:none}
.call{display:flex;flex-direction:column;align-items:center;gap:18px}
.people{display:flex;gap:14px}
.people .av{width:64px;height:64px}
.av.speak{box-shadow:0 0 0 3px var(--bg),0 0 0 6px var(--online)}
.ctrls{display:flex;gap:10px}
.ctrls i{display:flex;align-items:center;justify-content:center;width:52px;height:52px;border-radius:50%;background:var(--surface-strong);color:var(--fg)}
.ctrls i.end{width:72px;border-radius:26px;background:var(--danger)}
.feed{width:230px;display:flex;flex-direction:column;gap:14px}
.msg{display:flex;gap:14px;align-items:flex-start}
.msg .av{width:48px;height:48px;font-size:19px}
.msg s{position:absolute;right:-3px;bottom:-3px;width:18px;height:18px;border-radius:50%;background:var(--online);border:4px solid var(--tile)}
.msg s.idle{background:var(--idle)}
.msg u{position:absolute;right:-6px;top:-4px;text-decoration:none;min-width:22px;height:22px;padding:0 5px;border-radius:11px;background:var(--danger);color:#fff;font-size:13px;font-weight:900;line-height:16px;text-align:center;border:3px solid var(--tile)}
.msg p{font-size:18px;color:var(--fg)}
.msg em{font-style:normal;font-weight:800;margin-right:8px}
.msg small{font-size:13px;color:var(--muted)}
`
