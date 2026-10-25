import type { User } from '@syrnike13/api-types'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import {
  acceptIncomingFriendRequest,
  blockIncomingFriendRequest,
  blockUserRelationship,
  cancelOutgoingFriendRequest,
  declineIncomingFriendRequest,
  removeFriend,
  sendFriendRequestByUsername,
  sendFriendRequestToUser,
  unblockBlockedUser,
} from './friend-actions'

describe('friend actions', () => {
  function createDeps(overrides = {}) {
    return {
      acceptFriendRequest: vi.fn(),
      removeFriendOrRequest: vi.fn(),
      blockUser: vi.fn(),
      sendFriendRequest: vi.fn(),
      unblockUser: vi.fn(),
      upsertUser: vi.fn(),
      ...overrides,
    }
  }

  it('accepts an incoming friend request and stores the updated user', async () => {
    const updatedUser = {
      _id: 'user-1',
      username: 'alice',
      relationship: 'Friend',
    } as User

    const deps = createDeps({
      acceptFriendRequest: vi.fn(() => Effect.succeed(updatedUser)),
    })

    await expect(
      Effect.runPromise(
        acceptIncomingFriendRequest('token-1', 'user-1', deps),
      ),
    ).resolves.toBe(updatedUser)

    expect(deps.acceptFriendRequest).toHaveBeenCalledWith(
      'token-1',
      'user-1',
    )
    expect(deps.upsertUser).toHaveBeenCalledWith(updatedUser)
  })

  it('declines an incoming friend request and stores the updated user', async () => {
    const updatedUser = {
      _id: 'user-1',
      username: 'alice',
      relationship: 'None',
    } as User

    const deps = createDeps({
      removeFriendOrRequest: vi.fn(() => Effect.succeed(updatedUser)),
    })

    await expect(
      Effect.runPromise(
        declineIncomingFriendRequest('token-1', 'user-1', deps),
      ),
    ).resolves.toBe(updatedUser)

    expect(deps.removeFriendOrRequest).toHaveBeenCalledWith(
      'token-1',
      'user-1',
    )
    expect(deps.upsertUser).toHaveBeenCalledWith(updatedUser)
  })

  it('blocks an incoming friend request sender and stores the updated user', async () => {
    const updatedUser = {
      _id: 'user-1',
      username: 'alice',
      relationship: 'Blocked',
    } as User

    const deps = createDeps({
      blockUser: vi.fn(() => Effect.succeed(updatedUser)),
    })

    await expect(
      Effect.runPromise(
        blockIncomingFriendRequest('token-1', 'user-1', deps),
      ),
    ).resolves.toBe(updatedUser)

    expect(deps.blockUser).toHaveBeenCalledWith(
      'token-1',
      'user-1',
    )
    expect(deps.upsertUser).toHaveBeenCalledWith(updatedUser)
  })

  it('blocks a user relationship and stores the updated user', async () => {
    const updatedUser = {
      _id: 'user-1',
      username: 'alice',
      relationship: 'Blocked',
    } as User

    const deps = createDeps({
      blockUser: vi.fn(() => Effect.succeed(updatedUser)),
    })

    await expect(
      Effect.runPromise(blockUserRelationship('token-1', 'user-1', deps)),
    ).resolves.toBe(updatedUser)

    expect(deps.blockUser).toHaveBeenCalledWith(
      'token-1',
      'user-1',
    )
    expect(deps.upsertUser).toHaveBeenCalledWith(updatedUser)
  })

  it('sends a friend request by canonical username and stores the updated user', async () => {
    const targetUser = {
      _id: 'user-1',
      username: 'alice',
      discriminator: '1234',
      relationship: 'None',
    } as User
    const updatedUser = {
      ...targetUser,
      relationship: 'Outgoing',
    } as User

    const deps = createDeps({
      sendFriendRequest: vi.fn(() => Effect.succeed(updatedUser)),
    })

    await expect(
      Effect.runPromise(
        sendFriendRequestToUser('token-1', targetUser, deps),
      ),
    ).resolves.toBe(updatedUser)

    expect(deps.sendFriendRequest).toHaveBeenCalledWith(
      'token-1',
      'alice#1234',
    )
    expect(deps.upsertUser).toHaveBeenCalledWith(updatedUser)
  })

  it('sends a friend request by typed username and stores the updated user', async () => {
    const updatedUser = {
      _id: 'user-1',
      username: 'alice',
      relationship: 'Outgoing',
    } as User

    const deps = createDeps({
      sendFriendRequest: vi.fn(() => Effect.succeed(updatedUser)),
    })

    await expect(
      Effect.runPromise(
        sendFriendRequestByUsername('token-1', 'alice#1234', deps),
      ),
    ).resolves.toBe(updatedUser)

    expect(deps.sendFriendRequest).toHaveBeenCalledWith(
      'token-1',
      'alice#1234',
    )
    expect(deps.upsertUser).toHaveBeenCalledWith(updatedUser)
  })

  it('cancels an outgoing friend request and stores the updated user', async () => {
    const updatedUser = {
      _id: 'user-1',
      username: 'alice',
      relationship: 'None',
    } as User

    const deps = createDeps({
      removeFriendOrRequest: vi.fn(() => Effect.succeed(updatedUser)),
    })

    await expect(
      Effect.runPromise(
        cancelOutgoingFriendRequest('token-1', 'user-1', deps),
      ),
    ).resolves.toBe(updatedUser)

    expect(deps.removeFriendOrRequest).toHaveBeenCalledWith(
      'token-1',
      'user-1',
    )
    expect(deps.upsertUser).toHaveBeenCalledWith(updatedUser)
  })

  it('removes a friend and stores the updated user', async () => {
    const updatedUser = {
      _id: 'user-1',
      username: 'alice',
      relationship: 'None',
    } as User

    const deps = createDeps({
      removeFriendOrRequest: vi.fn(() => Effect.succeed(updatedUser)),
    })

    await expect(
      Effect.runPromise(removeFriend('token-1', 'user-1', deps)),
    ).resolves.toBe(updatedUser)

    expect(deps.removeFriendOrRequest).toHaveBeenCalledWith(
      'token-1',
      'user-1',
    )
    expect(deps.upsertUser).toHaveBeenCalledWith(updatedUser)
  })

  it('unblocks a user and stores the updated user', async () => {
    const updatedUser = {
      _id: 'user-1',
      username: 'alice',
      relationship: 'None',
    } as User

    const deps = createDeps({
      unblockUser: vi.fn(() => Effect.succeed(updatedUser)),
    })

    await expect(
      Effect.runPromise(unblockBlockedUser('token-1', 'user-1', deps)),
    ).resolves.toBe(updatedUser)

    expect(deps.unblockUser).toHaveBeenCalledWith(
      'token-1',
      'user-1',
    )
    expect(deps.upsertUser).toHaveBeenCalledWith(updatedUser)
  })
})
