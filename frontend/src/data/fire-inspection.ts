import { allRows, saveAll } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 消防设施检测统一口径（全局唯一实现，列表 / 详情面板 / 导出清单 / 隐患整改 / 值班台账都从这里取数）
//
// 1. 状态机（只许推进、不许回退）：
//    待检测 → 检测中 → 状态正常 / 需维修 → 已结案
//    已结案是终态：已结案的记录不再退回检测中，任何推进动作都整笔退回。
// 2. 一次落库：提交检测、判定正常、提出维修、结案都在一次事务里克隆整份数据、
//    校验通过后单次写入；维修结论同事务写到隐患整改清单，结案同事务在值班台账留痕。
// 3. 结论同源：检测结论、维修结论、检测日期、探测器数量只存在 firecontrol 行上，
//    隐患清单、值班台账只镜像，不另存一份自己的值——各处展示永远对得上。
// 4. 同一设施重复提交只推进一次：状态已推进则整笔按重复退回，只认第一次落库。
// 5. 口径版本：v1 为改版前记录，按当时口径保留原判、冻结不再流转；新口径只对 v2 记录生效。
//    v1 历史台账按下发日期一次性补录，残缺字段留空并用「残缺字段」标出。
// 6. 关键数值（探测器数量）随结案镜像到值班台账，两边条数由同一选择器计数，必然一致。

export const FIRE_KEY = 'firecontrol'
export const HAZARD_KEY = 'hazard'
export const DUTY_KEY = 'duty'

export const FIRE_STATUS = {
  pending: '待检测',
  inspecting: '检测中',
  normal: '状态正常',
  repair: '需维修',
  closed: '已结案',
} as const

export const FIRE_STATUSES = [
  FIRE_STATUS.pending,
  FIRE_STATUS.inspecting,
  FIRE_STATUS.normal,
  FIRE_STATUS.repair,
  FIRE_STATUS.closed,
]

export const FIRE_FIELDS = [
  '设施编号',
  '所属舱室',
  '消防类型',
  '探测器数量',
  '联动测试日',
  '责任人员',
  '下发日期',
  '上次检测日期',
  '下次检测日',
  '检测日期',
  '检测结论',
  '维修结论',
  '残缺字段',
  '口径版本',
  '补录批次',
  '消防状态',
] as const

const LEGACY_VERSION = 'v1'
const CURRENT_VERSION = 'v2'
const SOURCE_MODULE = '消防设施检测'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function oneYearLater(date: string): string {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  if (!matched) {
    return ''
  }
  return `${Number(matched[1]) + 1}-${matched[2]}-${matched[3]}`
}

function detectorCount(row: EntryRow): number | null {
  const raw = row['探测器数量']
  if (raw === '' || raw === undefined || raw === null) {
    return null
  }
  const count = Number(raw)
  return Number.isFinite(count) && count > 0 ? count : null
}

function flagMissing(row: EntryRow, missing: string[]): void {
  if (missing.length > 0) {
    row['残缺字段'] = missing.join('、')
  }
}

// ---- 上线前历史台账补录 -----------------------------------------------------
// 按当时口径留档：按下发日期一次性补齐，检测日期取上次检测日期（缺则按下发日期），
// 缺的取值留空、不臆造，并在「残缺字段」里标出来；只跑一次，补过的带批次号。
export function backfillLegacy(row: EntryRow, issueDate: string, lastInspectionDate?: string): EntryRow {
  const filled: EntryRow = { ...row }
  filled['口径版本'] = LEGACY_VERSION
  filled['下发日期'] = issueDate
  filled['补录批次'] = '上线前一次性补录'

  const missing: string[] = []
  if (!String(filled['上次检测日期'] ?? '').trim()) {
    if (lastInspectionDate) {
      filled['上次检测日期'] = lastInspectionDate
    } else {
      // 旧版没有单独的检测日期口径，按当时那版以最近一次可考日期（下发日期）留档
      filled['上次检测日期'] = issueDate
    }
  }
  if (!String(filled['检测日期'] ?? '').trim()) {
    filled['检测日期'] = String(filled['上次检测日期'])
  }
  if (detectorCount(filled) === null) {
    filled['探测器数量'] = ''
    missing.push('探测器数量')
  }
  if (!String(filled['责任人员'] ?? '').trim()) {
    missing.push('责任人员')
  }
  if (!String(filled['检测结论'] ?? '').trim()) {
    filled['检测结论'] = ''
    missing.push('检测结论')
  }
  flagMissing(filled, missing)
  filled['消防状态'] = filled.status
  filled.pending = String(filled.status) !== FIRE_STATUS.closed
  filled.abnormal = String(filled.status) === FIRE_STATUS.repair
  return filled
}

// ---- 同一份结论的镜像写入 ---------------------------------------------------
// 隐患清单、值班台账都以「来源模块 + 来源单号」为唯一键 upsert，重复执行不产生第二条。

function upsertHazard(
  hazards: EntryRow[],
  fire: EntryRow,
): EntryRow[] {
  const facilityNo = String(fire['设施编号'] ?? '')
  const existing = hazards.find(
    (row) => String(row['来源模块'] ?? '') === SOURCE_MODULE && String(row['来源单号'] ?? '') === facilityNo,
  )
  const repairText = String(fire['维修结论'] ?? '')
  const statusMap: Record<string, string> = {
    [FIRE_STATUS.repair]: '整改中',
    [FIRE_STATUS.closed]: '已验收',
  }
  const mirrorStatus = statusMap[String(fire.status)] ?? '整改中'

  if (existing) {
    return hazards.map((row) =>
      row === existing
        ? {
            ...row,
            status: mirrorStatus,
            pending: mirrorStatus !== '已验收',
            abnormal: mirrorStatus !== '已验收',
            '隐患部位': String(fire['所属舱室'] ?? ''),
            '整改措施': repairText,
            '维修结论': repairText,
            '整改状态': mirrorStatus,
            '探测器数量': fire['探测器数量'] ?? '',
          }
        : row,
    )
  }

  const row: EntryRow = {
    id: nextId(hazards),
    status: mirrorStatus,
    pending: mirrorStatus !== '已验收',
    abnormal: mirrorStatus !== '已验收',
    '隐患编号': `HAZA-FIRE-${facilityNo}`,
    '隐患部位': String(fire['所属舱室'] ?? ''),
    '隐患等级': '一般',
    '整改措施': repairText,
    '维修结论': repairText,
    '责任人员': fire['责任人员'] ?? '',
    '发现日期': String(fire['检测日期'] ?? ''),
    '整改期限': String(fire['下次检测日'] ?? ''),
    '整改状态': mirrorStatus,
    '探测器数量': fire['探测器数量'] ?? '',
    '来源模块': SOURCE_MODULE,
    '来源单号': facilityNo,
  }
  return [...hazards, row]
}

function upsertDuty(duties: EntryRow[], fire: EntryRow): EntryRow[] {
  const facilityNo = String(fire['设施编号'] ?? '')
  const existing = duties.find(
    (row) => String(row['来源模块'] ?? '') === SOURCE_MODULE && String(row['来源单号'] ?? '') === facilityNo,
  )
  const conclusion = String(fire['检测结论'] ?? '')

  if (existing) {
    return duties.map((row) =>
      row === existing
        ? {
            ...row,
            status: '已交接',
            pending: false,
            abnormal: false,
            '值班日期': String(fire['检测日期'] ?? ''),
            '交接事项': `消防检测结案：${facilityNo}（${conclusion}）`,
            '探测器数量': fire['探测器数量'] ?? '',
            '设施编号': facilityNo,
            '交接状态': '已交接',
          }
        : row,
    )
  }

  const row: EntryRow = {
    id: nextId(duties),
    status: '已交接',
    pending: false,
    abnormal: false,
    '交接编号': `DUTY-FIRE-${facilityNo}`,
    '值班班组': '消防检测班组',
    '值班日期': String(fire['检测日期'] ?? ''),
    '班次': '检测班',
    '值班人员': String(fire['责任人员'] ?? ''),
    '交接事项': `消防检测结案：${facilityNo}（${conclusion}）`,
    '交接人员': String(fire['责任人员'] ?? ''),
    '交接状态': '已交接',
    '探测器数量': fire['探测器数量'] ?? '',
    '设施编号': facilityNo,
    '来源模块': SOURCE_MODULE,
    '来源单号': facilityNo,
  }
  return [...duties, row]
}

// ---- 统一动作入口 ----------------------------------------------------------

export type FireAction = '提交检测' | '判定正常' | '提出维修' | '结案'

export function submitFireAction(id: number, action: FireAction, repairText?: string): ActionResult {
  const store = clone(allRows())
  const rows = store[FIRE_KEY] ?? []
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的消防设施检测单` }
  }
  const fire = { ...rows[index] }
  const current = String(fire.status)
  const facilityNo = String(fire['设施编号'] ?? `编号${id}`)

  // 改版前的既有记录：按当时口径保留原判，不进新状态机。
  if (String(fire['口径版本'] ?? CURRENT_VERSION) === LEGACY_VERSION) {
    return { ok: false, message: `${facilityNo} 为改版前记录，按当时口径保留原判（${current}），不再流转` }
  }
  fire['口径版本'] = CURRENT_VERSION

  // 所有校验都在落库前完成：任一条不过，整笔退回，不写任何数据、不动当前状态。
  if (current === FIRE_STATUS.closed) {
    return { ok: false, message: `${facilityNo} 已结案，结案记录不退回检测、不重复结案` }
  }

  const today = '2026-10-06'

  switch (action) {
    case '提交检测': {
      if (current !== FIRE_STATUS.pending) {
        return { ok: false, message: `${facilityNo} 已提交过检测（当前「${current}」），同一设施只推进一次，本次按重复退回` }
      }
      if (detectorCount(fire) === null) {
        return { ok: false, message: `${facilityNo} 缺探测器数量，检测单不许提交，请补齐后再提交检测` }
      }
      fire.status = FIRE_STATUS.inspecting
      break
    }
    case '判定正常': {
      if (current !== FIRE_STATUS.inspecting) {
        return { ok: false, message: `${facilityNo} 当前「${current}」，只有检测中的单据可判定，本次按重复退回` }
      }
      fire.status = FIRE_STATUS.normal
      fire['检测日期'] = today
      fire['检测结论'] = '检测正常，设施运行符合要求'
      fire['消防状态'] = FIRE_STATUS.normal
      break
    }
    case '提出维修': {
      if (current !== FIRE_STATUS.inspecting) {
        return { ok: false, message: `${facilityNo} 当前「${current}」，只有检测中的单据可提出维修，本次按重复退回` }
      }
      const conclusion = (repairText ?? '').trim()
      if (!conclusion) {
        return { ok: false, message: `${facilityNo} 提出维修必须填写维修结论，维修结论要落到隐患整改清单` }
      }
      fire.status = FIRE_STATUS.repair
      fire['检测日期'] = today
      fire['检测结论'] = '检测异常，需维修'
      fire['维修结论'] = conclusion
      fire['消防状态'] = FIRE_STATUS.repair
      break
    }
    case '结案': {
      if (current !== FIRE_STATUS.normal && current !== FIRE_STATUS.repair) {
        return { ok: false, message: `${facilityNo} 当前「${current}」，还没有检测结论，不能结案` }
      }
      fire.status = FIRE_STATUS.closed
      fire['检测日期'] = String(fire['检测日期'] ?? today)
      if (current === FIRE_STATUS.normal) {
        fire['检测结论'] = String(fire['检测结论'] ?? '检测正常，设施运行符合要求')
      } else {
        fire['维修结论'] = String(fire['维修结论'] ?? '').trim()
        if (!fire['维修结论']) {
          return { ok: false, message: `${facilityNo} 缺维修结论，无法结案` }
        }
      }
      fire['下次检测日'] = oneYearLater(String(fire['检测日期']))
      fire['消防状态'] = FIRE_STATUS.closed
      break
    }
  }

  fire.pending = fire.status !== FIRE_STATUS.closed
  fire.abnormal = fire.status === FIRE_STATUS.repair

  rows[index] = fire
  store[FIRE_KEY] = rows

  // 联动与结案同事务一次落库：写进去的就是同一份结论。
  if (action === '提出维修' || (action === '结案' && current === FIRE_STATUS.repair)) {
    store[HAZARD_KEY] = upsertHazard(store[HAZARD_KEY] ?? [], fire)
  }
  if (action === '结案') {
    store[DUTY_KEY] = upsertDuty(store[DUTY_KEY] ?? [], fire)
  }

  saveAll(store)
  return { ok: true, message: `${facilityNo} 已${action}，当前状态「${fire.status}」` }
}

// ---- 跨模块对账（幂等）：有遗漏的镜像一次补齐，不产生重复行 ----------------------
export function reconcileFireLinks(): ActionResult {
  const store = clone(allRows())
  const fires = store[FIRE_KEY] ?? []
  let touched = false

  for (const fire0 of fires) {
    const fire = { ...fire0 }
    if (String(fire['口径版本'] ?? CURRENT_VERSION) === LEGACY_VERSION) {
      continue
    }
    const status = String(fire.status)
    if (status === FIRE_STATUS.repair || status === FIRE_STATUS.closed) {
      if (String(fire['维修结论'] ?? '').trim()) {
        const before = store[HAZARD_KEY] ?? []
        const after = upsertHazard(before, fire)
        if (after !== before) {
          store[HAZARD_KEY] = after
          touched = true
        }
      }
    }
    if (status === FIRE_STATUS.closed) {
      const before = store[DUTY_KEY] ?? []
      const after = upsertDuty(before, fire)
      if (after !== before) {
        store[DUTY_KEY] = after
        touched = true
      }
    }
  }

  if (touched) {
    saveAll(store)
    return { ok: true, message: '隐患整改清单与值班台账已与消防检测结论同步' }
  }
  return { ok: true, message: '' }
}

// ---- 同口径选择器：所有页面、所有数字都用这一组 ------------------------------

export function fireRows(): EntryRow[] {
  return allRows()[FIRE_KEY] ?? []
}

export function countByFireStatus(status: string): number {
  return fireRows().filter((row) => String(row.status) === status).length
}

// 值班台账里的消防检测条数——与消防侧共用同一份结案行做计数。
export function fireDutyRows(): EntryRow[] {
  return (allRows()[DUTY_KEY] ?? []).filter(
    (row) => String(row['来源模块'] ?? '') === SOURCE_MODULE,
  )
}

// 新口径已结案：与值班台账镜像一一对应（旧版记录按当时口径保留原判，不进联动计数）。
export function closedFireCount(): number {
  return fireRows().filter(
    (row) => String(row.status) === FIRE_STATUS.closed && String(row['口径版本'] ?? CURRENT_VERSION) !== LEGACY_VERSION,
  ).length
}

// 全部已结案（含旧版保留原判的结案记录），用于消防本台账统计。
export function totalClosedCount(): number {
  return countByFireStatus(FIRE_STATUS.closed)
}

export function fireHazardRows(): EntryRow[] {
  return (allRows()[HAZARD_KEY] ?? []).filter(
    (row) => String(row['来源模块'] ?? '') === SOURCE_MODULE,
  )
}

export function detectorTotal(): number {
  // 关键数值合计：详情、列表、值班台账看到的是同一批行的同一个字段。
  return fireDutyRows().reduce((sum, row) => {
    const count = Number(row['探测器数量'])
    return sum + (Number.isFinite(count) ? count : 0)
  }, 0)
}
