/**
 * 相似词计算：解决「长得像但记不清是哪个」的检索需求。
 *
 * 纯函数、无副作用、不碰网络与存储——方便单测，也方便在 useMemo 里反复算。
 *
 * 三种距离各管一类混淆，缺一不可：
 *   - Levenshtein（编辑距离）→ 差几个字母：affect / effect、adapt / adopt
 *   - 变位距离（字符多重集差）→ 字母顺序不同：quiet / quite、form / from
 *     ⚠️ 这一类 Levenshtein 判不出（距离为 2），必须单独算
 *   - 前缀关系 → 长词的局部延伸：economic / economical
 *
 * 为什么不用拼音/音标：墨墨开放接口不提供音标，而我们只有拼写可用。
 */

/** 两词差异的呈现方式，决定 UI 用哪种高亮 */
export type DifferenceKind =
  /** 拼写几乎相同，差 1–2 个字母 */
  | 'spelling'
  /** 字母完全相同，只是顺序不同 */
  | 'anagram'
  /** 一个是另一个的前缀/词干延伸 */
  | 'affix'

export interface SimilarWord
{
  /** 目标词（用户输入或基准词） */
  target: string
  /** 候选词 */
  candidate: string
  /** 综合相似度 0–100，越大越像 */
  score: number
  /** 编辑距离；超过阈值时为 Infinity */
  distance: number
  /** 变位距离：字符多重集差，0 表示字母完全相同 */
  anagramDistance: number
  /** 差异类型，决定高亮方式与文案 */
  kind: DifferenceKind
}

/**
 * 编辑距离（Levenshtein），带 maxd 剪枝。
 *
 * 只关心「是否在阈值内」时剪枝收益很大：全库 8000 词实测 13ms，
 * 长度预筛后 6ms，用户输入时实时算无压力。
 *
 * 超过 maxd 直接返回 maxd + 1（不保证精确值，只保证「超出阈值」），
 * 调用方应只做 `<= maxd` 判断，不要拿返回值当精确距离用。
 */
export function levenshtein(a: string, b: string, maxd = 3): number
{
  if (a === b)
  {
    return 0
  }

  const la = a.length
  const lb = b.length

  // 长度差已超过阈值，不可能更近
  if (Math.abs(la - lb) > maxd)
  {
    return maxd + 1
  }

  if (la === 0)
  {
    return lb
  }

  if (lb === 0)
  {
    return la
  }

  let prev = new Array<number>(lb + 1)

  for (let j = 0; j <= lb; j++)
  {
    prev[j] = j
  }

  for (let i = 1; i <= la; i++)
  {
    const cur = new Array<number>(lb + 1)

    cur[0] = i
    let rowMin = i
    const ca = a.charCodeAt(i - 1)

    for (let j = 1; j <= lb; j++)
    {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      const value = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost)

      cur[j] = value

      if (value < rowMin)
      {
        rowMin = value
      }
    }

    // 整行最小值已超阈值，后面只会更大
    if (rowMin > maxd)
    {
      return maxd + 1
    }

    prev = cur
  }

  return prev[lb]!
}

/**
 * 变位距离：把两个词的字符计数相减，差额总数。
 *
 * 0 = 字母完全一样只是顺序不同（quiet / quite）；2 = 换了一个字母。
 * 比 Levenshtein 便宜（O(n)），且能识别后者的盲区。
 */
export function anagramDistance(a: string, b: string): number
{
  if (a === b)
  {
    return 0
  }

  // 长度差本身就是差额下限
  const counts = new Map<number, number>()
  let diff = 0

  for (let i = 0; i < a.length; i++)
  {
    const code = a.charCodeAt(i)

    counts.set(code, (counts.get(code) ?? 0) + 1)
  }

  for (let i = 0; i < b.length; i++)
  {
    const code = b.charCodeAt(i)
    const left = counts.get(code) ?? 0

    if (left > 0)
    {
      counts.set(code, left - 1)
    }
    else
    {
      diff++
    }
  }

  // a 里剩下的字符数量同样是差额
  for (const value of counts.values())
  {
    diff += value
  }

  return diff
}

/** 前缀/词干关系：短的完整出现在长的开头，且长度差不超过 4 */
function isAffixPair(a: string, b: string): boolean
{
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]

  if (short.length < 4 || long.length - short.length > 4)
  {
    return false
  }

  return long.startsWith(short)
}

/**
 * 计算候选词与目标词的相似度。
 *
 * 判定优先级（先命中先返回，避免同一对词被归到更弱的类型）：
 *   变位距离 0 且拼写不同 → anagram（字母相同、顺序不同）
 *   编辑距离 ≤ 2 → spelling
 *   前缀关系 → affix
 *
 * 返回 null 表示不够像，不应出现在结果里。
 *
 * 阈值选取依据（实测样本）：
 *   要抓住 affect/effect(1)、adapt/adopt(1)、desert/dessert(1)、
 *   quiet/quite(变位0)、form/from(变位0)、economic/economical(前缀)
 *   要排除 cat/coat(变位2, Lev1 但语义无关)、run/sun(Lev1 但太短)
 */
export function compareWords(target: string, candidate: string): SimilarWord | null
{
  const a = target.toLowerCase()
  const b = candidate.toLowerCase()

  if (!a || !b || a === b)
  {
    return null
  }

  // 短词门槛更高：3–4 字母的词差一个字母就是另一个词，噪音太大
  const shorter = Math.min(a.length, b.length)
  const maxd = shorter <= 4 ? 1 : 2

  const anagram = anagramDistance(a, b)
  const distance = levenshtein(a, b, maxd)

  // 字母完全相同、顺序不同 —— Levenshtein 会判成 2，这里优先识别
  if (anagram === 0 && distance > 0)
  {
    return {
      target: a,
      candidate: b,
      score: 95,
      distance,
      anagramDistance: anagram,
      kind: 'anagram'
    }
  }

  if (distance <= maxd)
  {
    // 差得越少分越高；变位差也计入，避免「同长度但换了一半字母」混进来
    const score = 100 - distance * 22 - Math.min(anagram, 4) * 3

    return {
      target: a,
      candidate: b,
      score: Math.max(score, 20),
      distance,
      anagramDistance: anagram,
      kind: 'spelling'
    }
  }

  if (isAffixPair(a, b))
  {
    return {
      target: a,
      candidate: b,
      score: 70,
      distance,
      anagramDistance: anagram,
      kind: 'affix'
    }
  }

  return null
}

/**
 * 在词表里找与 keyword 相似的词。
 *
 * 两级筛选：先按长度差粗筛（编辑距离不可能小于长度差），再算精确相似度。
 * 8000 词实测 6–13ms，可直接在输入时同步算。
 */
export function findSimilarWords(
  keyword: string,
  spellings: string[],
  limit = 30
): SimilarWord[]
{
  const target = keyword.trim().toLowerCase()

  if (target.length < 3)
  {
    return []
  }

  const shorter = target.length
  const maxd = shorter <= 4 ? 1 : 2
  const results: SimilarWord[] = []
  const seen = new Set<string>()

  for (const spelling of spellings)
  {
    if (!spelling)
    {
      continue
    }

    const candidate = spelling.toLowerCase()

    if (seen.has(candidate) || candidate === target)
    {
      continue
    }

    // 长度差超过阈值，编辑距离必然超阈值；但变位/前缀不受此限，放宽 4
    if (Math.abs(candidate.length - target.length) > 4)
    {
      // 前缀关系仍可能成立（economic / economical 差 3），超过 4 才算真的不相关
      continue
    }

    seen.add(candidate)

    const compared = compareWords(target, candidate)

    if (compared)
    {
      results.push(compared)
    }
  }

  return results.sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate)).slice(0, limit)
}

/**
 * 差异对齐：返回两词的高亮分段，供 UI 渲染。
 *
 * 算法是「最长公共前缀 + 最长公共后缀」，中间剩下的整段算差异。
 *
 * 为什么不用逐位对齐：字母移位时逐位会碎成一片。
 * 例 except / expect 逐位比 → ex|c|e|p|t（每两个字母一段，看不出所以然）；
 *    用前后缀 → ex + [cep|pec] + t，一眼看出中间这截被换过。
 * 拼写只差一个字符时（affect / effect）两种算法结果相同，所以不存在取舍。
 */
export interface DiffSegment
{
  a: string
  b: string
  same: boolean
}

export function alignDiff(a: string, b: string): DiffSegment[]
{
  const segments: DiffSegment[] = []
  const maxPrefix = Math.min(a.length, b.length)
  let prefix = 0

  // 公共前缀：从头往后比到第一个不同
  while (prefix < maxPrefix && a[prefix] === b[prefix])
  {
    prefix++
  }

  // 公共后缀：从尾往前比，但不能越进已确认的前缀区
  let suffix = 0

  while (
    suffix < Math.min(a.length, b.length) - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
  {
    suffix++
  }

  const aMid = a.slice(prefix, a.length - suffix)
  const bMid = b.slice(prefix, b.length - suffix)

  if (prefix > 0)
  {
    segments.push({ a: a.slice(0, prefix), b: b.slice(0, prefix), same: true })
  }

  if (aMid || bMid)
  {
    segments.push({ a: aMid, b: bMid, same: false })
  }

  if (suffix > 0)
  {
    segments.push({ a: a.slice(a.length - suffix), b: b.slice(b.length - suffix), same: true })
  }

  return segments
}

/** 混淆对：两个词互为高危干扰源 */
export interface ConfusablePair
{
  a: string
  b: string
  /** 两词的综合可信度 0–100 */
  score: number
  /** 差异类型（取多数判定） */
  kind: DifferenceKind
  /** 编辑距离 */
  distance: number
  /** 变位距离 */
  anagramDistance: number
  /** 长度相同的完全替换型（最典型的「差一点」） */
  sameLength: boolean
}

/**
 * 全库混淆对检测。
 *
 * 朴素两两比较是 O(n²)：8000 词 = 3200 万次，不可接受。
 * 三组预索引把候选量压到可接受范围：
 *   1. 变位签名（字符排序后相同）→ 直接成对，抓 quiet/quite
 *   2. 首字母 + 长度分桶 → 抓 affect/effect（首字母相同、长度相同）
 *   3. 删一字签名（SymSpell 思路）→ 抓 Lev=1 但首字母不同的情况
 *
 * 阈值偏保守：宁可少报，也不要刷出一堆 cat/coat 这种噪音。
 */
export function buildConfusablePairs(
  spellings: string[],
  options: { minLength?: number; limit?: number } = {}
): ConfusablePair[]
{
  const minLength = options.minLength ?? 5
  const limit = options.limit ?? 200

  // 去重 + 过滤过短的词（3–4 字母的短词差一字母换义词概率太高，噪音大）
  const words = [...new Set(spellings.map((item) => item?.toLowerCase()).filter(Boolean))]
    .filter((item) => item.length >= minLength)

  const wordSet = new Set(words)
  const pairs = new Map<string, ConfusablePair>()

  const push = (a: string, b: string): void =>
  {
    const [first, second] = a <= b ? [a, b] : [b, a]
    const key = `${first}|${second}`

    if (pairs.has(key))
    {
      return
    }

    const compared = compareWords(first, second)

    if (!compared)
    {
      return
    }

    pairs.set(key, {
      a: first,
      b: second,
      score: compared.score,
      kind: compared.kind,
      distance: compared.distance,
      anagramDistance: compared.anagramDistance,
      sameLength: first.length === second.length
    })
  }

  // 1. 变位签名：字符排序后相同即为 anagram 对
  const bySignature = new Map<string, string[]>()

  for (const word of words)
  {
    const signature = [...word].sort().join('')
    const bucket = bySignature.get(signature)

    if (bucket)
    {
      bucket.push(word)
    }
    else
    {
      bySignature.set(signature, [word])
    }
  }

  for (const bucket of bySignature.values())
  {
    if (bucket.length < 2)
    {
      continue
    }

    // 同签名分组内两两成对：正常情况下极小（同字母异序的词很少）
    for (let i = 0; i < bucket.length; i++)
    {
      for (let j = i + 1; j < bucket.length; j++)
      {
        push(bucket[i]!, bucket[j]!)
      }
    }
  }

  // 2. 首字母 + 长度分桶：affect/effect 这类首字母相同的替换
  const byHead = new Map<string, string[]>()

  for (const word of words)
  {
    const key = `${word[0]}:${word.length}`
    const bucket = byHead.get(key)

    if (bucket)
    {
      bucket.push(word)
    }
    else
    {
      byHead.set(key, [word])
    }
  }

  for (const bucket of byHead.values())
  {
    if (bucket.length < 2)
    {
      continue
    }

    for (let i = 0; i < bucket.length; i++)
    {
      for (let j = i + 1; j < bucket.length; j++)
      {
        push(bucket[i]!, bucket[j]!)
      }
    }
  }

  // 3. 删一字签名：抓「首字母不同但只差一个字母」的对
  //    每个词删掉任一位得到 n 个签名，同签名的两词编辑距离 ≤ 2
  const byDeleted = new Map<string, string[]>()

  for (const word of words)
  {
    // 只在长词上跑：删字签名对 5–7 字母的词召回最好，长词组合数爆炸
    if (word.length > 12)
    {
      continue
    }

    for (let i = 0; i < word.length; i++)
    {
      const signature = `${word.length}:${word.slice(0, i)}${word.slice(i + 1)}`
      const bucket = byDeleted.get(signature)

      if (bucket)
      {
        if (bucket.length < 8)
        {
          bucket.push(word)
        }
      }
      else
      {
        byDeleted.set(signature, [word])
      }
    }
  }

  for (const bucket of byDeleted.values())
  {
    if (bucket.length < 2)
    {
      continue
    }

    for (let i = 0; i < bucket.length; i++)
    {
      for (let j = i + 1; j < bucket.length; j++)
      {
        // 同一对可能因多个删除位置重复命中，push 内部有去重
        push(bucket[i]!, bucket[j]!)
      }
    }
    }

  // 只保留两个词都确实在词库里的（理论上都满足，防御脏数据）
  return [...pairs.values()]
    .filter((pair) => wordSet.has(pair.a) && wordSet.has(pair.b))
    .map((pair) =>
    {
      // 排序加权：同长度的完全替换、字母顺序颠倒最值得看；
      // 词干延伸（produce / product）意义相近，混淆风险次之
      let boost = 0

      if (pair.sameLength)
      {
        boost += 12
      }

      if (pair.kind === 'anagram')
      {
        boost += 15
      }
      else if (pair.kind === 'affix')
      {
        boost -= 18
      }

      return { ...pair, score: Math.max(0, Math.min(100, pair.score + boost)) }
    })
    .sort((a, b) => b.score - a.score || a.a.localeCompare(b.a))
    .slice(0, limit)
}
