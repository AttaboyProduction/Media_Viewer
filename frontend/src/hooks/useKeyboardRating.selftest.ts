import { scoreFromRatingDigit } from './useKeyboardRating'

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`)
  }
}

function check(
  digit: number,
  pending: number | null,
  score: number,
  nextPending: number | null,
  label: string,
) {
  const result = scoreFromRatingDigit(digit, pending)
  assertEqual(result.score, score, `${label} score`)
  assertEqual(result.nextPending, nextPending, `${label} nextPending`)
}

check(4, null, 4, 4, 'first 4')
check(5, 4, 4.5, null, '4 then 5 → 4.5')
check(5, 5, 5, null, '5 then 5 stays 5')
check(5, null, 5, 5, 'first 5')
check(3, 4, 3, 3, '4 then 3 restarts at 3')
check(2, 1, 1.5, null, '1 then 2 → 1.5')

console.log('useKeyboardRating.selftest: ok')
