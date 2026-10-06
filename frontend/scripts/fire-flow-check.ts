import {
  createFireFacility,
  submitFireAction,
  fireSyncedConclusionCount,
  getFire,
  availableActions,
} from '../src/api/fire-inspection'
import { listRows } from '../src/data/local-store'

export function run({ assert }: { assert: typeof import('node:assert') }): void {
  const fire = () => listRows('firecontrol')
  const byId = (id: number) => fire().find((r) => Number(r.id) === id)!

  // 迁移：v1 记录按联动测试日补上次检测日；下发日期缺的留空并标残缺；探测器缺的也标残缺。
  const r1 = byId(1) // 缺探测器数量、下发日期有值
  assert.equal(r1['上次检测日'], '2026-08-12', 'v1 上次检测日应按联动测试日补录')
  assert.equal(r1['探测器数量'], '', '缺的探测器数量保持留空')
  assert.equal(r1['残缺字段'], '', 'FIRE-0001 下发日期有值，不应有残缺日期字段')
  const r2 = byId(2) // 下发日期缺失
  assert.equal(r2['上次检测日'], '2026-09-02')
  assert.equal(r2['残缺字段'], '下发日期', '下发日期缺失应标出')
  assert.equal(r2['下发日期'], '', '下发日期缺值留空不臆造')

  // 缺探测器数量的检测单不许提交检测。
  let res = submitFireAction(1, '提交检测')
  assert.equal(res.ok, false)
  assert.match(res.message, /探测器数量/)
  assert.equal(byId(1).status, '待检测', '被拒后状态不能变，不残留中间态')

  // 已下判定的 v1 记录原判冻结：状态正常不退回检测中，需维修不进新流程。
  res = submitFireAction(3, '提交检测')
  assert.equal(res.ok, false)
  assert.equal(byId(3).status, '状态正常')
  res = submitFireAction(4, '结案', '修好了')
  assert.equal(res.ok, false)
  assert.equal(byId(4).status, '需维修')

  // FIRE-0002 v1 检测中：缺数量校验只卡"提交检测"，其已在检测中，可判定正常 → 一次结案并同步。
  assert.equal(fireSyncedConclusionCount(), 0)
  res = submitFireAction(2, '判定正常', '正常')
  assert.equal(res.ok, true, res.message)
  assert.equal(byId(2).status, '已结案')
  assert.equal(byId(2)['口径版本'], 'v2', 'v1 记录经新流程推进后按新口径走')
  assert.match(String(byId(2)['检测结论']), /正常合格.*结案/)
  assert.equal(fireSyncedConclusionCount(), 1, '一份结论对应一条值班台账')

  // 已结案不退回检测中。
  res = submitFireAction(2, '提交检测')
  assert.equal(res.ok, false)
  assert.match(res.message, /已结案/)
  assert.equal(byId(2).status, '已结案')

  // 同一笔重复提交只认第一次：结案动作重复整笔退回（不产生第二条台账）。
  res = submitFireAction(2, '判定正常', '再来一次')
  assert.equal(res.ok, false)
  assert.match(res.message, /重复/)
  assert.equal(fireSyncedConclusionCount(), 1)

  // 新建 v2 设施并走完整维修链路。
  res = createFireFacility({
    设施编号: 'FIRE-0999',
    所属舱室: '热力舱E段',
    消防类型: '感温电缆',
    探测器数量: 5,
    联动测试日: '2026-10-01',
    责任人员: '测试员',
    下次检测日: '2027-01-01',
  })
  assert.equal(res.ok, true, res.message)
  const id5 = fire().find((r) => r['设施编号'] === 'FIRE-0999')!.id
  assert.equal(byId(id5)['口径版本'], 'v2')
  assert.equal(byId(id5)['下发日期'].length, 10)

  // 同一设施重复登记整笔退回。
  res = createFireFacility({
    设施编号: 'FIRE-0999', 所属舱室: 'x', 消防类型: 'y', 探测器数量: 5,
    联动测试日: '', 责任人员: '', 下次检测日: '',
  })
  assert.equal(res.ok, false)
  assert.match(res.message, /重复|已存在/)

  // 顺序门控：待检测不能直接判定正常。
  res = submitFireAction(id5, '判定正常')
  assert.equal(res.ok, false)
  assert.match(res.message, /不能执行/)

  // 提交检测，重复点击第二次整笔退回（同一设施只推进一次）。
  assert.equal(submitFireAction(id5, '提交检测').ok, true)
  assert.equal(byId(id5).status, '检测中')
  res = submitFireAction(id5, '提交检测')
  assert.equal(res.ok, false)
  assert.match(res.message, /重复/)
  assert.equal(byId(id5).status, '检测中')

  // 提出维修缺结论不许提交；带结论一次落库：消防行 + 隐患清单 + 值班台账。
  assert.equal(submitFireAction(id5, '提出维修', '   ').ok, false)
  const hazardsBefore = listRows('hazard')
  const dutyBefore = listRows('duty')
  res = submitFireAction(id5, '提出维修', '感温电缆断裂2处，需更换')
  assert.equal(res.ok, true, res.message)
  assert.equal(byId(id5).status, '需维修')
  const hazardsAfter = listRows('hazard')
  const dutyAfter = listRows('duty')
  assert.equal(hazardsAfter.length, hazardsBefore.length + 1, '维修结论落到隐患整改清单')
  assert.equal(dutyAfter.length, dutyBefore.length + 1, '值班台账新增一条')
  const hz = hazardsAfter[hazardsAfter.length - 1]
  assert.equal(hz['来源编号'], 'FIRE-0999')
  assert.equal(hz['隐患编号'], 'HAZA-FIRE-0999')
  assert.equal(hz.status, '待整改')
  assert.match(String(hz['整改措施']), /感温电缆断裂/)
  assert.equal(byId(id5)['关联隐患编号'], 'HAZA-FIRE-0999')
  assert.equal(fireSyncedConclusionCount(), 2, '两份结论 = 值班台账消防来源两条')

  // 维修结案：结论回写隐患清单并验收；结案不重复生成值班台账。
  assert.equal(submitFireAction(id5, '结案', '   ').ok, false)
  res = submitFireAction(id5, '结案', '电缆已更换，联动恢复')
  assert.equal(res.ok, true, res.message)
  assert.equal(byId(id5).status, '已结案')
  assert.match(String(byId(id5)['检测结论']), /维修结论：电缆已更换.*结案/)
  const accepted = listRows('hazard').find((r) => r['隐患编号'] === 'HAZA-FIRE-0999')!
  assert.equal(accepted.status, '已验收')
  assert.match(String(accepted['整改措施']), /维修结论：电缆已更换.*验收通过/)
  assert.equal(fireSyncedConclusionCount(), 2, '结案不重复写台账，两边条数仍一致')
  assert.equal(listRows('duty').filter((r) => String(r['交接编号']).startsWith('DUTY-FIRE-')).length, 2)

  // 已结案设施没有任何可执行动作。
  assert.deepEqual(availableActions(getFire(id5)!), [])
  assert.deepEqual(availableActions(getFire(2)!), [])
  // 需维修（v1冻结）也没有动作；待检测可提交检测。
  assert.deepEqual(availableActions(getFire(1)!), ['提交检测'])

  // 新建设施缺探测器数量不许登记。
  res = createFireFacility({
    设施编号: 'FIRE-0998', 所属舱室: 'x', 消防类型: 'y', 探测器数量: 0,
    联动测试日: '', 责任人员: '', 下次检测日: '',
  })
  assert.equal(res.ok, false)
  assert.match(res.message, /探测器数量/)

  console.log('fire-flow: all assertions passed')
}
