export const queryKeys = {
  auth: {
    session: ['auth', 'session'] as const,
  },
  admin: {
    badges: ['admin', 'badges'] as const,
    diagnostics: (filters: Record<string, string | undefined>) =>
      ['admin', 'diagnostics', filters] as const,
    diagnostic: (id: string) => ['admin', 'diagnostics', id] as const,
    userBadges: (userId: string) => ['admin', 'users', userId, 'badges'] as const,
  },
} as const
