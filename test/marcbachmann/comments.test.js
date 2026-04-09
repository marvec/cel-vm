import { describe, it } from 'node:test'
import { assertCel } from '../helpers.js'

describe('comments', () => {
  it('should ignore single line comments at the end', () =>
    assertCel('1 + 2 // This is a comment', 3n))

  it('should ignore single line comments at the beginning', () =>
    assertCel('// This is a comment\n1 + 2', 3n))

  it('should ignore single line comments in the middle', () =>
    assertCel('1 + // comment\n2', 3n))

  it('should handle multiple comments', () => {
    const expr = `
      // First comment
      1 + // Second comment
      2   // Third comment
    `
    assertCel(expr, 3n)
  })

  it('should handle comments with complex expressions', () => {
    const expr = `
      // Calculate user permissions
      user.isAdmin && // Check admin status
      user.isActive   // Check if active
    `
    assertCel(expr, true, { user: { isAdmin: true, isActive: true } })
  })

  it('should not treat comments inside strings as comments', () =>
    assertCel('"This // is not a comment"', 'This // is not a comment'))

  it('should handle empty comment lines', () => {
    const expr = `
      (1 + 2) //
      //
      * 3
    `
    assertCel(expr, 9n)
  })
})
