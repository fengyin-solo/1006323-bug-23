/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 存储层元信息：口径版本与动作幂等台账都放这里，和业务行一起原子落库。 */
export type StoreMeta = {
  schemaVersion: number
  /** 近期动作台账：同一实体同一动作只认第一次落库，后续整笔按重复退回。 */
  actionLedger: { key: string; at: string }[]
}

/** 一次提交的多模块写入：要么整笔生效，要么整笔不留痕（纯前端用一次 localStorage 写入模拟事务）。 */
export type StoreCommit = {
  upserts?: Record<string, EntryRow[]>
  ledger?: StoreMeta['actionLedger']
}
