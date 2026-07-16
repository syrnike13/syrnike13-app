import { describe, expect, it } from 'vitest'

import {
  buildOverlayGameTarget,
  rememberDetectedOverlayGame,
} from './overlay-game-detector'
import { OVERLAY_EXCLUDED_PROCESS_NAMES } from './overlay-game-exclusions'
import {
  POPULAR_GAME_PROCESS_NAME_COUNT,
  POPULAR_GAME_PROCESS_NAME_LIST,
  POPULAR_GAME_PROCESS_NAMES,
} from './overlay-game-processes'

const foregroundWindow = {
  pid: 42,
  processName: 'raid.exe',
  processPath: 'C:/Games/Raid.exe',
  title: 'Raid',
  className: 'UnrealWindow',
  visible: true,
  fullscreenLike: true,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
}

describe('overlay game detector policy', () => {
  it('keeps a normalized allowlist of 500 popular game executable names', () => {
    expect(POPULAR_GAME_PROCESS_NAME_COUNT).toBe(500)
    expect(POPULAR_GAME_PROCESS_NAMES.size).toBe(500)
    expect(POPULAR_GAME_PROCESS_NAMES.has('cs2.exe')).toBe(true)
    expect(POPULAR_GAME_PROCESS_NAMES.has('league of legends.exe')).toBe(true)
    expect(POPULAR_GAME_PROCESS_NAMES.has('telegram.exe')).toBe(false)
    expect(POPULAR_GAME_PROCESS_NAMES.has('fl64.exe')).toBe(false)

    for (const processName of POPULAR_GAME_PROCESS_NAME_LIST) {
      expect(processName).toBe(processName.toLowerCase())
      expect(processName.endsWith('.exe')).toBe(true)
      expect(OVERLAY_EXCLUDED_PROCESS_NAMES.has(processName)).toBe(false)
    }
  })

  it('builds a target for fullscreen-like foreground game windows', () => {
    expect(buildOverlayGameTarget(foregroundWindow, 100)).toEqual({
      gameId: 'c:/games/raid.exe',
      processName: 'raid.exe',
      processPath: 'C:/Games/Raid.exe',
      title: 'Raid',
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    })
  })

  it('ignores fullscreen-like Telegram windows', () => {
    expect(
      buildOverlayGameTarget(
        {
          pid: 4242,
          processName: 'Telegram.exe',
          processPath: 'C:/Users/JAKEL/AppData/Roaming/Telegram Desktop/Telegram.exe',
          title: 'Telegram',
          className: 'Qt5152QWindowIcon',
          visible: true,
          fullscreenLike: true,
          bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        },
        100,
      ),
    ).toBeNull()
  })

  it('ignores fullscreen-like FL Studio windows', () => {
    expect(
      buildOverlayGameTarget(
        {
          pid: 5150,
          processName: 'FL64.exe',
          processPath: 'C:/Program Files/Image-Line/FL Studio 21/FL64.exe',
          title: 'FL Studio',
          className: 'TFruityLoopsMainForm',
          visible: true,
          fullscreenLike: true,
          bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        },
        100,
      ),
    ).toBeNull()
  })

  it('ignores Steam launcher windows even when they are large', () => {
    expect(
      buildOverlayGameTarget(
        {
          ...foregroundWindow,
          processName: 'steam.exe',
          processPath: 'C:/Program Files (x86)/Steam/steam.exe',
          title: 'Steam',
        },
        100,
      ),
    ).toBeNull()
  })

  it('ignores League launcher windows with browser graphics modules', () => {
    expect(
      buildOverlayGameTarget(
        {
          pid: 7048,
          processName: 'LeagueClientUx.exe',
          processPath: 'H:/Riot Games/League of Legends/LeagueClientUx.exe',
          title: 'League of Legends',
          className: 'Chrome_WidgetWin_0',
          visible: true,
          fullscreenLike: true,
          bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        },
        100,
      ),
    ).toBeNull()
  })

  it('builds a target for protected League game windows without module access', () => {
    expect(
      buildOverlayGameTarget(
        {
          pid: 37744,
          processName: 'League of Legends.exe',
          processPath: 'H:/Riot Games/League of Legends/Game/League of Legends.exe',
          title: 'League of Legends (TM) Client',
          className: 'RiotWindowClass',
          visible: true,
          fullscreenLike: true,
          bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        },
        100,
      ),
    ).toEqual({
      gameId: 'h:/riot games/league of legends/game/league of legends.exe',
      processName: 'League of Legends.exe',
      processPath: 'H:/Riot Games/League of Legends/Game/League of Legends.exe',
      title: 'League of Legends (TM) Client',
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
    })
  })

  it('treats RiotWindowClass as a protected game signal even without path or modules', () => {
    expect(
      buildOverlayGameTarget(
        {
          pid: 5151,
          processName: 'RiotProtectedGame.exe',
          processPath: null,
          title: 'Riot protected game',
          className: 'RiotWindowClass',
          visible: true,
          fullscreenLike: true,
          bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        },
        100,
      ),
    ).toEqual({
      gameId: 'riotprotectedgame.exe',
      processName: 'RiotProtectedGame.exe',
      processPath: null,
      title: 'Riot protected game',
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
    })
  })

  it('builds a target for windowed games with game window class signals', () => {
    expect(
      buildOverlayGameTarget(
        {
          ...foregroundWindow,
          processPath: 'D:/SteamLibrary/steamapps/common/Raid/Raid.exe',
          fullscreenLike: false,
          bounds: { x: 120, y: 80, width: 1280, height: 720 },
        },
        100,
      ),
    ).toEqual({
      gameId: 'd:/steamlibrary/steamapps/common/raid/raid.exe',
      processName: 'raid.exe',
      processPath: 'D:/SteamLibrary/steamapps/common/Raid/Raid.exe',
      title: 'Raid',
      bounds: { x: 120, y: 80, width: 1280, height: 720 },
    })
  })

  it('builds a target for known game executable names', () => {
    expect(
      buildOverlayGameTarget(
        {
          pid: 777,
          processName: 'cs2.exe',
          processPath: 'C:/CustomGames/Counter-Strike 2/game/bin/win64/cs2.exe',
          title: 'Counter-Strike 2',
          className: 'Valve001',
          visible: true,
          fullscreenLike: false,
          bounds: { x: 80, y: 60, width: 1600, height: 900 },
        },
        100,
      ),
    ).toEqual({
      gameId: 'c:/customgames/counter-strike 2/game/bin/win64/cs2.exe',
      processName: 'cs2.exe',
      processPath: 'C:/CustomGames/Counter-Strike 2/game/bin/win64/cs2.exe',
      title: 'Counter-Strike 2',
      bounds: { x: 80, y: 60, width: 1600, height: 900 },
    })
  })

  it('does not treat game-library paths as games without game-specific signals', () => {
    expect(
      buildOverlayGameTarget(
        {
          ...foregroundWindow,
          processPath: 'D:/SteamLibrary/steamapps/common/Raid/Raid.exe',
          className: 'Chrome_WidgetWin_1',
          fullscreenLike: false,
        },
        100,
      ),
    ).toBeNull()
  })

  it('ignores the current desktop process and non-game windows', () => {
    expect(buildOverlayGameTarget({ ...foregroundWindow, pid: 100 }, 100)).toBeNull()
    expect(
      buildOverlayGameTarget(
        {
          ...foregroundWindow,
          processName: 'notepad.exe',
          processPath: 'C:/Windows/System32/notepad.exe',
          title: 'Notes',
          className: 'Notepad',
          fullscreenLike: false,
        },
        100,
      ),
    ).toBeNull()
  })

  it('remembers every detected game without overwriting its enabled toggle', () => {
    expect(
      rememberDetectedOverlayGame(
        {
          enabled: true,
          games: [
            {
              id: 'c:/games/raid.exe',
              processName: 'raid.exe',
              processPath: 'C:/Games/Raid.exe',
              title: 'Old title',
              enabled: false,
              lastSeenAt: 1,
            },
          ],
        },
        buildOverlayGameTarget(foregroundWindow, 100)!,
        123,
      ),
    ).toEqual({
      enabled: true,
      games: [
        {
          id: 'c:/games/raid.exe',
          processName: 'raid.exe',
          processPath: 'C:/Games/Raid.exe',
          title: 'Raid',
          enabled: false,
          lastSeenAt: 123,
        },
      ],
    })
  })

  it('does not rewrite unchanged detected-game settings on geometry updates', () => {
    const settings = {
      enabled: true,
      games: [
        {
          id: 'c:/games/raid.exe',
          processName: 'raid.exe',
          processPath: 'C:/Games/Raid.exe',
          title: 'Raid',
          enabled: true,
          lastSeenAt: 1_000,
        },
      ],
    }

    expect(
      rememberDetectedOverlayGame(
        settings,
        buildOverlayGameTarget(
          {
            ...foregroundWindow,
            bounds: { x: 200, y: 100, width: 1280, height: 720 },
          },
          100,
        )!,
        2_000,
      ),
    ).toBe(settings)
  })
})
