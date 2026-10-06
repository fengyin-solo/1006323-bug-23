import { SEED_ROWS } from './seed'
import type { EntryRow, StoreCommit, StoreMeta } from './types'

// 本地持久化：业务行和元信息各占一个键，一次写同一个事务里的全部键，刷新、关掉再打开都还在。
const STORAGE_KEY = 'urban-utility-tunnel:entries'
const META_KEY = 'urban-utility-tunnel:meta'
export const SCHEMA_VERSION = 2

// 幂等台账只留近期窗口，避免无限增长：窗口内同一实体同一动作只认第一次。
const LEDGER_WINDOW_MS = 30_000

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function isDateLike(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
}

function defaultMeta(): StoreMeta {
  return { schemaVersion: SCHEMA_VERSION, actionLedger: [] }
}

/**
 * 上线前检测台账的一次性补录（只对消防设施的既有 v1 记录生效）：
 * - 上次检测日缺失：用当时那版的联动测试日补，取不到就留空；
 * - 下发日期历史缺值：留空不臆造；
 * - 凡是留空的关键字段记入「残缺字段」并在页面标出来；
 * - 既有记录按当时口径保留原判（状态、结论不动）。
 * 新记录（v2）不进这条迁移路径。
 */
function migrateFireRows(rows: EntryRow[]): EntryRow[] {
  const archivalFields = ['下发日期', '上次检测日']
  return rows.map((row) => {
    if (String(row['口径版本'] ?? '') === 'v2') {
      return row
    }
    const next: EntryRow = { ...row, 口径版本: 'v1' }
    if (!isDateLike(next['上次检测日'])) {
      const linked = next['联动测试日']
      next['上次检测日'] = isDateLike(linked) ? String(linked) : ''
    }
    if (!isDateLike(next['下发日期'])) {
      next['下发日期'] = ''
    }
    const missing = archivalFields.filter((field) => String(next[field] ?? '').trim() === '')
    next['残缺字段'] = missing.join('、')
    return next
  })
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    fallback.firecontrol = migrateFireRows(fallback.firecontrol ?? [])
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    fallback.firecontrol = migrateFireRows(fallback.firecontrol ?? [])
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    if (!window.localStorage.getItem(META_KEY)) {
      window.localStorage.setItem(META_KEY, JSON.stringify(defaultMeta()))
    }
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = { ...fallback, ...parsed }
    merged.firecontrol = migrateFireRows(merged.firecontrol ?? [])
    // 迁移结果写回，保证刷新后补录值与残缺标记仍在；meta 缺失时同批补齐。
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
    if (!window.localStorage.getItem(META_KEY)) {
      window.localStorage.setItem(META_KEY, JSON.stringify(defaultMeta()))
    }
    return merged
  } catch {
    fallback.firecontrol = migrateFireRows(fallback.firecontrol ?? [])
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

function readMeta(): StoreMeta {
  if (typeof window === 'undefined' || !window.localStorage) {
    return defaultMeta()
  }
  const raw = window.localStorage.getItem(META_KEY)
  if (!raw) {
    const meta = defaultMeta()
    window.localStorage.setItem(META_KEY, JSON.stringify(meta))
    return meta
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoreMeta>
    return {
      schemaVersion: typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : SCHEMA_VERSION,
      actionLedger: Array.isArray(parsed.actionLedger) ? parsed.actionLedger : [],
    }
  } catch {
    return defaultMeta()
  }
}

let cache: Record<string, EntryRow[]> | null = null
let metaCache: StoreMeta | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function getRow(key: string, id: number): EntryRow | undefined {
  return listRows(key).find((row) => Number(row.id) === id)
}

export function meta(): StoreMeta {
  if (metaCache === null) {
    metaCache = readMeta()
  }
  return metaCache
}

/** 幂等键命中（且在窗口内）即视为同一笔重复提交，只认第一次落库的那次。 */
export function findLedger(key: string): StoreMeta['actionLedger'][number] | undefined {
  const now = Date.now()
  return meta().actionLedger.find(
    (entry) => entry.key === key && now - new Date(entry.at).getTime() < LEDGER_WINDOW_MS,
  )
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

/**
 * 一次落库：把本笔涉及的所有模块行（消防结论、隐患清单、值班台账等）连同幂等台账
 * 在同一次写入里提交。中途任一步抛错都不落任何键，报错后页面仍是上一笔的状态，不残留半成品。
 */
export function commit(commitSpec: StoreCommit): void {
  const base = allRows()
  const nextData: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(commitSpec.upserts ?? {})) {
    nextData[key] = rows
  }
  const merged: Record<string, EntryRow[]> = { ...base, ...nextData }

  const nextMeta: StoreMeta = {
    ...meta(),
    actionLedger: commitSpec.ledger
      ? [...meta().actionLedger, ...commitSpec.ledger]
      : meta().actionLedger,
  }

  if (typeof window !== 'undefined' && window.localStorage) {
    // 先序列化：序列化失败时一个键都不写。
    const dataPayload = JSON.stringify(merged)
    const metaPayload = JSON.stringify(nextMeta)
    window.localStorage.setItem(STORAGE_KEY, dataPayload)
    window.localStorage.setItem(META_KEY, metaPayload)
  }
  cache = merged
  metaCache = nextMeta
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commit({ upserts: { [key]: rows } })
}

export function appendRows(key: string, added: EntryRow[]): EntryRow[] {
  const rows = [...listRows(key), ...added]
  saveRows(key, rows)
  return rows
}

export function makeId(key: string): number {
  return nextId(listRows(key))
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export { today }
export function storageKey(): string {
  return STORAGE_KEY
}
