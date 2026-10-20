/** Name matching across scripts and spellings: Russian Cyrillic, Uzbek Latin
 * and English names of the same venue ("Ильхом", "Ilhom Theatre",
 * "Ilkhom teatri") should meet in one canonical form. Used to geocode venues
 * named in posts and to find places the model mentioned in its answer. */

const CYR: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
  м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sh', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: 'o', қ: 'k', ғ: 'g', ҳ: 'h',
}

export function canon(s: string): string {
  // Cyrillic first (й must become "y", not "i" + a combining breve), then
  // Latin diacritics are stripped: Atatürk -> ataturk.
  let t = [...s.normalize('NFC').toLowerCase()].map((c) => CYR[c] ?? c).join('')
  t = t
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/['’ʻʼ‘`"«»“”„]/g, '')
    .replace(/kh/g, 'h')
    .replace(/x/g, 'h')
    .replace(/th/g, 't')
    .replace(/yo/g, 'e')
    .replace(/q/g, 'k')
    // Uzbek Latin writes "o" where Russian writes "а": Toshkent / Ташкент,
    // Yunusobod / Юнусабад, Chilonzor / Чиланзар. Both sides go through
    // canon(), so folding o into a only costs a little precision.
    .replace(/o/g, 'a')
    .replace(/[^a-z0-9]+/g, ' ')
  return t.trim().replace(/\s+/g, ' ')
}

/** Words that say what a place is, not which one it is, with the category
 * they hint at (null: no category). */
const KIND_WORDS: Record<string, string | null> = {
  teatr: 'theatre', teatri: 'theatre', theatre: 'theatre', theater: 'theatre',
  muzey: 'museum', muzei: 'museum', muzeyi: 'museum', museum: 'museum', galereya: 'museum', gallery: 'museum',
  kino: 'cinema', kinoteatr: 'cinema', cinema: 'cinema',
  park: 'park', parki: 'park', parks: 'park', bogi: 'park', bog: 'park', garden: 'park', sad: 'park',
  kafe: 'cafe', cafe: 'cafe', kofe: 'cafe', coffee: 'cafe', kofeynya: 'cafe',
  restoran: 'restaurant', restaurant: 'restaurant',
  bar: 'bar', pub: 'bar',
  bazar: 'market', bozor: 'market', bozori: 'market', bazaar: 'market', market: 'market', rynok: 'market',
  apteka: 'pharmacy', dorixona: 'pharmacy', pharmacy: 'pharmacy',
  bank: 'bank',
  gostinitsa: 'hotel', mehmonxona: 'hotel', hotel: 'hotel', hostel: 'hotel',
  magazin: null, supermarket: null, tsentr: null, center: null, centre: null, markaz: null, markazi: null,
  gosudarstvennyy: null, davlat: null, state: null, natsionalnyy: null, milliy: null, national: null,
  dvorets: null, saroy: null, saroyi: null, palace: null, zal: null, hall: null,
  ploshad: null, maydon: null, maydoni: null, square: null, ulitsa: null, kochasi: null, street: null, st: null,
  dom: null, uy: null, akademicheskiy: null, akademik: null, academic: null, bolshoy: null, katta: null,
  grand: null, opera: null, ballet: null, baleta: null, opery: null,
  the: null, of: null, and: null, im: null, imeni: null, named: null, after: null, na: null, v: null,
  in: null, at: null, u: null, y: null, va: null,
}

const KIND_OF_WORD = new Map(Object.entries(KIND_WORDS).map(([w, k]) => [canon(w), k]))

/** Words of the city's own name: "in Tashkent" must not geocode to
 * "Tashkent Tower". Filled from the snapshot at startup. */
const cityWords: string[] = []

export function setCityWords(names: string[]) {
  cityWords.length = 0
  for (const n of names) for (const w of canon(n).split(' ')) if (w.length > 3) cityWords.push(w)
}

/** Distinctive words of a name or a query: no generic place words, no city name. */
export function tokens(s: string): string[] {
  return canon(s)
    .split(' ')
    .filter((w) => w.length > 1 && !KIND_OF_WORD.has(w) && !cityWords.some((c) => inflectionOf(w, c)))
}

/** Categories the text hints at by its generic words: "Magic Museum" -> museum. */
export function kindHints(s: string): Set<string> {
  const out = new Set<string>()
  for (const w of canon(s).split(' ')) {
    const k = KIND_OF_WORD.get(w)
    if (k) out.add(k)
  }
  return out
}

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      best = Math.min(best, cur[j])
    }
    if (best > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

/** `word` is `base` with a case ending: "yunusabade" from "yunusabad",
 * "ilhame" from "ilham". Only this direction — "land" is not a form of "landan". */
function inflectionOf(word: string, base: string): boolean {
  return word === base || (base.length >= 4 && word.startsWith(base) && word.length - base.length <= 2)
}

/** Does a word of a query (possibly inflected or misspelt by one letter) stand
 * for a word of a name? Edit distance only on long words: "istariya" (история)
 * must not become "viktariya". */
export function wordMatch(queryWord: string, nameWord: string): boolean {
  if (inflectionOf(queryWord, nameWord)) return true
  const len = Math.min(queryWord.length, nameWord.length)
  return len >= 7 && editDistance(queryWord, nameWord, 1) <= 1
}

/** 0..1: how well `query` names the same thing as `name` — the harmonic mean
 * of how much of the name is found in the query and how much of the query is
 * explained by the name. "театр Навои" vs "Alisher Navoi Opera and Ballet
 * Theatre": 0.67; "Ilkhom" vs "Ilhom Theatre": 1. */
export function nameScore(query: string, name: string): number {
  const q = tokens(query)
  const n = tokens(name)
  if (!q.length || !n.length) return 0
  const nameHits = n.filter((w) => q.some((x) => wordMatch(x, w))).length
  const queryHits = q.filter((x) => n.some((w) => wordMatch(x, w))).length
  if (!nameHits || !queryHits) return 0
  const p = nameHits / n.length
  const r = queryHits / q.length
  return (2 * p * r) / (p + r)
}

/** Share of the name's distinctive words found in the query (inflection and
 * one-letter typos allowed): "Yunusobod" is fully covered by "Yunusobod
 * district, near the metro". */
export function nameCoverage(query: string, name: string): number {
  const q = tokens(query)
  const n = tokens(name)
  if (!q.length || !n.length) return 0
  return n.filter((w) => q.some((x) => wordMatch(x, w))).length / n.length
}

/** Is the whole name written in the text as one phrase? Exact words, only the
 * last one may carry a case ending ("в «Ильхоме»"). Used on raw post text,
 * where fuzzy matching finds look-alikes everywhere. */
export function phraseIn(textWords: string[], nameWords: string[]): boolean {
  if (!nameWords.length) return false
  outer: for (let i = 0; i + nameWords.length <= textWords.length; i++) {
    for (let j = 0; j < nameWords.length; j++) {
      const w = textWords[i + j]
      const last = j === nameWords.length - 1
      if (last ? !inflectionOf(w, nameWords[j]) : w !== nameWords[j]) continue outer
    }
    return true
  }
  return false
}

/** Was `name` mentioned in `text` as a whole phrase (not inside a longer
 * word)? From LensMap's advisor: "555" must not match inside "5555". */
export function mentionedIn(text: string, name: string): boolean {
  const t = text.toLowerCase()
  const n = name.toLowerCase().trim()
  if (n.length < 3) return false
  const isWord = (c: string) => /[\p{L}\p{N}]/u.test(c)
  let from = 0
  while (from <= t.length) {
    const i = t.indexOf(n, from)
    if (i === -1) return false
    const before = i === 0 ? ' ' : t[i - 1]
    const after = i + n.length >= t.length ? ' ' : t[i + n.length]
    if (!isWord(before) && !isWord(after)) return true
    from = i + 1
  }
  return false
}
