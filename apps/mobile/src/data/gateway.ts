import {
  EventsGateway,
  type GatewayEnvironment,
} from '@syrnike13/client/gateway/events-gateway'
import { AppState } from 'react-native'

/** Android may freeze the socket in the background: reconnect when the app is back. */
const mobileGatewayEnvironment: GatewayEnvironment = {
  clientKind: () => 'mobile',
  watchWake(wake) {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') wake()
    })
    return () => subscription.remove()
  },
}

export const eventsGateway = new EventsGateway(mobileGatewayEnvironment)
