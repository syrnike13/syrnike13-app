import {
  SHARED_COUNTER_APPLICATION_ID,
  SYRNIK_RACE_APPLICATION_ID,
} from './channel-activity-types'

export type FirstPartyChannelActivity = Readonly<{
  id: string
  titleKey: string
  descriptionKey: string
  entryUrl: string
}>

export const FIRST_PARTY_CHANNEL_ACTIVITIES: readonly FirstPartyChannelActivity[] =
  [
    {
      id: SYRNIK_RACE_APPLICATION_ID,
      titleKey: 'syrnikRace.title',
      descriptionKey: 'syrnikRace.description',
      entryUrl: '/activities/syrnik-race/index.html',
    },
    {
      id: SHARED_COUNTER_APPLICATION_ID,
      titleKey: 'sharedCounter.title',
      descriptionKey: 'sharedCounter.description',
      entryUrl: '/activities/shared-counter/index.html',
    },
  ]

export function getFirstPartyChannelActivity(applicationId: string) {
  return FIRST_PARTY_CHANNEL_ACTIVITIES.find(
    (application) => application.id === applicationId,
  )
}
