import { describe, expect, it } from 'vitest'

import {
  buildOverlayGameTarget,
  rememberDetectedOverlayGame,
} from './overlay-game-detector'

const foregroundWindow = {
  pid: 42,
  processName: 'raid.exe',
  processPath: 'C:/Games/Raid.exe',
  title: 'Raid',
  className: 'UnrealWindow',
  visible: true,
  fullscreenLike: true,
  graphicsModules: ['d3d11.dll'],
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
}

describe('overlay game detector policy', () => {
  it('builds a target for fullscreen-like foreground game windows', () => {
    expect(buildOverlayGameTarget(foregroundWindow, 100)).toEqual({
      gameId: 'c:/games/raid.exe',
      processName: 'raid.exe',
      processPath: 'C:/Games/Raid.exe',
      title: 'Raid',
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    })
  })

  it('ignores Steam launcher windows even when they are large', () => {
    expect(
      buildOverlayGameTarget(
        {
          ...foregroundWindow,
          processName: 'steam.exe',
          processPath: 'C:/Program Files (x86)/Steam/steam.exe',
          title: 'Steam',
          graphicsModules: ['d3d11.dll'],
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
          graphicsModules: ['dxgi.dll', 'd3d9.dll'],
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
          graphicsModules: [],
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
          graphicsModules: [],
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

  it('builds a target for windowed games with graphics runtime signals', () => {
    expect(
      buildOverlayGameTarget(
        {
          ...foregroundWindow,
          processPath: 'D:/SteamLibrary/steamapps/common/Raid/Raid.exe',
          fullscreenLike: false,
          graphicsModules: ['dxgi.dll', 'd3d11.dll'],
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

  it('does not treat game-library paths as games without runtime signals', () => {
    expect(
      buildOverlayGameTarget(
        {
          ...foregroundWindow,
          processPath: 'D:/SteamLibrary/steamapps/common/Raid/Raid.exe',
          fullscreenLike: false,
          graphicsModules: [],
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
          graphicsModules: [],
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
})
