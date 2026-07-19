import {
  SHARED_COUNTER_APPLICATION_ID,
  SYRNIK_RACE_APPLICATION_ID,
} from './channel-activity-types'

export type FirstPartyChannelActivity = Readonly<{
  id: string
  title: string
  description: string
  entryUrl: string
}>

export const FIRST_PARTY_CHANNEL_ACTIVITIES: readonly FirstPartyChannelActivity[] =
  [
    {
      id: SYRNIK_RACE_APPLICATION_ID,
      title: 'Сырниковая гонка',
      description:
        'Ready-лобби, общая цель, конкурентные попадания, очки и завершение раунда.',
      entryUrl: '/activities/syrnik-race/index.html',
    },
    {
      id: SHARED_COUNTER_APPLICATION_ID,
      title: 'Совместный счётчик',
      description: 'Минимальная проверка общей серверной ревизии.',
      entryUrl: '/activities/shared-counter/index.html',
    },
  ]

export function getFirstPartyChannelActivity(applicationId: string) {
  return FIRST_PARTY_CHANNEL_ACTIVITIES.find(
    (application) => application.id === applicationId,
  )
}
