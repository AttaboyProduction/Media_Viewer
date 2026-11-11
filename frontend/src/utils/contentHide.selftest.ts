import {
  excludeTagsForMediaQuery,
  isMediaContentHidden,
  lockedContentHideTagNames,
  lockedRulesForMedia,
  mediaForPageTagList,
  mergeRevealedRuleIds,
  pendingRevealRules,
} from './contentHide'
import type { ContentHideRule } from '../types/appSettings'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

const rules: ContentHideRule[] = [
  { id: 'a', label: 'Rule #1', tag_names: ['nsfw', '18+'], message: 'Are you 18+?' },
  { id: 'b', label: 'Rule #2', tag_names: ['gore'], message: '' },
  { id: 'c', label: 'Rule #3', tag_names: [], message: 'empty tags' },
]

const mediaNsfw = { tags: [{ name: 'nsfw' }, { name: 'cute' }] }
const mediaGore = { tags: [{ name: 'gore' }] }
const mediaBoth = { tags: [{ name: '18+' }, { name: 'gore' }] }
const mediaClean = { tags: [{ name: 'safe' }] }

assert(lockedRulesForMedia(rules, [], mediaNsfw).map((r) => r.id).join() === 'a', 'any-tag match a')
assert(lockedRulesForMedia(rules, [], mediaGore).map((r) => r.id).join() === 'b', 'match b')
assert(
  lockedRulesForMedia(rules, [], mediaBoth)
    .map((r) => r.id)
    .join() === 'a,b',
  'match both',
)
assert(lockedRulesForMedia(rules, [], mediaClean).length === 0, 'clean unlocked')
assert(lockedRulesForMedia(rules, ['a'], mediaNsfw).length === 0, 'revealed a')
assert(lockedRulesForMedia(rules, ['a'], mediaBoth).map((r) => r.id).join() === 'b', 'partial reveal')
assert(!isMediaContentHidden(rules, ['a', 'b'], mediaBoth), 'fully revealed')
assert(pendingRevealRules(rules, []).map((r) => r.id).join() === 'a,b', 'pending skips empty tags')
assert(pendingRevealRules(rules, ['a']).map((r) => r.id).join() === 'b', 'pending after a')
assert(mergeRevealedRuleIds(['a'], ['b', 'a']).join() === 'a,b', 'merge unique')

// Empty message still locks
assert(isMediaContentHidden(rules, [], mediaGore), 'empty message still locks')

const page = [mediaNsfw, mediaClean, mediaGore]
assert(
  mediaForPageTagList(page, rules, [])
    .map((m) => m.tags.map((t) => t.name).join(','))
    .join('|') === 'safe',
  'page tags skip locked media',
)
assert(
  mediaForPageTagList(page, rules, ['a', 'b']).length === 3,
  'revealed rules include all media for page tags',
)

assert(
  lockedContentHideTagNames(rules, []).sort().join() === '18+,gore,nsfw',
  'locked tag names',
)
assert(lockedContentHideTagNames(rules, ['a']).join() === 'gore', 'revealed a drops its tags')
assert(
  excludeTagsForMediaQuery([], ['x'], rules, [])?.join() === 'x',
  'no tag filter: only base exclude',
)
assert(
  (excludeTagsForMediaQuery(['cute'], ['x'], rules, []) ?? []).sort().join() ===
    '18+,gore,nsfw,x',
  'tag filter merges hide tags',
)
assert(
  excludeTagsForMediaQuery(['cute'], undefined, rules, ['a', 'b']) === undefined,
  'all revealed: no exclude from hide rules',
)

console.log('contentHide.selftest: ok')
