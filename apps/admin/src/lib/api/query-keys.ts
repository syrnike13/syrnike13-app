export const queryKeys = {
  auth: {
    session: ['auth', 'session'] as const,
  },
  admin: {
    badges: ['admin', 'badges'] as const,
    userBadges: (userId: string) => ['admin', 'users', userId, 'badges'] as const,
  },
} as const
