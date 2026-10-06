<template>
  <section class="page" data-module="firecontrol">
    <header class="page-head">
      <div>
        <h2>消防设施检测台账</h2>
        <p class="page-desc">
          统一口径：待检测 → 检测中 → 状态正常/需维修 → 已结案（终态锁定）。提交、判定、维修、结案一次落库，
          列表、详情面板、另存清单取同一份结论；维修结论落隐患整改，结案写值班台账。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">另存检测台账（CSV）</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card" :class="item.highlight ? 'stat-highlight' : ''">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="reconcile-banner">
      跨模块对账：新口径已结案 {{ closedCount }} 条 ｜ 值班台账消防检测记录 {{ dutyCount }} 条 ｜
      隐患整改中来自检测的维修单 {{ hazardCount }} 条 —— {{ countsMatch ? '条数一致' : '条数不一致，请点对账同步' }}
      <button class="link" type="button" @click="syncLinks">立即对账同步</button>
    </p>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="() => reload()">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div class="workbench">
      <div class="workbench-list">
        <table class="data-table">
          <thead>
            <tr>
              <th v-for="column in columns" :key="column">{{ column }}</th>
              <th>当前状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rows"
              :key="String(row.id)"
              :class="{ 'row-selected': selectedId === row.id, 'row-legacy': isLegacy(row) }"
            >
              <td v-for="column in columns" :key="column">
                <template v-if="column === '探测器数量' && missingDetector(row)">
                  <span class="missing-tag">缺</span>
                </template>
                <template v-else>{{ row[column] ?? '—' }}</template>
              </td>
              <td>
                <span class="status-pill" :data-status="row.status">{{ row.status }}</span>
                <span v-if="isLegacy(row)" class="version-tag">旧版原判</span>
              </td>
              <td class="row-actions">
                <button
                  v-if="String(row.status) === '待检测' && !isLegacy(row)"
                  class="link"
                  type="button"
                  @click="runAction('提交检测', row)"
                >
                  提交检测
                </button>
                <button class="link" type="button" @click="selectRow(row)">查看详情</button>
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td :colspan="columns.length + 2" class="empty-state">暂无消防设施检测数据</td>
            </tr>
          </tbody>
        </table>
      </div>

      <aside class="detail-panel">
        <h3>检测详情面板</h3>
        <p v-if="!selected" class="empty-state">在列表中选择一条检测单查看详情，面板与列表取同一份结论。</p>
        <div v-else class="detail-body">
          <div class="detail-status">
            <span class="status-pill" :data-status="selected.status">{{ selected.status }}</span>
            <span v-if="isLegacy(selected)" class="version-tag">旧版原判 · 冻结</span>
          </div>
          <dl class="detail-grid">
            <template v-for="field in detailFields" :key="field">
              <dt>{{ field }}</dt>
              <dd :class="{ 'missing-value': isMissing(selected, field) }">
                {{ displayValue(selected, field) }}
                <span v-if="isMissing(selected, field)" class="missing-tag">残缺留空</span>
              </dd>
            </template>
          </dl>

          <div v-if="String(selected['维修结论'] ?? '')" class="conclusion-box">
            <strong>维修结论（同一份，已落隐患整改清单）</strong>
            <p>{{ selected['维修结论'] }}</p>
          </div>
          <div v-else-if="String(selected['检测结论'] ?? '')" class="conclusion-box">
            <strong>检测结论</strong>
            <p>{{ selected['检测结论'] }}</p>
          </div>

          <div v-if="String(selected.status) === '需维修'" class="repair-input">
            <label>
              <span>维修结论（结案时可补充）</span>
              <textarea v-model="repairDraft" rows="3" placeholder="填写维修结论，将同事务落到隐患整改清单"></textarea>
            </label>
          </div>
          <div v-else-if="String(selected.status) === '检测中'" class="repair-input">
            <label>
              <span>提出维修时必填维修结论</span>
              <textarea v-model="repairDraft" rows="3" placeholder="若提出维修，维修结论将落到隐患整改清单"></textarea>
            </label>
          </div>

          <div v-if="isLegacy(selected)" class="detail-actions locked">
            <span class="locked-hint">改版前记录，按当时口径保留原判，不再推进、不退回检测。</span>
          </div>
          <div v-else class="detail-actions">
            <button
              v-if="String(selected.status) === '待检测'"
              class="btn primary"
              type="button"
              @click="runAction('提交检测', selected)"
            >
              提交检测
            </button>
            <button
              v-if="String(selected.status) === '检测中'"
              class="btn primary"
              type="button"
              @click="runAction('判定正常', selected)"
            >
              判定正常
            </button>
            <button
              v-if="String(selected.status) === '检测中'"
              class="btn"
              type="button"
              @click="runAction('提出维修', selected)"
            >
              提出维修
            </button>
            <button
              v-if="['状态正常', '需维修'].includes(String(selected.status))"
              class="btn primary"
              type="button"
              @click="runAction('结案', selected)"
            >
              结案
            </button>
            <span v-if="String(selected.status) === '已结案'" class="locked-hint">已结案，记录锁定，不再退回检测。</span>
          </div>
        </div>
      </aside>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条消防设施检测记录（旧版 {{ legacyCount }} 条按原判留档）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadFireLedger, filterRows } from '@/api/local-service'
import {
  closedFireCount,
  countByFireStatus,
  FIRE_STATUS,
  fireHazardRows,
  fireRows,
  fireDutyRows,
  reconcileFireLinks,
  submitFireAction,
  totalClosedCount,
  type FireAction,
} from '@/data/fire-inspection'
import type { EntryRow } from '@/data/types'

const columns = ['设施编号', '所属舱室', '消防类型', '探测器数量', '责任人员', '检测日期']
const detailFields = [
  '设施编号',
  '所属舱室',
  '消防类型',
  '探测器数量',
  '责任人员',
  '下发日期',
  '上次检测日期',
  '联动测试日',
  '检测日期',
  '下次检测日',
  '检测结论',
  '维修结论',
  '口径版本',
  '补录批次',
  '残缺字段',
]
const filterFields = ['设施编号', '所属舱室', '消防类型']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})
const selectedId = ref<number | null>(null)
const repairDraft = ref('')

const allFires = computed(() => fireRows())
const rowsById = computed(() => new Map(rows.value.map((row) => [Number(row.id), row])))
const selected = computed(() => {
  if (selectedId.value === null) {
    return null
  }
  return rowsById.value.get(selectedId.value) ?? null
})

const statusSummary = computed(() =>
  [FIRE_STATUS.pending, FIRE_STATUS.inspecting, FIRE_STATUS.normal, FIRE_STATUS.repair, FIRE_STATUS.closed].map(
    (status) => ({ status, count: countByFireStatus(status) }),
  ),
)

const closedCount = computed(() => closedFireCount())
const dutyCount = computed(() => fireDutyRows().length)
const hazardCount = computed(() => fireHazardRows().filter((row) => String(row.status) !== '已验收').length)
const countsMatch = computed(() => closedCount.value === dutyCount.value)
const legacyCount = computed(() => allFires.value.filter((row) => isLegacy(row)).length)

const stats = computed(() => [
  { label: '待检测设施', value: countByFireStatus(FIRE_STATUS.pending), highlight: false },
  { label: '检测中设施', value: countByFireStatus(FIRE_STATUS.inspecting), highlight: false },
  { label: '状态正常设施', value: countByFireStatus(FIRE_STATUS.normal), highlight: false },
  { label: '需维修设施', value: countByFireStatus(FIRE_STATUS.repair), highlight: false },
  { label: '已结案设施（含旧版原判）', value: totalClosedCount(), highlight: true },
])

function isLegacy(row: EntryRow): boolean {
  return String(row['口径版本'] ?? 'v2') === 'v1'
}

function missingDetector(row: EntryRow): boolean {
  const raw = row['探测器数量']
  return raw === '' || raw === undefined || raw === null || !(Number(raw) > 0)
}

function isMissing(row: EntryRow, field: string): boolean {
  if (field === '探测器数量') {
    return missingDetector(row)
  }
  return !String(row[field] ?? '').trim()
}

function displayValue(row: EntryRow, field: string): string {
  const value = row[field]
  if (value === undefined || value === null || String(value) === '') {
    return ''
  }
  return String(value)
}

function selectRow(row: EntryRow) {
  selectedId.value = Number(row.id)
  repairDraft.value = String(row['维修结论'] ?? '')
  errorMessage.value = ''
  okMessage.value = ''
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadFireLedger()
}

function syncLinks() {
  errorMessage.value = ''
  const result = reconcileFireLinks()
  okMessage.value = result.message || '已是最新：隐患整改、值班台账与检测结论一致'
  reload(true)
}

function runAction(action: FireAction, row: EntryRow) {
  errorMessage.value = ''
  okMessage.value = ''
  try {
    // 动作只做一次提交：失败时整笔退回、不落库，随后仍从存储重读，页面不会残留上一轮结论。
    const result = submitFireAction(Number(row.id), action, repairDraft.value)
    if (!result.ok) {
      errorMessage.value = result.message
      reload(true)
      return
    }
    okMessage.value = result.message
    selectedId.value = Number(row.id)
    reload(true)
  } catch (error) {
    // 落库异常：内存与页面都回到存储中的最后一次一致状态。
    errorMessage.value = error instanceof Error ? `落库失败，已保持原状态：${error.message}` : '操作失败，已保持原状态'
    reload(true)
  }
}

function reload(keepMessage = false) {
  try {
    // 进入页面先幂等对账一次：隐患清单/值班台账若缺镜像就补齐，重复执行不产生第二条。
    reconcileFireLinks()
    rows.value = filterRows(fireRows(), filters.value)
    total.value = rows.value.length
    if (!keepMessage) {
      errorMessage.value = ''
      okMessage.value = ''
    }
    if (selectedId.value !== null) {
      const latest = fireRows().find((row) => Number(row.id) === selectedId.value)
      if (latest) {
        repairDraft.value = String(latest['维修结论'] ?? '')
      }
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '消防检测台账读取失败'
  }
}

onMounted(() => {
  reload()
  if (rows.value.length > 0) {
    selectRow(rows.value[0])
  }
})
</script>
