import { describe, it } from 'node:test'
import { assertCel, assertCelError } from './helpers.js'

describe('duration accessor methods', () => {
  it('1h getHours', () => assertCel('duration("1h").getHours()', 1n))
  it('2h30m getHours', () => assertCel('duration("2h30m").getHours()', 2n))
  it('2h30m getMinutes', () => assertCel('duration("2h30m").getMinutes()', 150n))
  it('90s getSeconds', () => assertCel('duration("90s").getSeconds()', 90n))
  it('90s getMinutes', () => assertCel('duration("90s").getMinutes()', 1n))
  it('3723s getHours', () => assertCel('duration("3723s").getHours()', 1n))
  it('3723s getMinutes', () => assertCel('duration("3723s").getMinutes()', 62n))
  it('3723s getSeconds', () => assertCel('duration("3723s").getSeconds()', 3723n))
  it('500ms getSeconds', () => assertCel('duration("500ms").getSeconds()', 0n))
  it('negative duration', () => assertCel('duration("-1h").getHours()', -1n))

  describe('timestamp methods still work', () => {
    it('getFullYear', () => assertCel('timestamp("2023-06-15T00:00:00Z").getFullYear()', 2023n))
    it('getHours on timestamp', () => assertCel('timestamp("2023-06-15T14:30:00Z").getHours()', 14n))
    it('getMinutes on timestamp', () => assertCel('timestamp("2023-06-15T14:30:45Z").getMinutes()', 30n))
    it('getSeconds on timestamp', () => assertCel('timestamp("2023-06-15T14:30:45Z").getSeconds()', 45n))
  })
})
