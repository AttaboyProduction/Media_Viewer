import {
  formatFileSize,
  formatPixelSize,
  packWebShareBatches,
  WEB_SHARE_MAX_BYTES,
  WEB_SHARE_MAX_FILES,
  webShareNeedsNotice,
  webSharePlanFromSizes,
  webShareStepOptions,
} from './mediaViewerActions'

function assert(cond: boolean, message: string) {
  if (!cond) throw new Error(message)
}

{
  const { batches, tooLarge } = packWebShareBatches([1, 1, 1], 2, 10)
  assert(batches.length === 2, 'packs by file count')
  assert(batches[0].join() === '0,1' && batches[1].join() === '2', 'count batches keep order')
  assert(tooLarge.length === 0, 'nothing too large')
}

{
  const { batches, tooLarge } = packWebShareBatches([6, 6, 3], 10, 10)
  assert(tooLarge.length === 0, 'byte packing has no too-large')
  assert(batches.map((b) => b.join()).join('|') === '0|1,2', 'starts a new batch when the next file would overflow')
  const again = packWebShareBatches([4, 4, 3], 10, 10)
  assert(again.batches.length === 2, '4+4 fills the budget; 3 starts the next batch')
  assert(again.batches[0].join() === '0,1' && again.batches[1].join() === '2', 'fills then starts next')
}

{
  const { batches, tooLarge } = packWebShareBatches([WEB_SHARE_MAX_BYTES + 1, 10], WEB_SHARE_MAX_FILES, WEB_SHARE_MAX_BYTES)
  assert(tooLarge.join() === '0', 'oversized alone is download-only')
  assert(batches.length === 1 && batches[0].join() === '1', 'smaller file still shares')
}

{
  const many = Array.from({ length: 12 }, () => 100)
  const { batches, tooLarge } = packWebShareBatches(many)
  assert(tooLarge.length === 0, 'default caps have no too-large for tiny files')
  assert(batches.length === 2, 'default file cap splits 12 into two batches')
  assert(batches[0].length === WEB_SHARE_MAX_FILES && batches[1].length === 2, '10 then 2')
}

{
  const plan = webSharePlanFromSizes(Array.from({ length: 12 }, () => 100))
  assert(plan.batchCount === 2, 'plan sees two batches for 12 tiny files')
  assert(webShareNeedsNotice(plan), 'multiple batches need a notice')
  const first = webShareStepOptions({
    step: 1,
    totalSteps: 2,
    nextCount: 10,
    remainingShareCount: 2,
    sharedSoFar: 0,
    tooLargeCount: 0,
  })
  assert(first.confirmLabel === 'Share next', 'first step offers Share next')
  const next = webShareStepOptions({
    step: 2,
    totalSteps: 2,
    nextCount: 2,
    remainingShareCount: 0,
    sharedSoFar: 10,
    tooLargeCount: 0,
  })
  assert(next.title.includes('Continue'), 'later step asks to continue')
  assert(next.cancelLabel === 'Stop', 'later step can stop')
}

{
  const plan = webSharePlanFromSizes([WEB_SHARE_MAX_BYTES + 1])
  assert(plan.tooLargeCount === 1 && plan.batchCount === 0, 'oversized alone is too large')
  assert(webShareNeedsNotice(plan), 'oversized needs a notice')
  const notice = webShareStepOptions({
    step: 1,
    totalSteps: 1,
    nextCount: 0,
    remainingShareCount: 0,
    sharedSoFar: 0,
    tooLargeCount: 1,
    oversizedLabels: ['big.mp4 (60 MB)'],
  })
  assert(notice.message.toLowerCase().includes('50'), 'oversized notice mentions 50 MB')
  assert((notice.detailLines || []).some((line) => line.includes('big.mp4')), 'lists oversized names')
}

{
  assert(formatPixelSize(1920, 1080) === '1920×1080', 'formats pixel size')
  assert(formatPixelSize(0, 1080) === '', 'skips zero width')
  assert(formatPixelSize(null, 1080) === '', 'skips missing width')
  assert(formatFileSize(900) === '900 B', 'bytes under 1 KB')
  assert(formatFileSize(1536) === '1.5 KB', 'small KB with one decimal')
  assert(formatFileSize(5 * 1024 * 1024) === '5.0 MB', 'megabytes keep one decimal under 10')
}

console.log('mediaViewerActions.selftest: ok')
