import { beforeEach, describe, expect, it } from 'vitest'
import { hasDb, prisma, resetDb } from '../test/db.js'
import { claimUpdate } from './dedupe.js'

describe.skipIf(!hasDb)('повторный update_id', () => {
  beforeEach(resetDb)

  it('захватывается ровно один раз, даже при одновременной доставке', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => claimUpdate(prisma, 777)))
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await claimUpdate(prisma, 777)).toBe(false)
    expect(await claimUpdate(prisma, 778)).toBe(true)
  })
})
