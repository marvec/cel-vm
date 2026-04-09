import { describe, it } from 'node:test'
import { assertCel, assertCelError } from '../helpers.js'

describe('integer literals', () => {
  it('should parse decimal integers', () => {
    assertCel('42', 42n)
    assertCel('0', 0n)
    assertCel('123456', 123456n)
  })

  it('should parse negative decimal integers', () => {
    assertCel('-42', -42n)
    assertCel('-1', -1n)
    assertCel('-999', -999n)
  })

  it('should parse hexadecimal integers with lowercase x', () => {
    assertCel('0x0', 0n)
    assertCel('0x1', 1n)
    assertCel('0xa', 10n)
    assertCel('0xf', 15n)
    assertCel('0x10', 16n)
    assertCel('0xff', 255n)
    assertCel('0x100', 256n)
    assertCel('0xdead', 57005n)
    assertCel('0xbeef', 48879n)
  })

  it('should parse hexadecimal integers with uppercase X', () => {
    assertCel('0X0', 0n)
    assertCel('0X1', 1n)
    assertCel('0XA', 10n)
    assertCel('0XF', 15n)
    assertCel('0X10', 16n)
    assertCel('0XFF', 255n)
    assertCel('0X100', 256n)
    assertCel('0XDEAD', 57005n)
    assertCel('0XBEEF', 48879n)
  })

  it('should parse hexadecimal integers with mixed case', () => {
    assertCel('0xDead', 57005n)
    assertCel('0xBeEf', 48879n)
    assertCel('0XdEaD', 57005n)
    assertCel('0XbEeF', 48879n)
  })

  it('should parse negative hexadecimal integers', () => {
    assertCel('-0x1', -1n)
    assertCel('-0xa', -10n)
    assertCel('-0xff', -255n)
    assertCel('-0X10', -16n)
    assertCel('-0XDEAD', -57005n)
  })

  it('should compare integers correctly', () => {
    assertCel('0x10 == 16', true)
    assertCel('0xff != 254', true)
    assertCel('0xa > 9', true)
    assertCel('0xf >= 15', true)
    assertCel('0x5 < 10', true)
    assertCel('0x8 <= 8', true)
  })

  it('should handle large hex values', () => {
    assertCel('0x7fffffff', 2147483647n)
    assertCel('0x80000000', 2147483648n)
    assertCel('0xffffffff', 4294967295n)
  })

  it('should handle integer literals in complex expressions', () => {
    assertCel('(0x10 + 0x20) * 2', 96n)
    assertCel('0xff > 100 ? 0xa : 0xb', 10n)
    assertCel('[0x1, 0x2, 0x3][1]', 2n)
  })
})

describe('integer parsing edge cases', () => {
  it('should handle hex numbers at token boundaries', () => {
    assertCel('0xff+1', 256n)
    assertCel('0x10*0x2', 32n)
  })

  it('should handle integer overflow', () => {
    assertCel('9223372036854775807', 9223372036854775807n)
    assertCel('-9223372036854775808', -9223372036854775808n)
    assertCel('4611686018427387903 * 2', 9223372036854775806n)
    assertCel('-4611686018427387904 * 2', -9223372036854775808n)
    assertCelError('9223372036854775807 + 1')
    assertCelError('-9223372036854775808 - 1')
    assertCelError('4611686018427387905 * 2')
  })
})

describe('integer arithmetic with hex', () => {
  it('should perform hex arithmetic', () => {
    assertCel('0x10 + 0x20', 48n)
    assertCel('0xff - 0xf', 240n)
    assertCel('0xa * 0xb', 110n)
    assertCel('0x64 / 0x4', 25n)
    assertCel('0x17 % 0x5', 3n)
  })
})
