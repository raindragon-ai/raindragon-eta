import { expect, test } from 'claude-code/testing'
import { clock, duration, line, safeSession } from './live.ts'

const band = { start: 0, low: 40, high: 180, cov: '50', learning: false, learned: 57 }

test('ticks a clock next to the band', () => {
  expect(line(band, 42_000)).toBe('⏱ 0:42 · half took 40s–3m')
})

test('says when the turn runs past the band', () => {
  expect(line(band, 200_000)).toBe('⏱ 3:20 · half took 40s–3m · longer than usual')
})

test('marks the wide learning band', () => {
  expect(line({ ...band, cov: '80', learning: true }, 5_000))
    .toBe('⏱ 0:05 · 8 in 10 took 40s–3m (learning)')
})

test('before any band, counts toward the first one', () => {
  expect(line({ start: 0, low: null, high: null, learned: 3 }, 12_000))
    .toBe('⏱ 0:12 · learning your pace (3/10)')
})

test('flags a major incident', () => {
  expect(line({ ...band, incident: true }, 1_000)).toBe('⏱ 0:01 · half took 40s–3m · Claude incident')
})

test('formats like the Python hook', () => {
  expect(duration(45)).toBe('45s')
  expect(duration(95)).toBe('1m30s')
  expect(duration(605)).toBe('10m')
  expect(duration(5400)).toBe('1h30m')
  expect(clock(3_725_000)).toBe('1:02:05')
})

test('session ids map to the same file name as the hook', () => {
  expect(safeSession('ab-12_x')).toBe('ab-12_x')
  expect(safeSession('a/b:c')).toBe('a_b_c')
  expect(safeSession('')).toBe('nosession')
})
