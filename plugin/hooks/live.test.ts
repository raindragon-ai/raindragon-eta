import { expect, test } from 'claude-code/testing'
import { clock, duration, line, safeSession } from './live.ts'

const band = { start: 0, low: 40, high: 180, cov: '50', learning: false, learned: 57 }

test('ticks a clock next to the range, with a bar up to its top', () => {
  expect(line(band, 42_000)).toBe('☊☋ 0:42 ▕─●──────▏ clear · 40s–3m')
  expect(line(band, 179_000)).toBe('☊☋ 2:59 ▕───────●▏ clear · 40s–3m')
})

test('says when the turn runs past the range', () => {
  expect(line(band, 200_000)).toBe('☊☋ 3:20 running long · forecast was 40s–3m')
})

test('uses the mark the hook chose', () => {
  expect(line({ ...band, mark: 'RD ' }, 0)).toBe('RD 0:00 ▕●───────▏ clear · 40s–3m')
  expect(line({ ...band, mark: '' }, 200_000)).toBe('3:20 running long · forecast was 40s–3m')
})

test('before any range, counts toward the first one', () => {
  expect(line({ start: 0, low: null, high: null, learned: 3 }, 12_000))
    .toBe('☊☋ 0:12 · learning your pace (3/10)')
})

test('flags a major incident', () => {
  expect(line({ ...band, incident: true }, 1_000)).toBe('☊☋ 0:01 ▕●───────▏ clear · 40s–3m · storm warning')
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
