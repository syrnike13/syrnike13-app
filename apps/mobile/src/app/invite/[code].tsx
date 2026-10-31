import { useLocalSearchParams } from 'expo-router'

import { InviteScreen } from '../../screens/invite-screen'

export default function InviteRoute() {
  const { code } = useLocalSearchParams<{ code: string }>()
  return <InviteScreen code={code} />
}
