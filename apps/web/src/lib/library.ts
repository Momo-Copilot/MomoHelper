/**
 * 词库数据层：全量拉取 + IndexedDB 缓存。
 *
 * 为什么用 IndexedDB 而不是 localStorage：8000+ 条记录约 2MB，
 * localStorage 5MB 配额会被吃掉近一半，且每次读写都全量序列化；
 * IndexedDB 存结构化对象、按 vocId 建主键，读写都不经过 JSON.stringify。
 *
 * 缓存策略（尽量减少请求）：
 *   6 小时内     → 直接用缓存，0 请求
 *   6–24 小时    → 花 1 个 as_count 请求比对总数，没变就沿用缓存
 *   超过 24 小时 / 总数变了 / 手动刷新 → 全量重拉（约 9 个请求）
 */

import { queryStudyRecords, queryStudyRecordsAll } from '@momo/maimemo'
import type { LibraryRecordRowDto, LibrarySnapshotDto, MaimemoStudyRecord } from '@momo/types'

import { getMaimemoClient } from './maimemo'

const DB_NAME = 'momo-library'
const DB_VERSION = 1
const STORE_RECORDS = 'records'
const STORE_META = 'meta'
const META_KEY = 'snapshot'
/** 每批写入条数：一次事务塞 8000 条会长时间占住主线程 */
const WRITE_BATCH = 500

const FRESH_MS = 6 * 60 * 60 * 1000
const MAX_AGE_MS = 24 * 60 * 60 * 1000

interface LibraryMeta
{
  key: string
  total: number | null
  complete: boolean
  fetchedAt: string
}

export interface LibraryLoadOptions
{
  /** 跳过缓存，强制全量重拉 */
  force?: boolean
  /** 每翻一页回吐已拉取条数 */
  onProgress?: (loaded: number, total: number | null) => void
  /**
   * 因频控排队时回调（毫秒）。
   * 全量拉取 8613 条约 53 个请求，会撞 40 次 / 60 秒的窗口排近 1 分钟，
   * UI 靠它显示「等待频控」而不是让进度条静止不动。
   */
  onRateLimitWait?: (waitMs: number) => void
}

/* ============================ IndexedDB ============================ */

let dbPromise: Promise<IDBDatabase> | null = null

/**
 * 打开库，并确保两个 store 都存在。
 *
 * 自愈：库存在、版本号已是 DB_VERSION 但 store 缺失时，onupgradeneeded 不会
 * 再触发，这种「空壳库」会永久损坏 —— 之后所有读写抛 NotFoundError，且不会
 * 自我修复。常见来历：调试脚本裸 open(DB_NAME) 建了个空库，或删除事务被
 * 中断。表现为词库页一直报错、备份里 librarySnapshot 恒为 null，用户只能去
 * 清空站点数据。
 *
 * 处理：检测到结构缺失就关连接、用「当前版本 + 1」重开一次（版本升高必然
 * 触发 onupgradeneeded 建表）。不改 DB_VERSION 常量，正常用户不受影响。
 */
function openDb(): Promise<IDBDatabase>
{
  return new Promise((resolve, reject) =>
  {
    if (typeof indexedDB === 'undefined')
    {
      reject(new Error('当前环境不支持 IndexedDB'))
      return
    }

    const ensureStores = (db: IDBDatabase): void =>
    {
      if (!db.objectStoreNames.contains(STORE_RECORDS))
      {
        db.createObjectStore(STORE_RECORDS, { keyPath: 'vocId' })
      }

      if (!db.objectStoreNames.contains(STORE_META))
      {
        db.createObjectStore(STORE_META, { keyPath: 'key' })
      }
    }

    /**
     * 不指定版本打开：拿到「现有版本」。
     *
     * 不能直接用 open(DB_NAME, DB_VERSION)：若库已被抬过版本（自愈会 +1），
     * 现有版本 > DB_VERSION，直接指定低版本会抛 VersionError，
     * 之后每次打开都失败 —— 比原来的空壳库更糟。
     */
    const probe = indexedDB.open(DB_NAME)
    probe.onupgradeneeded = () => ensureStores(probe.result)
    probe.onerror = () => reject(probe.error ?? new Error('打开 IndexedDB 失败'))
    probe.onblocked = () => reject(new Error('IndexedDB 被其他标签页占用'))
    probe.onsuccess = () =>
    {
      const db = probe.result
      const ok = db.objectStoreNames.contains(STORE_RECORDS) && db.objectStoreNames.contains(STORE_META)

      if (ok)
      {
        resolve(db)
        return
      }

      /*
       * 空壳库（库在、版本已达 DB_VERSION、但没有 store）：
       * onupgradeneeded 只在版本升高时触发，这种状态永远补不了表，
       * 之后所有读写抛 NotFoundError 且不会自愈 —— 用户只能清站点数据。
       *
       * 处理：抬到「现有版本 + 1」重开，强制触发 onupgradeneeded 建表。
       * 注意要基于 db.version 而不是 DB_VERSION。
       */
      const next = Math.max(db.version, DB_VERSION) + 1
      db.close()

      const rebuild = indexedDB.open(DB_NAME, next)
      rebuild.onupgradeneeded = () => ensureStores(rebuild.result)
      rebuild.onerror = () => reject(rebuild.error ?? new Error('重建 IndexedDB 失败'))
      rebuild.onblocked = () => reject(new Error('IndexedDB 被其他标签页占用'))
      rebuild.onsuccess = () => resolve(rebuild.result)
    }
  })
}

function getDb(): Promise<IDBDatabase>
{
  if (!dbPromise)
  {
    dbPromise = openDb().catch((error: unknown) =>
    {
      // 打开失败不要缓存失败态，下次进页面还能重试
      dbPromise = null
      throw error
    })
  }

  return dbPromise
}

function txDone(tx: IDBTransaction): Promise<void>
{
  return new Promise((resolve, reject) =>
  {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB 事务失败'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'))
  })
}

async function readAll<T>(storeName: string): Promise<T[]>
{
  const db = await getDb()
  const tx = db.transaction(storeName, 'readonly')
  const request = tx.objectStore(storeName).getAll()

  await txDone(tx)

  return (request.result ?? []) as T[]
}

async function putMeta(meta: LibraryMeta): Promise<void>
{
  const db = await getDb()
  const tx = db.transaction(STORE_META, 'readwrite')

  tx.objectStore(STORE_META).put(meta)
  await txDone(tx)
}

/** 整表替换：先清空再分批写，避免新旧记录混在一起 */
async function replaceRecords(records: LibraryRecordRowDto[]): Promise<void>
{
  const db = await getDb()

  const clearTx = db.transaction(STORE_RECORDS, 'readwrite')
  clearTx.objectStore(STORE_RECORDS).clear()
  await txDone(clearTx)

  for (let i = 0; i < records.length; i += WRITE_BATCH)
  {
    const tx = db.transaction(STORE_RECORDS, 'readwrite')
    const store = tx.objectStore(STORE_RECORDS)

    for (const record of records.slice(i, i + WRITE_BATCH))
    {
      store.put(record)
    }

    await txDone(tx)
  }
}

/* ============================ 缓存读写 ============================ */

interface CachedLibrary
{
  records: LibraryRecordRowDto[]
  meta: LibraryMeta
}

/**
 * 只读诊断：当前词库缓存到底处于什么状态。
 *
 * 备份里 librarySnapshot 为 null 时，用户无法自查是「没加载过」「加载不全」
 * 还是「IndexedDB 坏了」。这个函数把三种情况区分开，供设置页直接显示。
 */
export async function inspectLibraryCache(): Promise<{
  state: 'absent' | 'incomplete' | 'ready'
  records: number
  total: number | null
  fetchedAt: string | null
}>
{
  const cached = await readCache()

  if (!cached)
  {
    return { state: 'absent', records: 0, total: null, fetchedAt: null }
  }

  return {
    state: cached.meta.complete ? 'ready' : 'incomplete',
    records: cached.records.length,
    total: cached.meta.total,
    fetchedAt: cached.meta.fetchedAt
  }
}

/** 读缓存；IndexedDB 不可用或数据缺失时返回 null（调用方走全量拉取） */
async function readCache(): Promise<CachedLibrary | null>
{
  try
  {
    const [records, metas] = await Promise.all([
      readAll<LibraryRecordRowDto>(STORE_RECORDS),
      readAll<LibraryMeta>(STORE_META)
    ])
    const meta = metas.find((item) => item.key === META_KEY)

    if (!meta || records.length === 0)
    {
      return null
    }

    return { records, meta }
  }
  catch
  {
    return null
  }
}

/** 写缓存；失败只影响下次是否重拉，不影响本次展示 */
async function writeCache(records: LibraryRecordRowDto[], meta: LibraryMeta): Promise<void>
{
  try
  {
    // 先把 meta 落成「不完整」：replaceRecords 要分 16 批写 8000 条，
    // 中途失败（关页面、配额、被回收）会留下半截记录。若此时旧 meta 还写着
    // complete=true，页面会把缺了词的快照当成完整数据展示，而且 fetchedAt
    // 也被沿用，能一直撑到缓存自然过期。先置 false，失败即作废重拉。
    await putMeta({ ...meta, complete: false })
    await replaceRecords(records)
    await putMeta(meta)
  }
  catch
  {
    // 忽略：隐私模式等场景下 IndexedDB 可能被禁用
  }
}

function ageOf(iso: string): number
{
  const time = new Date(iso).getTime()

  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : Date.now() - time
}

function toSnapshot(cached: CachedLibrary): LibrarySnapshotDto
{
  return {
    records: cached.records,
    total: cached.meta.total,
    complete: cached.meta.complete,
    fetchedAt: cached.meta.fetchedAt
  }
}

/* ============================ 对外入口 ============================ */

/** 只读缓存（不触发任何拉取）：看板学情入口卡用；无完整缓存返回 null */
export async function peekLibraryCache(): Promise<LibrarySnapshotDto | null>
{
  try
  {
    const raw = await readCache()

    return raw && raw.meta.complete ? toSnapshot(raw) : null
  }
  catch
  {
    return null
  }
}

/** 学习记录（snake_case）→ 词库行（camelCase） */
function toRow(record: MaimemoStudyRecord): LibraryRecordRowDto
{
  return {
    vocId: record.voc_id,
    spelling: record.voc_spelling,
    studyCount: record.study_count ?? 0,
    lastResponse: record.last_response,
    tags: record.tags ?? [],
    addDate: record.add_date,
    firstStudyDate: record.first_study_date,
    lastStudyDate: record.last_study_date,
    nextStudyDate: record.next_study_date
  }
}

/** 读词库：优先缓存，必要时全量拉取 */
export async function loadLibrary(
  options: LibraryLoadOptions = {}
): Promise<LibrarySnapshotDto>
{
  // 上次没拉全的缓存直接作废：否则页面会一直显示偏小的统计，
  // 直到缓存自然过期（最多 24 小时）才重试，用户以为数据就是这么多
  const raw = options.force ? null : await readCache()
  // 不完整缓存也复用：完全没有 next_study_date 的词日期区间覆盖不到，
  // 这类账号每次进页面重拉 50+ 个请求、结果还是同样偏小，纯属白花额度。
  // 保留 FRESH_MS 窗口，过期再试；用户也可以在词库页手动「重新拉取」强制一次。
  const cached = raw ?? null

  if (cached)
  {
    const age = ageOf(cached.meta.fetchedAt)

    if (age < FRESH_MS)
    {
      return toSnapshot(cached)
    }

    if (age < MAX_AGE_MS)
    {
      // 只花 1 个请求确认总数：词数没变说明没有新增/移除，缓存仍然可信
      try
      {
        const client = getMaimemoClient()
        const countResult = await queryStudyRecords(client, { asCount: true })
        const total = countResult.count ?? null

        if (total !== null && total === cached.meta.total)
        {
          const meta: LibraryMeta = { ...cached.meta, fetchedAt: new Date().toISOString() }

          await putMeta(meta).catch(() => undefined)

          return toSnapshot({ records: cached.records, meta })
        }
      }
      catch
      {
        // 比对失败就走全量；不要因为一次 as_count 失败挡住整个页面
      }
    }
  }

  const client = getMaimemoClient({ onRateLimitWait: options.onRateLimitWait })
  const result = await queryStudyRecordsAll(client, {
    onProgress: options.onProgress
  })
  const records = result.records.map(toRow)
  const fetchedAt = new Date().toISOString()
  const meta: LibraryMeta = {
    key: META_KEY,
    // as_count 可能为 null，用实际到手条数兜底
    total: result.total ?? records.length,
    complete: result.complete,
    fetchedAt
  }

  await writeCache(records, meta)

  return { records, total: meta.total, complete: meta.complete, fetchedAt }
}

/* ============================ 备份集成 ============================ */

/**
 * 供 backup.ts 读取快照（records + meta），无缓存返回 null。
 *
 * 不完整也返回：墨墨 query_study_records 本身拉不全（单请求被截断、offset
 * 不生效、日期窗口只覆盖有排期的词），坚持「只备完整快照」等于备份里永远
 * 没有词库。半份数据至少离线可看，恢复后 loadLibrary 读到 complete=false
 * 会自动重拉补全。
 */
async function readSnapshotForBackup(): Promise<{
  records: unknown[]
  meta: unknown
} | null>
{
  const cached = await readCache()

  return cached ? { records: cached.records, meta: cached.meta } : null
}

/**
 * 供 backup-restore.ts 写回快照。
 *
 * 本机快照比远端新时保留本机：恢复是「把云端数据补回来」，不该把当前数据
 * 退回去。比较用 meta.fetchedAt —— 它是上一次真实拉取的时间，能代表数据新旧。
 * 返回三态而不是布尔，是为了让 UI 能说清「到底写回了没有」。
 */
async function writeSnapshotFromBackup(snapshot: {
  records: unknown[]
  meta: unknown
}): Promise<'restored' | 'skipped' | 'failed'>
{
  try
  {
    const records = snapshot.records as LibraryRecordRowDto[]
    const meta = snapshot.meta as LibraryMeta

    if (!Array.isArray(records) || !meta?.fetchedAt)
    {
      return 'failed'
    }

    const current = await readCache()

    if (current)
    {
      const localAt = Date.parse(current.meta.fetchedAt)
      const remoteAt = Date.parse(meta.fetchedAt)

      // 解析失败（脏数据）时按「本机优先」保守处理，不覆盖
      if (Number.isNaN(remoteAt) || (!Number.isNaN(localAt) && localAt >= remoteAt))
      {
        return 'skipped'
      }

      // 远端时间更新但条数更少：多半是它导出时接口只拉到一部分。
      // 本机已经完整时不能被一份残缺数据顶掉。
      if (current.meta.complete && records.length < current.records.length)
      {
        return 'skipped'
      }
    }

    // 与 writeCache 同样的顺序：先落「不完整」标记，中途失败就让缓存作废，
    // 而不是留下半截记录配一份写着 complete=true 的 meta。
    await putMeta({ ...meta, key: META_KEY, complete: false })
    await replaceRecords(records)
    await putMeta({ ...meta, key: META_KEY })

    return 'restored'
  }
  catch
  {
    return 'failed'
  }
}

import { registerLibraryReader } from './backup'
import { registerLibraryWriter } from './backup-restore'

registerLibraryReader(readSnapshotForBackup)
registerLibraryWriter(writeSnapshotFromBackup)
