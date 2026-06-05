const PERMISSION_MASK = (1n << 64n) - 1n

function toBigInt(value: number): bigint {
  return BigInt(value) & PERMISSION_MASK
}

function fromBigInt(value: bigint): number {
  return Number(value)
}

export function permissionBit(index: number): number {
  return fromBigInt(1n << BigInt(index))
}

export function maskPermissionBits(value: number): number {
  return fromBigInt(toBigInt(value))
}

export function permissionAnd(a: number, b: number): number {
  return fromBigInt(toBigInt(a) & toBigInt(b))
}

export function permissionOr(a: number, b: number): number {
  return fromBigInt(toBigInt(a) | toBigInt(b))
}

export function permissionAndNot(a: number, b: number): number {
  return fromBigInt(toBigInt(a) & ~toBigInt(b))
}

export function permissionNot(value: number): number {
  return fromBigInt(~toBigInt(value))
}

export function hasPermissionBit(permissions: number, flag: number): boolean {
  const bit = toBigInt(flag)
  if (bit === 0n) return false
  return (toBigInt(permissions) & bit) === bit
}
