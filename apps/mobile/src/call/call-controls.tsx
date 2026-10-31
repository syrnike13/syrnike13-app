import type { VoiceDirector, VoiceSnapshot } from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { useState } from 'react'
import { PermissionsAndroid, View } from 'react-native'

import {
  MicIcon,
  MicOffIcon,
  MonitorUpIcon,
  MonitorXIcon,
  PhoneOffIcon,
  SwitchCameraIcon,
  VideoIcon,
  VideoOffIcon,
} from '../components/icons/registry'
import type { CameraFacing } from '../voice/livekit-engine'

function isOn(media: VoiceSnapshot['camera']) {
  return media.state === 'running' || media.state === 'starting'
}

/**
 * Discord's call dock: a rounded card with a grab handle and evenly spaced
 * 24dp icons; only "leave" has a surface, a red 48dp rounded square.
 */
export function CallDock({
  director,
  snapshot,
  onUse,
}: {
  director: VoiceDirector
  snapshot: VoiceSnapshot
  /** Called on every press so the stage keeps the controls visible. */
  onUse: () => void
}) {
  const t = useTranslations('mobile.voice')
  const [facing, setFacing] = useState<CameraFacing>('user')
  const cameraOn = isOn(snapshot.camera)
  const screenOn = isOn(snapshot.screen)

  function setCamera(enabled: boolean, deviceId: CameraFacing = facing) {
    setFacing(deviceId)
    director.dispatch({ type: 'setCamera', enabled, deviceId })
  }

  async function toggleCamera() {
    if (cameraOn) return setCamera(false)
    const permission = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA)
    if (permission === 'granted') setCamera(true)
  }

  function use(action: () => void) {
    return () => {
      onUse()
      action()
    }
  }

  return (
    <View className="rounded-3xl border border-border bg-card px-4 pt-2 pb-3">
      <View className="mb-2 h-1 w-10 self-center rounded-full bg-muted-foreground/40" />
      <View className="flex-row items-center justify-between">
        <Button
          variant="ghost"
          size="icon-xl"
          accessibilityLabel={t(cameraOn ? 'stopCamera' : 'camera')}
          onPress={use(() => void toggleCamera())}
        >
          {cameraOn ? <VideoIcon size={24} /> : <VideoOffIcon size={24} />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xl"
          accessibilityLabel={t(snapshot.userMuted ? 'unmute' : 'mute')}
          onPress={use(() => director.dispatch({ type: 'setUserMuted', muted: !snapshot.userMuted }))}
        >
          {snapshot.userMuted ? <MicOffIcon size={24} className="text-destructive" /> : <MicIcon size={24} />}
        </Button>
        {cameraOn ? (
          <Button
            variant="ghost"
            size="icon-xl"
            accessibilityLabel={t('flipCamera')}
            onPress={use(() => setCamera(true, facing === 'user' ? 'environment' : 'user'))}
          >
            <SwitchCameraIcon size={24} />
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xl"
          accessibilityLabel={t(screenOn ? 'stopScreen' : 'shareScreen')}
          onPress={use(() => director.dispatch({ type: 'setScreen', enabled: !screenOn }))}
        >
          {screenOn ? <MonitorXIcon size={24} /> : <MonitorUpIcon size={24} />}
        </Button>
        <Button
          variant="destructive"
          size="icon-xl"
          accessibilityLabel={t('leave')}
          onPress={() => director.dispatch({ type: 'leave' })}
        >
          <PhoneOffIcon size={24} className="text-destructive" />
        </Button>
      </View>
    </View>
  )
}
