import { describe, it } from 'node:test'
import { assertCel } from '../helpers.js'

describe('miscellaneous', () => {
  it('order of arithmetic operations', () => assertCel('1 + 2 * 3 + 1', 8n))

  describe('parentheses', () => {
    it('should prioritize parentheses expression', () => assertCel('(1 + 2) * 3 + 1', 10n))
    it('should allow multiple expressions', () => assertCel('(1 + 2) * (3 + 1)', 12n))
    it('should handle nested parentheses', () => assertCel('((1 + 2) * 3) + (4 / 2)', 11n))
    it('should handle complex nested expressions', () => {
      assertCel('(1 + (2 * (3 + 4))) - (5 - 3)', 13n)
    })
  })

  describe('whitespace handling', () => {
    it('should handle extra whitespace', () => assertCel('  1   +   2  ', 3n))
    it('should handle tabs and newlines', () => assertCel('1\t+\n2', 3n))
    it('should handle no whitespace', () => assertCel('1+2*3', 7n))
  })

  describe('complex expressions', () => {
    it('should handle deeply nested property access', () => {
      assertCel('user.profile.settings.theme.color', 'blue', {
        user: {
          profile: {
            settings: {
              theme: {
                color: 'blue'
              }
            }
          }
        }
      })
    })
  })
})
