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
    feedback: ['admin', 'feedback'] as const,
    feedbackPending: ['admin', 'feedback', 'pending'] as const,
    feedbackPublished: ['admin', 'feedback', 'published'] as const,
    feedbackPublishedCatalog: ['admin', 'feedback', 'published-catalog'] as const,
  },
} as const
