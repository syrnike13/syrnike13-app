export const queryKeys = {
  api: {
    root: ['api', 'root'] as const,
  },
  auth: {
    session: ['auth', 'session'] as const,
    onboarding: (token: string) => ['auth', 'onboarding', token] as const,
  },
  users: {
    profile: (userId: string) => ['users', userId, 'profile'] as const,
  },
  channels: {
    messages: (channelId: string) =>
      ['channels', channelId, 'messages'] as const,
    pinned: (channelId: string) =>
      ['channels', channelId, 'pinned'] as const,
  },
} as const
