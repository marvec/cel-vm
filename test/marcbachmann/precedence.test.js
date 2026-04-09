import { describe, it } from 'node:test'
import { assertCel } from '../helpers.js'

describe('operator precedence', () => {
  it('ternary should have lower precedence than logical AND', () => {
    assertCel('true && false ? "wrong" : "right"', 'right')
  })

  it('ternary should have lower precedence than logical OR', () => {
    assertCel('false || true ? "right" : "wrong"', 'right')
  })

  it('ternary should be right-associative', () => {
    assertCel('a ? b ? "ab" : "a" : "none"', 'ab', { a: true, b: true })
    assertCel('a ? b ? "ab" : "a" : "none"', 'a', { a: true, b: false })
    assertCel('a ? b ? "ab" : "a" : "none"', 'none', { a: false, b: true })
  })

  it('complex expression with correct precedence', () => {
    const expression = `
      user.isActive &&
      user.permissions.canEdit &&
      (request.method == "PUT" || request.method == "PATCH") &&
      resource.ownerId == user.id
        ? "allowed"
        : "denied"
    `

    const context = {
      user: {
        isActive: true,
        permissions: { canEdit: true },
        id: 123n
      },
      request: { method: 'PUT' },
      resource: { ownerId: 123n }
    }

    assertCel(expression, 'allowed', context)
    assertCel(expression, 'denied', {
      ...context,
      user: { ...context.user, isActive: false }
    })
  })

  it('arithmetic precedence in ternary', () => {
    assertCel('1 + 2 * 3 > 5 ? "big" : "small"', 'big')
  })

  it('multiplication before addition', () => assertCel('2 + 3 * 4', 14n))
  it('division before subtraction', () => assertCel('10 - 8 / 2', 6n))
  it('comparison operators', () => assertCel('1 + 2 == 3 && 4 > 2', true))
  it('logical operators precedence (AND higher than OR)', () =>
    assertCel('true || false && false', true))
})
