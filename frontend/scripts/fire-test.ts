// 消防检测链路冒烟测试：node 下模拟 localStorage，逐条验收统一口径。
import { allRows } from '@/data/local-store'
import {
  closedFireCount,
  countByFireStatus,
  detectorTotal,
  fireDutyRows,
  fireHazardRows,
  fireRows,
  FIRE_STATUS,
  reconcileFireLinks,
  submitFireAction,
} from '@/data/fire-inspection'
import { exportFireLedger } from '@/api/local-service'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, extra = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name} ${extra}`)
  }
}

function byNo(no: string) {
  const row = fireRows().find((item) => String(item['设施编号']) === no)
  if (!row) {
    throw new Error(`种子缺少 ${no}`)
  }
  return row
}

function statusOf(no: string) {
  return String(byNo(no).status)
}

// 1. 初始：列表、值班台账条数一致（已结案 v2 两条，FIRE-1010 / FIRE-1011）
check('初始已结案 2 条', closedFireCount() === 2, `实际 ${closedFireCount()}`)
check('值班台账消防记录与已结案条数一致', fireDutyRows().length === closedFireCount())
check('探测器关键数值已镜像到值班台账', detectorTotal() === 9 + 22, `实际 ${detectorTotal()}`)

// 2. 缺探测器数量的检测单不许提交
const no7 = byNo('FIRE-1007')
const r1 = submitFireAction(Number(no7.id), '提交检测')
check('缺探测器数量禁止提交', !r1.ok && /探测器数量/.test(r1.message))
check('被拒后状态仍是待检测', statusOf('FIRE-1007') === FIRE_STATUS.pending)

// 3. 正常链路：提交检测 → 判定正常 → 结案，一次步进一步
const no4 = byNo('FIRE-1004')
check('提交检测成功', submitFireAction(Number(no4.id), '提交检测').ok)
check('列表状态同步为检测中', statusOf('FIRE-1004') === FIRE_STATUS.inspecting)
// 同一设施重复提交：整笔按重复退回
const dup = submitFireAction(Number(no4.id), '提交检测')
check('重复提交按重复退回', !dup.ok && /重复/.test(dup.message))
check('重复退回不改变状态', statusOf('FIRE-1004') === FIRE_STATUS.inspecting)
check('判定正常成功', submitFireAction(Number(no4.id), '判定正常').ok)
check('判定后状态为状态正常', statusOf('FIRE-1004') === FIRE_STATUS.normal)
check('检测结论已写入同一份行', String(byNo('FIRE-1004')['检测结论']).includes('正常'))
check('结案成功', submitFireAction(Number(no4.id), '结案').ok)
check('结案后状态为已结案', statusOf('FIRE-1004') === FIRE_STATUS.closed)
check('正常结案不产生隐患单', !fireHazardRows().some((h) => String(h['来源单号']) === 'FIRE-1004'))
check('结案在值班台账留痕', fireDutyRows().some((d) => String(d['来源单号']) === 'FIRE-1004'))
check('两边条数仍一致', fireDutyRows().length === closedFireCount())

// 4. 已结案记录不再退回检测中
const back = submitFireAction(Number(no4.id), '提交检测')
check('已结案不许再提交检测', !back.ok && /结案/.test(back.message))
const closeAgain = submitFireAction(Number(no4.id), '结案')
check('已结案重复结案整笔退回', !closeAgain.ok)
check('已结案状态保持', statusOf('FIRE-1004') === FIRE_STATUS.closed)

// 5. 维修链路：提出维修（结论必填）→ 隐患清单同一份 → 维修结案 → 隐患验收 + 值班留痕
const no5 = byNo('FIRE-1005')
check('检测中单可提交前已是检测中（种子）', statusOf('FIRE-1005') === FIRE_STATUS.inspecting)
const noRepair = submitFireAction(Number(no5.id), '提出维修', '   ')
check('空维修结论被拒', !noRepair.ok && /维修结论/.test(noRepair.message))
const repairText = '气体灭火主机电磁阀故障，更换电磁阀并联动复测'
check('提出维修成功', submitFireAction(Number(no5.id), '提出维修', repairText).ok)
check('消防状态为需维修', statusOf('FIRE-1005') === FIRE_STATUS.repair)
const hazard = fireHazardRows().find((h) => String(h['来源单号']) === 'FIRE-1005')
check('维修结论已落隐患整改清单', !!hazard, '清单中未找到来源单')
check('隐患清单是同一份维修结论', String(hazard?.['维修结论']) === repairText)
check('隐患初始为整改中', String(hazard?.status) === '整改中')
check('维修未结案不进值班台账', !fireDutyRows().some((d) => String(d['来源单号']) === 'FIRE-1005'))
check('维修结案成功', submitFireAction(Number(no5.id), '结案', repairText).ok)
const hazard2 = fireHazardRows().find((h) => String(h['来源单号']) === 'FIRE-1005')
check('维修结案后隐患同步为已验收', String(hazard2?.status) === '已验收')
check('维修结案写入值班台账', fireDutyRows().some((d) => String(d['来源单号']) === 'FIRE-1005'))
check('最终两边条数一致', fireDutyRows().length === closedFireCount(), `${fireDutyRows().length} vs ${closedFireCount()}`)
const finalTotal = 9 + 22 + Number(byNo('FIRE-1004')['探测器数量']) + Number(byNo('FIRE-1005')['探测器数量'])
check('值班台账探测器总数与结案行同源', detectorTotal() === finalTotal, `实际 ${detectorTotal()} vs ${finalTotal}`)

// 6. 不能跳步：待检测直接判定/结案都退回
const no6 = byNo('FIRE-1006')
check('待检测直接判定被拒', !submitFireAction(Number(no6.id), '判定正常').ok)
check('待检测直接结案被拒', !submitFireAction(Number(no6.id), '结案').ok)
check('被拒后仍是待检测', statusOf('FIRE-1006') === FIRE_STATUS.pending)

// 7. 旧版记录：保留原判、冻结；残缺字段留空并标出
const legacy1 = byNo('FIRE-0001')
check('旧版记录版本为 v1', String(legacy1['口径版本']) === 'v1')
check('旧版正常记录保留原判', statusOf('FIRE-0001') === FIRE_STATUS.normal)
const legacyFrozen = submitFireAction(Number(legacy1.id), '提交检测')
check('旧版记录拒绝流转', !legacyFrozen.ok && /当时口径/.test(legacyFrozen.message))
const legacyClosed = byNo('FIRE-0003')
check('旧版已结案保持已结案原判', statusOf('FIRE-0003') === FIRE_STATUS.closed)
const legacyMissing = byNo('FIRE-0003')
check('旧版残缺字段留空并标出', legacyMissing['探测器数量'] === '' && /探测器数量/.test(String(legacyMissing['残缺字段'])))
check('旧版按下发/上次检测日期补录检测日期', String(legacy1['检测日期']) === '2026-03-10')
check('补录只做一次（带批次号）', String(legacy1['补录批次']) === '上线前一次性补录')

// 8. 另存清单与列表同源：导出包含全部行且结论一致
const exported = exportFireLedger().content
const lines = exported.trim().split('\n')
check('另存清单条数与列表一致', lines.length === fireRows().length + 1, `${lines.length} vs ${fireRows().length + 1}`)
check('另存清单含同一份维修结论', exported.includes(repairText))
const no7line = lines.find((item) => item.includes('FIRE-1007'))
check('另存清单残缺值留空', !!no7line && no7line.includes(',,待检测') && no7line.includes('探测器数量'))

// 9. 幂等对账：重复执行不产生重复镜像
const dutyBefore = fireDutyRows().length
const hazardBefore = fireHazardRows().length
reconcileFireLinks()
reconcileFireLinks()
check('对账幂等：值班条数不增加', fireDutyRows().length === dutyBefore)
check('对账幂等：隐患条数不增加', fireHazardRows().length === hazardBefore)

// 10. 状态计数自洽
const statusSum = [FIRE_STATUS.pending, FIRE_STATUS.inspecting, FIRE_STATUS.normal, FIRE_STATUS.repair, FIRE_STATUS.closed]
  .reduce((sum, s) => sum + countByFireStatus(s), 0)
check('各状态计数之和等于总行数', statusSum === fireRows().length, `${statusSum} vs ${fireRows().length}`)

// 11. 落库内容：所有跨模块镜像共用来源单号
const sources = fireDutyRows().map((d) => String(d['来源单号'])).sort()
const closedNos = fireRows().filter((f) => String(f.status) === FIRE_STATUS.closed && String(f['口径版本']) === 'v2')
  .map((f) => String(f['设施编号'])).sort()
check('值班镜像与 v2 结案行一一对应', JSON.stringify(sources) === JSON.stringify(closedNos))

void allRows

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}
