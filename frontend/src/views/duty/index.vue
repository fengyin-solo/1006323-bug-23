<template>
  <section class="page" data-module="duty">
    <header class="page-head">
      <div>
        <h2>运维值班交接管理</h2>
        <p class="page-desc">维护值班交接记录，围绕交接编号、值班班组、值班日期、班次做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记值班交接记录</button>
        <button class="btn" type="button" @click="exportRows">导出运维值班交接清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
      <article class="stat-card stat-highlight">
        <span class="stat-label">消防检测结案记录（与消防台账同口径）</span>
        <strong class="stat-value">{{ fireDutyList.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已结案检测设施探测器总数</span>
        <strong class="stat-value">{{ detectorSum }}</strong>
      </article>
    </div>

    <p class="reconcile-banner">
      对账：本台账消防检测记录 {{ fireDutyList.length }} 条 ｜ 消防台账已结案 {{ closedCount }} 条 ——
      {{ countsMatch ? '两处条数一致，取值同源' : '两处条数不一致，可前往消防页面对账同步' }}。
      消防检测结案时同事务写入本台账，同一检测单只留一条。
    </p>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'linked-duty': isFireLinked(row) }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无运维值班交接数据，可先登记值班交接记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条运维值班交接记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { closedFireCount, detectorTotal, fireDutyRows, reconcileFireLinks } from '@/data/fire-inspection'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('duty')
const columns = ["交接编号", "来源单号", "值班班组", "值班日期", "班次", "值班人员", "交接事项", "探测器数量"]
const actions = ["发起交接", "确认交接", "登记遗留"]
const statuses = ["待交接", "交接中", "已交接", "有遗留"]
const stats = [{"label": "待交接班次", "value": 0}, {"label": "已交接班次", "value": 0}, {"label": "有遗留事项", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 与消防页面同一个选择器：两处数字必然一致。
const fireDutyList = computed(() => fireDutyRows())
const closedCount = computed(() => closedFireCount())
const countsMatch = computed(() => fireDutyList.value.length === closedCount.value)
const detectorSum = computed(() => detectorTotal())

function isFireLinked(row: EntryRow): boolean {
  return String(row['来源模块'] ?? '') === '消防设施检测'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '值班交接记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    // 值班台账中的消防记录由结案同事务写入；进入页面幂等对账，保证与消防台账条数一致。
    reconcileFireLinks()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '运维值班交接列表读取失败'
  }
}

onMounted(reload)
</script>
