import type { VoiceDirector, VoiceSnapshot } from '@syrnike13/platform'
import { useTranslations } from '@syrnike13/ui/i18n'
import { Button } from '@syrnike13/ui-native/primitives/button'
import { useState } from 'react'
import { PermissionsAndroid, View } from 'react-native'

import {
  HeadphoneOffIcon,
  HeadphonesIcon,
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

/** Discord-style round call buttons: toggles turn red while something is off. */
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
    <View className="flex-row flex-wrap items-center justify-center gap-3">
      <Button
        size="icon-lg"
        shape="circle"
        variant={snapshot.userMuted ? 'destructive' : 'secondary'}
        accessibilityLabel={t(snapshot.userMuted ? 'unmute' : 'mute')}
        onPress={() => director.dispatch({ type: 'setUserMuted', muted: !snapshot.userMuted })}
      >
        {snapshot.userMuted ? <MicOffIcon className="text-destructive" /> : <MicIcon />}
      </Button>
      <Button
        size="icon-lg"
        shape="circle"
        variant={snapshot.userDeafened ? 'destructive' : 'secondary'}
        accessibilityLabel={t(snapshot.userDeafened ? 'undeafen' : 'deafen')}
        onPress={() => director.dispatch({ type: 'setUserDeafened', deafened: !snapshot.userDeafened })}
      >
        {snapshot.userDeafened ? <HeadphoneOffIcon className="text-destructive" /> : <HeadphonesIcon />}
      </Button>
      <Button
        size="icon-lg"
        shape="circle"
        variant="secondary"
        accessibilityLabel={t(cameraOn ? 'stopCamera' : 'camera')}
        onPress={toggleCamera}
      >
        {cameraOn ? <VideoIcon /> : <VideoOffIcon />}
      </Button>
      {cameraOn ? (
        <Button
          size="icon-lg"
          shape="circle"
          variant="secondary"
          accessibilityLabel={t('flipCamera')}
          onPress={() => setCamera(true, facing === 'user' ? 'environment' : 'user')}
        >
          <SwitchCameraIcon />
        </Button>
      ) : null}
      <Button
        size="icon-lg"
        shape="circle"
        variant="secondary"
        accessibilityLabel={t(screenOn ? 'stopScreen' : 'shareScreen')}
        onPress={() => director.dispatch({ type: 'setScreen', enabled: !screenOn })}
      >
        {screenOn ? <MonitorXIcon /> : <MonitorUpIcon />}
      </Button>
      <Button
        size="icon-lg"
        shape="circle"
        variant="destructive"
        accessibilityLabel={t('leave')}
        onPress={() => director.dispatch({ type: 'leave' })}
      >
        <PhoneOffIcon className="text-destructive" />
      </Button>
    </View>
  )
}
