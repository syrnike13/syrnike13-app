const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')

const {
  loadContentionRenderer,
} = require('./media-contention-runner.cjs')

test('waits for both page load and matching shared texture receiver readiness', async () => {
  const ipcMain = new EventEmitter()
  const window = new EventEmitter()
  window.webContents = { id: 17 }
  let finishLoad
  window.loadURL = () => new Promise((resolve) => {
    finishLoad = resolve
  })

  let completed = false
  const loading = loadContentionRenderer({ ipcMain }, window, 'data:text/html,test')
    .then(() => { completed = true })

  ipcMain.emit('syrnike-contention-renderer-ready', {
    sender: { id: 18 },
  })
  finishLoad()
  await Promise.resolve()
  assert.equal(completed, false)

  ipcMain.emit('syrnike-contention-renderer-ready', {
    sender: window.webContents,
  })
  await loading

  assert.equal(completed, true)
  assert.equal(ipcMain.listenerCount('syrnike-contention-renderer-ready'), 0)
})
