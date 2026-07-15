export const queryKeys = {
  api: {
    root: ['api', 'root'] as const,
  },
  auth: {
    session: ['auth', 'session'] as const,
    onboarding: (token: string) => ['auth', 'onboarding', token] as const,
  },
  users: {
    detail: (userId: string) => ['users', userId] as const,
    profile: (userId: string) => ['users', userId, 'profile'] as const,
  },
  feedback: {
    all: ['feedback'] as const,
    list: (viewerId: string, params: unknown) =>
      ['feedback', viewerId, 'list', params] as const,
    mine: (viewerId: string) => ['feedback', viewerId, 'mine'] as const,
    detail: (viewerId: string, id: string) =>
      ['feedback', viewerId, 'detail', id] as const,
  },
  admin: {
    badges: ['admin', 'badges'] as const,
    userBadges: (userId: string) => ['admin', 'users', userId, 'badges'] as const,
  },
  channels: {
    messages: (channelId: string) =>
      ['channels', channelId, 'messages'] as const,
    pinned: (channelId: string) =>
      ['channels', channelId, 'pinned'] as const,
  },
} as const
