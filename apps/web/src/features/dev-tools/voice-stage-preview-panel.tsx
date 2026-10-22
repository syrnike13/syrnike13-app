// design-allow-file hardcoded-string: internal developer tools panel.
import { Button } from '@syrnike13/ui/primitives/button'
import { Switch } from '@syrnike13/ui/primitives/switch'

import {
  HeadphoneOffIcon,
  HeadphonesIcon,
  MicIcon,
  MicOffIcon,
  MonitorUpIcon,
  MonitorXIcon,
  RefreshIcon,
} from '#/components/icons'
import {
  DEV_VOICE_GHOST_PROFILES,
  resetDevVoiceGhosts,
  setAllGhostsDeafened,
  setAllGhostsMuted,
  setGhostDeafened,
  setGhostDemo,
  setGhostMuted,
  setGhostPresent,
  setGhostSpeakingPulse,
  useDevVoiceGhostsState,
} from '#/features/voice/dev-voice-stage-ghosts'
import { cn } from '#/lib/utils'

export function VoiceStagePreviewPanel() {
  const state = useDevVoiceGhostsState()
  const activeIds = new Set(state.activeIds)

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">Voice stage ghosts</p>
        <p className="text-xs text-muted-foreground">
          Visual-only participants. Nothing is sent to the server.
        </p>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs font-medium">
          Participants {state.activeIds.length}/{DEV_VOICE_GHOST_PROFILES.length}
        </span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="gap-1"
          onClick={resetDevVoiceGhosts}
        >
          <RefreshIcon className="size-3" />
          Reset
        </Button>
      </div>

      <label className="mt-3 flex items-center justify-between gap-2 text-xs">
        <span>Speaking pulse</span>
        <Switch
          checked={state.speakingPulse}
          aria-label="Toggle ghost speaking pulse"
          onCheckedChange={setGhostSpeakingPulse}
        />
      </label>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => setAllGhostsMuted(true)}
        >
          Mute all
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => setAllGhostsMuted(false)}
        >
          Unmute all
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => setAllGhostsDeafened(true)}
        >
          Deafen all
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => setAllGhostsDeafened(false)}
        >
          Undeafen all
        </Button>
      </div>

      <ul className="mt-3 space-y-1">
        {DEV_VOICE_GHOST_PROFILES.map((profile) => {
          const active = activeIds.has(profile.id)
          const status = state.statuses[profile.id]
          if (!status) return null

          return (
            <li
              key={profile.id}
              className={cn(
                'flex items-center gap-2 rounded-lg border border-border px-2 py-1.5',
                !active && 'opacity-45',
              )}
            >
              <Switch
                checked={active}
                aria-label={`${active ? 'Hide' : 'Show'} ${profile.displayName}`}
                onCheckedChange={(checked) =>
                  setGhostPresent(profile.id, checked)
                }
              />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {profile.displayName}
              </span>
              <Button
                type="button"
                size="icon-xs"
                variant={status.muted ? 'secondary' : 'ghost'}
                aria-label={`${status.muted ? 'Unmute' : 'Mute'} ${profile.displayName}`}
                aria-pressed={status.muted}
                title={status.muted ? 'Unmute' : 'Mute'}
                disabled={!active}
                onClick={() => setGhostMuted(profile.id, !status.muted)}
              >
                {status.muted ? (
                  <MicOffIcon className="size-3.5" />
                ) : (
                  <MicIcon className="size-3.5" />
                )}
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant={status.deafened ? 'secondary' : 'ghost'}
                aria-label={`${status.deafened ? 'Undeafen' : 'Deafen'} ${profile.displayName}`}
                aria-pressed={status.deafened}
                title={status.deafened ? 'Undeafen' : 'Deafen'}
                disabled={!active}
                onClick={() =>
                  setGhostDeafened(profile.id, !status.deafened)
                }
              >
                {status.deafened ? (
                  <HeadphoneOffIcon className="size-3.5" />
                ) : (
                  <HeadphonesIcon className="size-3.5" />
                )}
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant={status.demo ? 'secondary' : 'ghost'}
                aria-label={`${status.demo ? 'Stop' : 'Start'} ${profile.displayName}'s demo`}
                aria-pressed={status.demo}
                title={status.demo ? 'Stop demo' : 'Start demo'}
                disabled={!active}
                onClick={() => setGhostDemo(profile.id, !status.demo)}
              >
                {status.demo ? (
                  <MonitorXIcon className="size-3.5" />
                ) : (
                  <MonitorUpIcon className="size-3.5" />
                )}
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
