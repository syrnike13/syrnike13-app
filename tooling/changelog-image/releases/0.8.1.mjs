import { call, cropper, emojiPicker, feed, sprite } from '../mockups.mjs'

const spider = sprite(
  ['#.#.#.#', '.#####.', '##e#e##', '.#####.', '#.#.#.#'],
  { '#': '#3a2659', e: '#f28c28' },
  0,
  25,
)

/** Halloween: night purple, pumpkin orange, a cobweb and a spider. */
export default {
  version: '0.8.1',
  theme: {
    colors: {
      bg: '#120a1c',
      fg: '#efe6ff',
      muted: '#a395bf',
      accent: '#f28c28',
      'accent-shadow': '#5b2a0c',
      surface: '#1d1230',
      'surface-strong': '#2b1a45',
      tile: '#20152e',
      online: '#4ade80',
      idle: '#f2c94c',
      danger: '#e5484d',
    },
    background: `<div style="position:absolute;inset:0;background:
      radial-gradient(1100px 500px at 50% 100%, rgba(242,140,40,.22), transparent 70%),
      radial-gradient(900px 600px at 90% 10%, rgba(164,110,224,.22), transparent 70%),
      linear-gradient(#120a1c,#1a0f27)"></div>`,
    decor: `
<svg style="position:absolute;left:520px;top:0;width:48px;height:200px" viewBox="0 0 7 30" shape-rendering="crispEdges">
  <line x1="3.5" y1="0" x2="3.5" y2="25" stroke="#8a77ad" stroke-width=".12"/>${spider}
</svg>
<svg style="position:absolute;right:0;top:0;width:340px;height:340px;opacity:.35" viewBox="0 0 100 100" fill="none" stroke="#efe6ff" stroke-width=".6">
  <path d="M100 0 L20 0 M100 0 L35 45 M100 0 L70 80 M100 0 L100 100"/>
  <path d="M80 0 Q84 10 88 12 Q94 16 100 20"/>
  <path d="M58 0 Q66 20 75 26 Q88 34 100 44"/>
  <path d="M38 0 Q48 30 60 40 Q80 54 100 68"/>
  <path d="M20 0 Q34 40 48 56 Q70 78 100 92"/>
</svg>`,
  },
  tiles: [
    {
      title: 'Эмодзи',
      body: emojiPicker({
        query: 'призрак',
        emoji: ['👻', '🎃', '🦇', '🕸️', '🍬', '🕯️', '💀', '🧙', '🍭', '🌕', '🕷️', '⚰️'],
      }),
    },
    { title: 'Кроп', body: cropper() },
    {
      title: 'Звонки',
      body: call({
        people: [
          { letter: 'Т', color: '#a46ee0', speaking: true },
          { letter: 'Ж', color: '#f28c28' },
          { letter: 'С', color: '#6c8f2e', speaking: true },
        ],
      }),
    },
    {
      title: 'Новый вид',
      body: feed({
        messages: [
          { letter: 'Т', color: '#a46ee0', name: 'тыква', nameColor: '#c9a6ff', time: 'сегодня в 23:59', text: 'бу 👻', status: 'online' },
          { letter: 'Ж', color: '#f28c28', name: 'жнец', nameColor: '#ffb05c', time: 'сегодня в 00:00', text: 'а-а-а 🎃🎃', status: 'idle', unread: 3 },
        ],
      }),
    },
  ],
}
