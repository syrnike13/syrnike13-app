import { useTranslations } from '@syrnike13/ui/i18n'
import { Tabs } from 'expo-router'
import { useResolveClassNames } from 'uniwind'

import { MessageCircleIcon, ServerIcon, UserIcon } from '../../components/icons/registry'

type TabIcon = typeof ServerIcon

function tabIcon(Icon: TabIcon) {
  return ({ focused }: { focused: boolean }) => (
    <Icon size={24} className={focused ? 'text-foreground' : 'text-muted-foreground'} />
  )
}

export default function TabsLayout() {
  const t = useTranslations('mobile.tabs')
  const bar = useResolveClassNames('bg-card border-border')
  const active = useResolveClassNames('text-foreground')
  const inactive = useResolveClassNames('text-muted-foreground')

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: bar.backgroundColor as string | undefined,
          borderTopColor: bar.borderColor as string | undefined,
        },
        tabBarActiveTintColor: active.color as string | undefined,
        tabBarInactiveTintColor: inactive.color as string | undefined,
      }}
    >
      <Tabs.Screen name="index" options={{ title: t('servers'), tabBarIcon: tabIcon(ServerIcon) }} />
      <Tabs.Screen name="messages" options={{ title: t('messages'), tabBarIcon: tabIcon(MessageCircleIcon) }} />
      <Tabs.Screen name="you" options={{ title: t('you'), tabBarIcon: tabIcon(UserIcon) }} />
    </Tabs>
  )
}
