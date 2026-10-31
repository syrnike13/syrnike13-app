import type { VoiceDirector, VoiceSnapshot } from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { Text } from '@syrnike13/ui-native/primitives/text'
import { useState } from 'react'
import { PermissionsAndroid, View } from 'react-native'

import type { CameraFacing } from '../voice/livekit-engine'

function isOn(media: VoiceSnapshot['camera']) {
  return media.state === 'running' || media.state === 'starting'
}

export function CallControls({
  director,
  snapshot,
}: {
  director: VoiceDirector
  snapshot: VoiceSnapshot
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

  return (
    <View className="flex-row flex-wrap gap-2">
      <Button
        variant={snapshot.userMuted ? 'destructive' : 'secondary'}
        onPress={() => director.dispatch({ type: 'setUserMuted', muted: !snapshot.userMuted })}
      >
        <Text>{t(snapshot.userMuted ? 'unmute' : 'mute')}</Text>
      </Button>
      <Button
        variant={snapshot.userDeafened ? 'destructive' : 'secondary'}
        onPress={() =>
          director.dispatch({ type: 'setUserDeafened', deafened: !snapshot.userDeafened })
        }
      >
        <Text>{t(snapshot.userDeafened ? 'undeafen' : 'deafen')}</Text>
      </Button>
      <Button variant="secondary" onPress={toggleCamera}>
        <Text>{t(cameraOn ? 'stopCamera' : 'camera')}</Text>
      </Button>
      {cameraOn ? (
        <Button
          variant="secondary"
          onPress={() => setCamera(true, facing === 'user' ? 'environment' : 'user')}
        >
          <Text>{t('flipCamera')}</Text>
        </Button>
      ) : null}
      <Button
        variant="secondary"
        onPress={() => director.dispatch({ type: 'setScreen', enabled: !screenOn })}
      >
        <Text>{t(screenOn ? 'stopScreen' : 'shareScreen')}</Text>
      </Button>
      <Button variant="destructive" onPress={() => director.dispatch({ type: 'leave' })}>
        <Text>{t('leave')}</Text>
      </Button>
    </View>
  )
}
