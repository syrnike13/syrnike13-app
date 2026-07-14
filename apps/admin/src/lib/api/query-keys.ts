export const queryKeys = {
  auth: {
    session: ['auth', 'session'] as const,
  },
  admin: {
    badges: ['admin', 'badges'] as const,
    userBadges: (userId: string) => ['admin', 'users', userId, 'badges'] as const,
    feedback: ['admin', 'feedback'] as const,
    feedbackPending: ['admin', 'feedback', 'pending'] as const,
    feedbackPublished: ['admin', 'feedback', 'published'] as const,
  },
} as const
