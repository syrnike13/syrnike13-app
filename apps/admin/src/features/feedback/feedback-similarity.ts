import type { FeedbackSuggestion } from '@syrnike13/api-types'

export const FEEDBACK_SIMILARITY_THRESHOLD = 0.32

export type FeedbackSimilarityReason =
  | 'похожее название'
  | 'та же область'
  | 'та же платформа'
  | 'тот же тип'

export type FeedbackSimilarity = {
  score: number
  reasons: FeedbackSimilarityReason[]
}

export type SimilarFeedbackSuggestion = {
  suggestion: FeedbackSuggestion
  similarity: FeedbackSimilarity
}

const RUSSIAN_STOP_WORDS = new Set([
  'а',
  'без',
  'бы',
  'в',
  'во',
  'вот',
  'вы',
  'да',
  'для',
  'до',
  'же',
  'и',
  'из',
  'или',
  'как',
  'к',
  'ко',
  'ли',
  'мне',
  'на',
  'над',
  'не',
  'но',
  'о',
  'об',
  'от',
  'по',
  'под',
  'при',
  'про',
  'с',
  'со',
  'так',
  'то',
  'у',
  'уже',
  'что',
  'это',
])

const RUSSIAN_STEM_SUFFIXES = [
  'ированиями',
  'ованиями',
  'ениями',
  'ирования',
  'ированию',
  'ированием',
  'ированиям',
  'ированиях',
  'ование',
  'ования',
  'ованию',
  'ованием',
  'ованиям',
  'ованиях',
  'ениями',
  'ениям',
  'ениях',
  'ений',
  'ение',
  'ения',
  'ению',
  'ением',
  'ающий',
  'ющая',
  'ющее',
  'ющими',
  'аются',
  'яются',
  'ается',
  'аться',
  'яться',
  'яется',
  'ются',
  'ировать',
  'ируют',
  'ирует',
  'аешь',
  'яешь',
  'аете',
  'яете',
  'ится',
  'ется',
  'ишь',
  'ите',
  'ать',
  'ять',
  'еть',
  'ить',
  'ает',
  'яют',
  'ают',
  'яет',
  'яют',
  'ишь',
  'ит',
  'ят',
  'ют',
  'ими',
  'ами',
  'ями',
  'ого',
  'ему',
  'ах',
  'ях',
  'ов',
  'ев',
  'ей',
  'ам',
  'ям',
  'ой',
  'ий',
  'ый',
  'ое',
  'ее',
  'ая',
  'яя',
  'ую',
  'юю',
  'ом',
  'ем',
  'ия',
  'ие',
  'ы',
  'и',
  'а',
  'я',
] as const

/** Normalizes Russian feedback text before comparing it. */
export function normalizeFeedbackText(value: string) {
  return value
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** Splits normalized Russian text into meaningful unique terms. */
export function tokenizeFeedbackText(value: string) {
  return [
    ...new Set(
      normalizeFeedbackText(value)
        .split(' ')
        .filter((token) => token.length > 1 && !RUSSIAN_STOP_WORDS.has(token))
        .map(stemRussianToken),
    ),
  ]
}

/**
 * A deliberately small Russian stemmer. It avoids a dependency while making
 * common inflections such as «вылетает/вылеты» and
 * «уведомление/уведомления» comparable.
 */
export function stemRussianToken(token: string) {
  for (const suffix of RUSSIAN_STEM_SUFFIXES) {
    if (
      token.endsWith(suffix) &&
      token.length - suffix.length >= 3
    ) {
      return token.slice(0, -suffix.length)
    }
  }

  return token
}

function diceCoefficient(left: string[], right: string[]) {
  if (left.length === 0 || right.length === 0) return 0

  const rightTokens = new Set(right)
  let overlap = 0

  for (const token of new Set(left)) {
    if (rightTokens.has(token)) overlap += 1
  }

  return (2 * overlap) / (new Set(left).size + rightTokens.size)
}

/**
 * Scores a candidate without claiming it is a duplicate. The title carries the
 * greatest textual weight; category, area and platform only refine a textual
 * match so matching metadata alone cannot produce a suggestion.
 */
export function getFeedbackSimilarity(
  source: FeedbackSuggestion,
  candidate: FeedbackSuggestion,
): FeedbackSimilarity | null {
  if (source._id === candidate._id) return null

  const titleScore = diceCoefficient(
    tokenizeFeedbackText(source.title),
    tokenizeFeedbackText(candidate.title),
  )
  const descriptionScore = diceCoefficient(
    tokenizeFeedbackText(source.description),
    tokenizeFeedbackText(candidate.description),
  )
  const textScore = titleScore * 0.7 + descriptionScore * 0.3
  const sameCategory = source.category === candidate.category
  const sameArea = Boolean(source.area && source.area === candidate.area)
  const samePlatform = Boolean(
    source.platform && source.platform === candidate.platform,
  )
  const score = Math.min(
    1,
    textScore +
      (sameCategory ? 0.08 : 0) +
      (sameArea ? 0.08 : 0) +
      (samePlatform ? 0.06 : 0),
  )

  const hasMeaningfulTextMatch = titleScore >= 0.16 || descriptionScore >= 0.24
  if (!hasMeaningfulTextMatch || score < FEEDBACK_SIMILARITY_THRESHOLD) {
    return null
  }

  const reasons: FeedbackSimilarityReason[] = []
  if (titleScore >= 0.16) reasons.push('похожее название')
  if (sameArea) reasons.push('та же область')
  if (samePlatform) reasons.push('та же платформа')
  if (sameCategory) reasons.push('тот же тип')

  return { score, reasons }
}

/** Ranks only already published candidates that are currently loaded. */
export function rankSimilarFeedback(
  source: FeedbackSuggestion,
  candidates: FeedbackSuggestion[],
  limit = 5,
): SimilarFeedbackSuggestion[] {
  return candidates
    .filter((candidate) => candidate.moderation_status === 'approved')
    .flatMap((suggestion) => {
      const similarity = getFeedbackSimilarity(source, suggestion)
      return similarity ? [{ suggestion, similarity }] : []
    })
    .sort((left, right) => right.similarity.score - left.similarity.score)
    .slice(0, limit)
}
