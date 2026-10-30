import { UI_MESSAGES, type MessageCatalogs } from '@syrnike13/ui/i18n'

import en from './en.json'
import ru from './ru.json'

export const catalogs: MessageCatalogs = {
  en: { ...UI_MESSAGES.en, ...en },
  ru: { ...UI_MESSAGES.ru, ...ru },
}
