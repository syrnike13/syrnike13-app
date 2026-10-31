import {
  EventsGateway,
  type GatewayEnvironment,
} from '@syrnike13/client/gateway/events-gateway'

/** Browser and Electron renderer: wake on a visible tab or a restored network. */
export const webGatewayEnvironment: GatewayEnvironment = {
  clientKind: () =>
    window.syrnikeDesktop?.runtime === 'desktop' ? 'desktop' : 'web',
  watchWake(wake) {
    if (typeof window === 'undefined') return () => {}
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') wake()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('online', wake)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('online', wake)
    }
  },
}

export const eventsGateway = new EventsGateway(webGatewayEnvironment)
