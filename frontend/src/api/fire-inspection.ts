import { listRows, commit, findLedger, getRow, makeId, today } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

/**
 * 消防设施检测链路的统一口径（全站只此一份，列表 / 详情 / 另存 / 看板都读它产出的数据）：
 *
 *   待检测 ──提交检测──▶ 检测中 ──判定正常──▶ 已结案（结论一次落库并同步值班台账）
 *                            └──提出维修──▶ 需维修（结论 + 隐患清单 + 值班台账一次落库）
 *                                              └──结案──▶ 已结案（维修结论回写隐患清单并验收）
 *
 * 「状态正常」只作为上线前既有记录（v1）的历史原判保留；新记录（v2）检测合格直接到「已结案」。
 * 「已结案」是终态，任何动作都拒绝，已结案记录不会再退回检测中。
 */

export const FIRE_KEY = 'firecontrol'
const HAZARD_KEY = 'hazard'
const DUTY_KEY = 'duty'
const DUTY_SYNC_TAG = '消防检测'

// 动作门控：键是允许发起动作的来源状态。未列出的状态（含已结案）一律拒绝，状态不再可能被往回拨。
const TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  提交检测: { from: ['待检测'], to: '检测中' },
  判定正常: { from: ['检测中'], to: '已结案' },
  提出维修: { from: ['检测中'], to: '需维修' },
  结案: { from: ['需维修'], to: '已结案' },
}

const PENDING_STATUSES = ['待检测', '检测中', '需维修']

export type FireAction = keyof typeof TRANSITIONS | string

export type FireDraft = {
  设施编号: string
  所属舱室: string
  消防类型: string
  探测器数量: number
  联动测试日: string
  责任人员: string
  下次检测日: string
}

function ok(message: string): ActionResult {
  return { ok: true, message }
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

function ledgerKey(action: string, id: number): string {
  return `${FIRE_KEY}:${id}:${action}`
}

/** 缺探测器数量（空值/非正整数）的检测单不许提交检测。 */
export function hasDetectorCount(row: EntryRow): boolean {
  const raw = row['探测器数量']
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw > 0
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const value = Number(raw.trim())
    return Number.isInteger(value) && value > 0
  }
  return false
}

function pendingFlags(status: string): { pending: boolean; abnormal: boolean } {
  return { pending: PENDING_STATUSES.includes(status), abnormal: status === '需维修' }
}

function fireConclusion(row: EntryRow, action: string, note: string, now: string): string {
  if (action === '判定正常') {
    return `${now} 检测结论：正常合格，予以结案。${note}`.trim()
  }
  if (action === '提出维修') {
    return `${now} 检测结论：${note}（已转入隐患整改清单）`
  }
  if (action === '结案') {
    const previous = String(row['检测结论'] ?? '').trim()
    return `${previous ? `${previous}\n` : ''}${now} 维修结论：${note}，维修完成，结案。`
  }
  return note
}

function buildHazardRow(fire: EntryRow, note: string, now: string): EntryRow {
  return {
    id: makeId(HAZARD_KEY),
    status: '待整改',
    pending: true,
    abnormal: true,
    隐患编号: `HAZA-FIRE-${String(fire['设施编号'] ?? fire.id).replace(/^FIRE-/, '')}`,
    来源编号: String(fire['设施编号'] ?? ''),
    隐患部位: `${String(fire['所属舱室'] ?? '')} ${String(fire['设施编号'] ?? '')}`.trim(),
    隐患等级: '一般',
    整改措施: note,
    责任人员: String(fire['责任人员'] ?? ''),
    发现日期: now,
    整改期限: '',
    整改状态: '待整改',
  }
}

function buildDutyRow(fire: EntryRow, conclusion: string, now: string): EntryRow {
  return {
    id: makeId(DUTY_KEY),
    status: '已交接',
    pending: false,
    abnormal: false,
    交接编号: `DUTY-FIRE-${String(fire['设施编号'] ?? fire.id).replace(/^FIRE-/, '')}`,
    来源编号: String(fire['设施编号'] ?? ''),
    值班班组: '消防检测值班组',
    值班日期: now,
    班次: '白班 08:00-20:00',
    值班人员: String(fire['责任人员'] ?? ''),
    // 关键数值随结论进值班台账：探测器数量与结论一起交接。
    交接事项: `[${DUTY_SYNC_TAG}] ${fire['设施编号']}（${fire['消防类型'] ?? ''}，探测器 ${fire['探测器数量'] ?? 0} 只）：${conclusion}`,
    交接人员: String(fire['责任人员'] ?? ''),
    交接状态: '已交接',
  }
}

/**
 * 提交一笔检测动作。整笔一次落库：消防行结论、隐患整改清单、值班台账、幂等台账同生共死。
 * 同一设施同一动作的重复提交只认第一次，后面的整笔退回，不产生第二条隐患/值班记录。
 */
export function submitFireAction(id: number, action: string, note = ''): ActionResult {
  const rule = TRANSITIONS[action]
  if (!rule) {
    return fail(`消防设施没有登记「${action}」这个动作`)
  }
  const fireRows = listRows(FIRE_KEY)
  const index = fireRows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return fail(`没有找到编号为 ${id} 的消防设施`)
  }
  const current = fireRows[index]
  const currentStatus = String(current.status)

  // 幂等：窗口内同一笔重复提交，只认第一次落库那次。
  if (findLedger(ledgerKey(action, id))) {
    return fail(`「${action}」已提交过一次并落库，本次按重复提交整笔退回`)
  }

  if (!rule.from.includes(currentStatus)) {
    // 终态命中这里：已结案不允许退回检测中，也不允许换动作重开。
    return fail(
      currentStatus === '已结案'
        ? `设施 ${current['设施编号']} 已结案，结案记录不再退回检测中`
        : `当前状态「${currentStatus}」不能执行「${action}」`,
    )
  }

  // 既有记录（v1）已下判定的原判冻结：状态正常/需维修都是当时口径的结论，不进新流程、不被覆盖。
  const isLegacy = String(current['口径版本'] ?? 'v1') === 'v1'
  if (isLegacy && (currentStatus === '状态正常' || currentStatus === '需维修')) {
    return fail(`设施 ${current['设施编号']} 为改版前既有记录，按当时口径保留原判，不再进入新检测流程`)
  }

  if (action === '提交检测' && !hasDetectorCount(current)) {
    return fail(`设施 ${current['设施编号']} 缺有效的探测器数量，检测单不许提交，请先补全`)
  }

  const trimmedNote = note.trim()
  if ((action === '提出维修' || action === '结案') && !trimmedNote) {
    return fail(action === '提出维修' ? '请填写维修结论后再提交' : '请填写维修完成情况后再结案')
  }

  const now = today()
  const nextStatus = rule.to
  const flags = pendingFlags(nextStatus)
  // 既有记录一旦在新口径下被推进，就统一按新口径走；动作发生之前仍按当时口径保留原判。
  const caliber = 'v2'

  const updatedFire: EntryRow = {
    ...current,
    status: nextStatus,
    pending: flags.pending,
    abnormal: flags.abnormal,
    检测结论: fireConclusion(current, action, trimmedNote, now),
    口径版本: caliber,
    消防状态: nextStatus,
  }

  const upserts: Record<string, EntryRow[]> = {}
  const hazardRows = [...listRows(HAZARD_KEY)]
  const dutyRows = [...listRows(DUTY_KEY)]
  let dutyConclusion = String(updatedFire['检测结论'])

  // 维修结论落到隐患整改清单；值班台账与结论严格一一对应（已同步计数）。
  if (action === '提出维修') {
    const hazard = buildHazardRow(updatedFire, trimmedNote, now)
    hazardRows.push(hazard)
    updatedFire['关联隐患编号'] = String(hazard['隐患编号'])
    upserts[HAZARD_KEY] = hazardRows
  } else if (action === '结案') {
    const linkedId = String(current['关联隐患编号'] ?? '')
    const linkedIndex = linkedId
      ? hazardRows.findIndex((row) => String(row['隐患编号']) === linkedId)
      : -1
    if (linkedIndex >= 0) {
      hazardRows[linkedIndex] = {
        ...hazardRows[linkedIndex],
        status: '已验收',
        pending: false,
        abnormal: false,
        整改措施: `${hazardRows[linkedIndex]['整改措施'] ?? ''}\n${now} 维修结论：${trimmedNote}，验收通过`.trim(),
        整改状态: '已验收',
      }
      upserts[HAZARD_KEY] = hazardRows
    }
  }

  // 判定正常 / 提出维修：产生一份检测结论并同步值班台账；结案不重复生成，保证两边条数一致。
  if (action === '判定正常' || action === '提出维修') {
    if (action === '判定正常') {
      dutyConclusion = `${updatedFire['设施编号']} 检测正常合格，已结案`
    }
    dutyRows.push(buildDutyRow(updatedFire, dutyConclusion, now))
    updatedFire['台账同步'] = String(dutyRows.filter((row) => String(row['交接编号']).startsWith('DUTY-FIRE-')).length)
    upserts[DUTY_KEY] = dutyRows
  }

  const nextFireRows = [...fireRows]
  nextFireRows[index] = updatedFire
  upserts[FIRE_KEY] = nextFireRows

  try {
    commit({ upserts, ledger: [{ key: ledgerKey(action, id), at: new Date().toISOString() }] })
  } catch (error) {
    // 落库失败：缓存与 localStorage 都未改，页面保持上一笔状态，由调用方提示错误。
    return fail(error instanceof Error ? `落库失败：${error.message}，状态保持不变` : '落库失败，状态保持不变')
  }

  return ok(`设施 ${updatedFire['设施编号']} 已${action}，当前状态「${nextStatus}」`)
}

/** 登记新消防设施（新记录一律 v2 新口径）。 */
export function createFireFacility(draft: FireDraft): ActionResult {
  const code = draft.设施编号.trim()
  if (!code) {
    return fail('设施编号不能为空')
  }
  if (listRows(FIRE_KEY).some((row) => String(row['设施编号']) === code)) {
    return fail(`设施编号 ${code} 已存在，同一设施只登记一次`)
  }
  if (!(Number.isInteger(draft.探测器数量) && draft.探测器数量 > 0)) {
    return fail('缺有效的探测器数量，检测单登记后也无法提交检测')
  }
  if (findLedger(`create:${code}`)) {
    return fail('该设施刚登记过，本次按重复提交整笔退回')
  }

  const now = today()
  const row: EntryRow = {
    id: makeId(FIRE_KEY),
    status: '待检测',
    pending: true,
    abnormal: false,
    设施编号: code,
    所属舱室: draft.所属舱室.trim(),
    消防类型: draft.消防类型.trim(),
    探测器数量: draft.探测器数量,
    联动测试日: draft.联动测试日 || now,
    责任人员: draft.责任人员.trim(),
    下次检测日: draft.下次检测日,
    // 新记录按新口径：下发日期取登记日，不留残缺。
    下发日期: now,
    上次检测日: '',
    检测结论: '',
    口径版本: 'v2',
    残缺字段: '',
    台账同步: '',
    关联隐患编号: '',
    消防状态: '待检测',
  }

  try {
    commit({
      upserts: { [FIRE_KEY]: [...listRows(FIRE_KEY), row] },
      ledger: [{ key: `create:${code}`, at: new Date().toISOString() }],
    })
  } catch (error) {
    return fail(error instanceof Error ? `登记失败：${error.message}，状态保持不变` : '登记失败，状态保持不变')
  }
  return ok(`设施 ${code} 已登记，当前状态「待检测」`)
}

/** 已产生并同步到值班台账的检测结论条数（消防侧口径）。 */
export function fireSyncedConclusionCount(): number {
  return listRows(DUTY_KEY).filter((row) => String(row['交接编号']).startsWith('DUTY-FIRE-')).length
}

/** 值班台账侧读到的消防检测来源条数——两侧必须一致。 */
export function dutyFireEntryCount(): number {
  return fireSyncedConclusionCount()
}

export function getFire(id: number): EntryRow | undefined {
  return getRow(FIRE_KEY, id)
}

/** 详情面板按当前状态给出可执行动作；终态与旧判正常态返回空。 */
export function availableActions(row: EntryRow): string[] {
  const status = String(row.status)
  return Object.entries(TRANSITIONS)
    .filter(([, rule]) => rule.from.includes(status))
    .map(([action]) => action)
}
