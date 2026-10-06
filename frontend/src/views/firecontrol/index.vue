<template>
  <section class="page" data-module="firecontrol">
    <header class="page-head">
      <div>
        <h2>消防系统运维管理</h2>
        <p class="page-desc">检测提交、判定、维修与结案一次落库；列表、详情与另存清单取同一份结论，已结案不退回检测中。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记消防设施</button>
        <button class="btn" type="button" @click="exportRows">另存消防检测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

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
          <th>口径</th>
          <th>当前状态</th>
          <th>检测结论</th>
          <th>详情</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-closed': row.status === '已结案' }">
          <td v-for="column in columns" :key="column">
            <span v-if="isMissing(row, column)" class="cell-missing">缺（已标记）</span>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>
            <span :class="['tag', row['口径版本'] === 'v2' ? 'tag-v2' : 'tag-v1']">
              {{ row['口径版本'] === 'v2' ? '新口径' : '旧口径' }}
            </span>
          </td>
          <td>{{ row.status }}</td>
          <td class="conclusion-cell">{{ String(row['检测结论'] ?? '') || '—' }}</td>
          <td><button class="link" type="button" @click.stop="openDetail(row)">查看详情</button></td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无消防设施检测记录，可先登记消防设施</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条消防设施记录 · 检测结论已入值班台账 {{ syncedCount }} 条（与值班台账来源条数一致）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 详情面板：每次打开都从 store 现取，动作成功后重新现取；关闭即清空，不留上一轮痕迹。 -->
    <template v-if="detailRow">
      <div class="drawer-mask" @click="closeDetail"></div>
      <aside class="drawer" role="dialog" aria-label="消防设施检测详情">
        <div class="drawer-head">
          <h3 class="drawer-title">检测详情 · {{ detailRow['设施编号'] }}</h3>
          <button class="drawer-close" type="button" @click="closeDetail">×</button>
        </div>

        <p style="margin:0 0 10px">
          <span :class="['tag', detailRow['口径版本'] === 'v2' ? 'tag-v2' : 'tag-v1']">
            {{ detailRow['口径版本'] === 'v2' ? '新口径记录' : '旧口径留档（原判保留）' }}
          </span>
          <span v-if="detailRow['残缺字段']" class="tag tag-missing">残缺：{{ detailRow['残缺字段'] }}</span>
          <span v-if="String(detailRow['台账同步'] ?? '') !== ''" class="tag tag-synced">已同步值班台账</span>
        </p>

        <dl class="detail-grid">
          <template v-for="field in detailFields" :key="field">
            <dt>{{ field }}</dt>
            <dd>
              <span v-if="isMissing(detailRow, field)" class="cell-missing">缺（已标记）</span>
              <template v-else>{{ detailRow[field] === '' || detailRow[field] == null ? '—' : detailRow[field] }}</template>
            </dd>
          </template>
          <dt>当前状态</dt>
          <dd><strong>{{ detailRow.status }}</strong></dd>
        </dl>

        <div>
          <div class="stat-label">检测 / 维修结论（与另存清单同源）</div>
          <div class="conclusion-box">{{ String(detailRow['检测结论'] ?? '') || '尚无结论' }}</div>
        </div>

        <div v-if="actionError" class="error-text" style="margin-bottom:10px">{{ actionError }}</div>

        <div class="drawer-actions">
          <button
            v-for="action in detailActions"
            :key="action"
            :class="['btn', action === '提出维修' ? 'danger' : 'primary']"
            type="button"
            :disabled="submitting"
            @click="startAction(action)"
          >
            {{ action }}
          </button>
          <span v-if="!detailActions.length" class="stat-label">
            {{ detailRow.status === '已结案' ? '该记录已结案，不再受理动作' : '旧口径既有判定，按原判留档' }}
          </span>
        </div>
      </aside>
    </template>

    <!-- 判定 / 维修 / 结案：结论在此录入，提交时与状态一次落库。 -->
    <template v-if="activeAction">
      <div class="modal-mask" @click="cancelAction"></div>
      <div class="modal" role="dialog" :aria-label="activeAction">
        <div class="modal-head">
          <h3 class="modal-title">{{ activeAction }} · {{ detailRow?.['设施编号'] }}</h3>
          <button class="modal-close" type="button" @click="cancelAction">×</button>
        </div>
        <div class="form-grid">
          <label for="fire-action-note">
            {{ activeAction === '判定正常' ? '正常说明' : activeAction === '提出维修' ? '维修结论' : '维修完成情况' }}
          </label>
          <textarea
            id="fire-action-note"
            v-model="actionNote"
            :placeholder="notePlaceholder"
          ></textarea>
        </div>
        <div v-if="actionError" class="error-text" style="margin-bottom:10px">{{ actionError }}</div>
        <div class="modal-foot">
          <button class="btn ghost" type="button" :disabled="submitting" @click="cancelAction">取消</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="confirmAction">
            {{ submitting ? '提交中…' : '确认提交' }}
          </button>
        </div>
      </div>
    </template>

    <!-- 登记新设施：新记录一律新口径，探测器数量为必填正整数。 -->
    <template v-if="creating">
      <div class="modal-mask" @click="closeCreate"></div>
      <div class="modal" role="dialog" aria-label="登记消防设施">
        <div class="modal-head">
          <h3 class="modal-title">登记消防设施（新口径）</h3>
          <button class="modal-close" type="button" @click="closeCreate">×</button>
        </div>
        <div class="form-grid">
          <label for="fire-code">设施编号</label>
          <input id="fire-code" v-model="createForm.设施编号" placeholder="如 FIRE-0101" />
          <label for="fire-cabin">所属舱室</label>
          <input id="fire-cabin" v-model="createForm.所属舱室" />
          <label for="fire-type">消防类型</label>
          <input id="fire-type" v-model="createForm.消防类型" />
          <label for="fire-count">探测器数量</label>
          <input id="fire-count" v-model.number="createForm.探测器数量" type="number" min="1" step="1" />
          <label for="fire-link">联动测试日</label>
          <input id="fire-link" v-model="createForm.联动测试日" type="date" />
          <label for="fire-owner">责任人员</label>
          <input id="fire-owner" v-model="createForm.责任人员" />
          <label for="fire-next">下次检测日</label>
          <input id="fire-next" v-model="createForm.下次检测日" type="date" />
        </div>
        <div v-if="createError" class="error-text" style="margin-bottom:10px">{{ createError }}</div>
        <div class="modal-foot">
          <button class="btn ghost" type="button" @click="closeCreate">取消</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="submitCreate">确认登记</button>
        </div>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  createFireFacility,
  fireSyncedConclusionCount,
  getFire,
  availableActions,
  submitFireAction,
  type FireDraft,
} from '@/api/fire-inspection'
import { downloadEntries, listEntries } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

// 列表列与详情字段都来自同一份行数据；另存清单（导出）同样取这份行，三个入口天然对得上。
const columns = ['设施编号', '所属舱室', '消防类型', '探测器数量', '责任人员', '下次检测日']
const detailFields = [
  '设施编号', '所属舱室', '消防类型', '探测器数量', '联动测试日', '责任人员',
  '下发日期', '上次检测日', '下次检测日', '关联隐患编号',
]
const trackedStatuses = ['待检测', '检测中', '状态正常', '需维修', '已结案']
// 留档时即为空、新检测完成前本就允许为空的字段不算残缺；其余空值都标出来。
const OPTIONAL_FIELDS = new Set(['上次检测日', '检测结论', '关联隐患编号', '台账同步', '残缺字段'])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['设施编号', '所属舱室', '消防类型']
const syncedCount = ref(0)

// 详情面板只存当前选中的 id，渲染前从 store 现取，避免页面残留上一轮结论。
const selectedId = ref<number | null>(null)
const detailRow = ref<EntryRow | null>(null)
const activeAction = ref('')
const actionNote = ref('')
const actionError = ref('')
const submitting = ref(false)
const creating = ref(false)
const createError = ref('')
const createForm = ref<FireDraft>({
  设施编号: '',
  所属舱室: '',
  消防类型: '',
  探测器数量: 1,
  联动测试日: '',
  责任人员: '',
  下次检测日: '',
})

const statusSummary = computed(() =>
  trackedStatuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 卡片数字与列表同源计算，不再写死 0。
const stats = computed(() => [
  { label: '待检测设施', value: rows.value.filter((row) => row.status === '待检测').length },
  { label: '检测中设施', value: rows.value.filter((row) => row.status === '检测中').length },
  { label: '已结案设施', value: rows.value.filter((row) => row.status === '已结案').length },
  { label: '需维修设施', value: rows.value.filter((row) => row.status === '需维修').length },
  { label: '结论已入值班台账', value: syncedCount.value },
])

const detailActions = computed(() => (detailRow.value ? availableActions(detailRow.value) : []))

const notePlaceholder = computed(() => {
  if (activeAction.value === '判定正常') return '可填写正常说明（选填）'
  if (activeAction.value === '提出维修') return '必填：写明故障部位、现象与维修要求，将落到隐患整改清单'
  return '必填：写明维修完成情况，维修结论将回写隐患整改清单并验收'
})

function isMissing(row: EntryRow, field: string): boolean {
  if (OPTIONAL_FIELDS.has(field)) {
    return false
  }
  const value = row[field]
  return value === undefined || value === null || String(value).trim() === ''
}

function refreshSyncedCount() {
  syncedCount.value = fireSyncedConclusionCount()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  // 另存清单直接导出 store 里的消防行（含结论与标记字段），与列表、详情同源。
  downloadEntries('firecontrol')
}

function reload() {
  errorMessage.value = ''
  try {
    // listEntries 从 store 现取后再过滤；过滤只影响展示，不改数据。
    const payload = listEntries('firecontrol', filters.value)
    rows.value = payload.items
    total.value = payload.total
    refreshSyncedCount()
    if (selectedId.value !== null) {
      detailRow.value = getFire(selectedId.value) ?? null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '消防设施列表读取失败'
  }
}

function openDetail(row: EntryRow) {
  selectedId.value = Number(row.id)
  detailRow.value = getFire(selectedId.value) ?? null
  actionError.value = ''
  activeAction.value = ''
  actionNote.value = ''
}

function closeDetail() {
  // 关闭即把草稿、报错、选中项全部清掉，下一次打开不会看到上一轮的痕迹。
  selectedId.value = null
  detailRow.value = null
  activeAction.value = ''
  actionNote.value = ''
  actionError.value = ''
}

function startAction(action: string) {
  actionError.value = ''
  actionNote.value = action === '判定正常' ? '检测正常合格' : ''
  activeAction.value = action
}

function cancelAction() {
  activeAction.value = ''
  actionNote.value = ''
  actionError.value = ''
}

function confirmAction() {
  if (!detailRow.value || !activeAction.value) {
    return
  }
  actionError.value = ''
  submitting.value = true
  // 同一设施重复点击只提交一次：首次落库后按钮立即禁用，服务端幂等台账再兜一层。
  const result = submitFireAction(Number(detailRow.value.id), activeAction.value, actionNote.value)
  submitting.value = false
  if (!result.ok) {
    // 报错不落库：状态与结论都没变；面板现取仍是原值，不出现半成品痕迹。
    actionError.value = result.message
    detailRow.value = getFire(Number(detailRow.value.id)) ?? null
    return
  }
  activeAction.value = ''
  actionNote.value = ''
  reload()
  detailRow.value = selectedId.value !== null ? getFire(selectedId.value) ?? null : null
}

function openCreate() {
  createError.value = ''
  createForm.value = {
    设施编号: '',
    所属舱室: '',
    消防类型: '',
    探测器数量: 1,
    联动测试日: '',
    责任人员: '',
    下次检测日: '',
  }
  creating.value = true
}

function closeCreate() {
  creating.value = false
  createError.value = ''
}

function submitCreate() {
  createError.value = ''
  submitting.value = true
  const result = createFireFacility(createForm.value)
  submitting.value = false
  if (!result.ok) {
    createError.value = result.message
    return
  }
  creating.value = false
  reload()
}

onMounted(reload)
</script>

<style scoped>
.conclusion-cell { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-closed { background: #f8fafc; }
</style>
