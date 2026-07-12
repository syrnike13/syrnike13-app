import { spawn } from 'node:child_process'

const channels = {
  nightly: {
    desktopChannel: 'nightly',
    webScript: 'dev:nightly',
  },
  prod: {
    desktopChannel: 'stable',
    webScript: 'dev:prod',
  },
}

const mode = process.argv[2]
const channel = channels[mode]

if (!channel) {
  console.error('Usage: node scripts/run-dev-channel.mjs <nightly|prod>')
  process.exit(1)
}

const env = {
  ...process.env,
  SYRNIKE_DESKTOP_CHANNEL: channel.desktopChannel,
}

if (process.env.SYRNIKE_DESKTOP_DEV_DRY_RUN === '1') {
  console.log(
    JSON.stringify({
      desktopChannel: channel.desktopChannel,
      webScript: channel.webScript,
    }),
  )
  process.exit(0)
}

function run(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      env,
      shell: true,
      stdio: 'inherit',
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited by ${signal}`))
        return
      }
      if (code) {
        reject(new Error(`${command} exited with ${code}`))
        return
      }
      resolve()
    })
  })
}

await run('pnpm run build:shell')
await run(
  [
    'pnpm exec concurrently -k -n web,electron',
    `"pnpm --filter @syrnike13/web ${channel.webScript}"`,
    '"wait-on http-get://127.0.0.1:3000 && pnpm exec electron ."',
  ].join(' '),
)
