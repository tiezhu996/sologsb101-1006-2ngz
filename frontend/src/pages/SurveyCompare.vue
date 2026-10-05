<script setup lang="ts">
/**
 * /surveys 复测测次与变化量对比
 * 按测次追加读数，自动与前一次比对生成变化量，并用折线对比历次宽度。
 * 同一环片重复录入的裂缝可在此发起「裂缝归并」：逐日期核对两边读数后合并到主裂缝。
 * 消费 Survey、Crack、CrackMerge；复用 <FilterBar>、<EmptyPanel>、<LevelTag>。
 */
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Delete, Edit, Plus, Connection } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import LevelTag from '@/components/common/LevelTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useCrackStore, type CrackEnriched } from '@/stores/crackStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useCrackTrend } from '@/hooks/useCrackTrend'
import { useIdbTable } from '@/hooks/useIdbTable'
import type { CrackMergeRow } from '@/utils/db'
import { buildMergePreview, confirmCrackMerge, type MergePreview } from '@/utils/merge'
import {
  EMPTY_SURVEY_DRAFT,
  type SurveyDraft
} from '@/types/survey'
import type { CrackDirection, CrackPosition } from '@/types/crack'
import { round } from '@/utils/rate'

type FilterModel = { keyword: string; [key: string]: string | string[] | boolean }

const crackStore = useCrackStore()
const surveyStore = useSurveyStore()
const sectionStore = useSectionStore()

const activeCrackId = computed(() => surveyStore.activeCrackId)
const activeCrack = computed<CrackEnriched | null>(
  () => crackStore.enriched.find((item) => item.crack.id === activeCrackId.value) ?? null
)
const trend = useCrackTrend(activeCrackId)

/* ------------------------------ 筛选 ------------------------------ */

const filterModel = computed<FilterModel>(() => ({
  keyword: crackStore.filter.keyword,
  line: crackStore.filter.lines,
  position: crackStore.filter.positions,
  direction: crackStore.filter.directions
}))

const filterSelects = computed(() => [
  { key: 'line', label: '线路', options: sectionStore.lineOptions },
  { key: 'position', label: '部位', options: crackStore.positionOptions.map((item) => ({ label: item, value: item })) },
  { key: 'direction', label: '走向', options: crackStore.directionOptions.map((item) => ({ label: item, value: item })) }
])

function onFilterChange(model: FilterModel): void {
  crackStore.patchFilter({
    keyword: String(model.keyword ?? ''),
    lines: Array.isArray(model.line) ? model.line : [],
    positions: (Array.isArray(model.position) ? model.position : []) as CrackPosition[],
    directions: (Array.isArray(model.direction) ? model.direction : []) as CrackDirection[]
  })
}

const candidateCracks = computed(() => crackStore.filtered)

/* ------------------------------ 折线图 ------------------------------ */

const chart = computed(() => {
  const points = trend.points.value
  if (points.length === 0) return null
  const width = 760
  const height = 250
  const padLeft = 62
  const padRight = 28
  const padTop = 24
  const padBottom = 46
  const values = points.map((point) => point.widthMm)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min < 0.001 ? 1 : max - min
  const stepX = points.length > 1 ? (width - padLeft - padRight) / (points.length - 1) : 0
  const coords = points.map((point, index) => ({
    ...point,
    x: padLeft + stepX * index,
    y: padTop + (height - padTop - padBottom) * (1 - (point.widthMm - min) / span)
  }))
  return {
    width,
    height,
    padLeft,
    padTop,
    padBottom,
    min,
    max,
    coords,
    polyline: coords.map((item) => `${item.x.toFixed(1)},${item.y.toFixed(1)}`).join(' '),
    baseline: height - padBottom,
    top: padTop
  }
})

/* ---------------------------- 测次表单 ---------------------------- */

const dialogVisible = ref(false)
const dialogTitle = ref('追加测次')
const formRef = ref<FormInstance>()
const form = reactive<SurveyDraft>({ ...EMPTY_SURVEY_DRAFT })
const rules: FormRules = {
  date: [{ required: true, message: '请选择复测日期', trigger: 'change' }],
  widthMm: [{ required: true, message: '请填写复测宽度', trigger: 'blur' }],
  surveyor: [{ required: true, message: '请填写复测人', trigger: 'blur' }]
}
let editingId: string | null = null

function openCreate(): void {
  if (!activeCrackId.value) {
    ElMessage.warning('请先在左侧选择一条裂缝')
    return
  }
  editingId = null
  dialogTitle.value = `追加测次 · ${activeCrack.value?.crack.code ?? ''}`
  const previous = trend.latest.value
  Object.assign(form, {
    crackId: activeCrackId.value,
    date: new Date().toISOString().slice(0, 10),
    widthMm: previous ? round(previous.widthMm, 2) : activeCrack.value?.crack.widthMm ?? 0,
    lengthMm: previous ? previous.lengthMm : activeCrack.value?.crack.lengthMm ?? 0,
    surveyor: previous ? '' : '周维'
  })
  dialogVisible.value = true
}

function openEdit(surveyId: string): void {
  const survey = trend.surveys.value.find((item) => item.id === surveyId)
  if (!survey) return
  editingId = surveyId
  dialogTitle.value = `编辑测次 · 第 ${survey.seq} 测次`
  Object.assign(form, {
    crackId: survey.crackId,
    date: survey.date,
    widthMm: survey.widthMm,
    lengthMm: survey.lengthMm,
    surveyor: survey.surveyor
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const instance = formRef.value
  if (!instance) return
  const valid = await instance.validate().catch(() => false)
  if (!valid) return
  if (editingId) {
    await surveyStore.updateSurvey(editingId, { ...form })
    ElMessage.success('测次已更新，变化量与速率已重新计算')
  } else {
    await surveyStore.createSurvey({ ...form })
    ElMessage.success('测次已追加，变化量已自动比对')
  }
  dialogVisible.value = false
}

async function removeSurvey(surveyId: string, seq: number): Promise<void> {
  const confirmed = await ElMessageBox.confirm(`确认删除第 ${seq} 测次？后续测次序号会自动前移。`, '删除确认', {
    type: 'warning',
    confirmButtonText: '确认删除',
    cancelButtonText: '取消'
  }).catch(() => false)
  if (!confirmed) return
  await surveyStore.removeSurvey(surveyId)
  ElMessage.success('测次已删除')
}

function selectCrack(crackId: string): void {
  surveyStore.setActiveCrack(crackId)
}

/* ---------------------------- 裂缝归并 ---------------------------- */

const mergeTable = useIdbTable<CrackMergeRow>((database) => database.crackMerges, { sortByUpdatedAt: false })

const mergeDialogVisible = ref(false)
const mergeSubmitting = ref(false)
const mergeLoading = ref(false)
const mergePrimaryId = ref('')
const mergeMergedId = ref('')
const mergeReviewer = ref('')
const mergePreview = ref<MergePreview | null>(null)
/** key=重复日期，value=该日期保留的测次 id */
const keptSurveyByDate = reactive<Record<string, string>>({})

/** 主裂缝候选项（全部裂缝，归并不受当前筛选影响） */
const mergePrimaryOptions = computed(() =>
  crackStore.enriched.map((item) => ({
    value: item.crack.id,
    label: `${item.crack.code} · ${item.sectionLabel} · ${item.ringLabel}`
  }))
)

const mergePrimaryCrack = computed(
  () => crackStore.enriched.find((item) => item.crack.id === mergePrimaryId.value) ?? null
)

/** 被并裂缝候选项：只列同一环片的其它裂缝，跨环片不能直接并 */
const mergeMergedOptions = computed(() =>
  crackStore.enriched
    .filter((item) => mergePrimaryId.value && item.crack.ringId === mergePrimaryCrack.value?.crack.ringId)
    .filter((item) => item.crack.id !== mergePrimaryId.value)
    .map((item) => ({
      value: item.crack.id,
      label: `${item.crack.code} · ${item.crack.position}/${item.crack.direction} · 测次 ${item.surveyCount}`
    }))
)

function openMerge(): void {
  mergePrimaryId.value = activeCrackId.value ?? ''
  mergeMergedId.value = ''
  mergeReviewer.value = ''
  mergePreview.value = null
  Object.keys(keptSurveyByDate).forEach((key) => delete keptSurveyByDate[key])
  mergeDialogVisible.value = true
  if (mergePrimaryId.value) void loadMergePreview()
}

async function onMergePrimaryChange(): Promise<void> {
  mergeMergedId.value = ''
  mergePreview.value = null
  Object.keys(keptSurveyByDate).forEach((key) => delete keptSurveyByDate[key])
  await loadMergePreview()
}

async function onMergeMergedChange(): Promise<void> {
  await loadMergePreview()
}

async function loadMergePreview(): Promise<void> {
  if (!mergePrimaryId.value || !mergeMergedId.value) {
    mergePreview.value = null
    return
  }
  mergeLoading.value = true
  try {
    const preview = await buildMergePreview(mergePrimaryId.value, mergeMergedId.value)
    mergePreview.value = preview
    Object.keys(keptSurveyByDate).forEach((key) => delete keptSurveyByDate[key])
    preview?.duplicates.forEach((row) => {
      keptSurveyByDate[row.date] = row.defaultKeptSurveyId
    })
  } catch (error) {
    mergePreview.value = null
    ElMessage.error(`归并预览加载失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    mergeLoading.value = false
  }
}

/** 重复日期是否全部已核对（漏选时不允许保存） */
const unresolvedDuplicateDates = computed(() =>
  mergePreview.value
    ? mergePreview.value.duplicates.filter((row) => !keptSurveyByDate[row.date]).map((row) => row.date)
    : []
)

const mergeConfirmDisabled = computed(
  () =>
    mergeSubmitting.value ||
    mergeLoading.value ||
    !mergePreview.value ||
    mergePreview.value.blockReason !== null ||
    unresolvedDuplicateDates.value.length > 0 ||
    mergeReviewer.value.trim().length === 0
)

function keptCellClass(date: string, surveyId: string): string {
  return keptSurveyByDate[date] === surveyId ? 'is-kept' : 'is-dropped'
}

async function submitMerge(): Promise<void> {
  if (!mergePreview.value) return
  if (mergePreview.value.blockReason) {
    ElMessage.warning(mergePreview.value.blockReason)
    return
  }
  if (unresolvedDuplicateDates.value.length > 0) {
    ElMessage.warning(`重复日期 ${unresolvedDuplicateDates.value.join('、')} 的读数尚未核对选择`)
    return
  }
  const { primary, merged } = mergePreview.value
  const confirmed = await ElMessageBox.confirm(
    `确认把「${merged.code}」归并入主裂缝「${primary.code}」？归并后被并编号注销，仅留存于归并记录，测次将按日期重排并重算变化量与建议。`,
    '归并确认',
    { type: 'warning', confirmButtonText: '确认归并', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return

  mergeSubmitting.value = true
  try {
    const result = await confirmCrackMerge({
      primaryCrackId: primary.id,
      mergedCrackId: merged.id,
      keptSurveyByDate: { ...keptSurveyByDate },
      reviewer: mergeReviewer.value
    })
    ElMessage.success(
      `已归并 ${result.merge.mergedCode} → ${result.merge.primaryCode}，归并后 ${result.surveyCountAfter} 个测次，月均速率 ${result.latestRate.toFixed(3)} mm/月`
    )
    surveyStore.setActiveCrack(primary.id)
    mergeDialogVisible.value = false
  } catch (error) {
    ElMessage.error(`归并未生效，数据已恢复：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    mergeSubmitting.value = false
  }
}

/** 当前主裂缝（或所选待并裂缝）的归并记录 */
const mergeHistory = computed(() => {
  const watchId = mergeDialogVisible.value ? mergePrimaryId.value : activeCrackId.value
  if (!watchId) return [] as CrackMergeRow[]
  return mergeTable.rows.value
    .filter((record) => record.primaryCrackId === watchId || record.mergedCrackId === watchId)
    .sort((a, b) => b.mergedAt - a.mergedAt)
})

function formatMergeTime(value: number): string {
  const date = new Date(value)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h2 class="page-head__title">复测测次与变化量对比</h2>
        <p class="page-head__desc">
          选定裂缝后按测次追加读数，系统自动与上一测次比对生成变化量并换算月均速率。
        </p>
      </div>
      <div class="page-head__actions">
        <el-button :icon="Connection" @click="openMerge">裂缝归并</el-button>
        <el-button type="primary" :icon="Plus" :disabled="!activeCrackId" @click="openCreate">追加测次</el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="测次总数" :value="surveyStore.surveys.length" suffix="次" icon="DataLine" tone="primary" />
      <StatBadge label="已复测裂缝" :value="surveyStore.rates.length" suffix="条" icon="Files" tone="info" />
      <StatBadge label="预警裂缝" :value="surveyStore.warningCrackIds.length" suffix="条" icon="WarningFilled" tone="danger" />
      <StatBadge
        label="最高月均速率"
        :value="surveyStore.rates.length > 0 ? surveyStore.rates[0].rate.toFixed(3) : '0.000'"
        suffix="mm/月"
        icon="TrendCharts"
        tone="warning"
      />
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="filterSelects"
      keyword-placeholder="搜索裂缝编号 / 环号"
      @change="onFilterChange"
    />

    <div class="grid-two" style="margin-top: 16px">
      <div class="panel">
        <h3 class="panel-title">裂缝列表（{{ candidateCracks.length }}）</h3>
        <EmptyPanel
          v-if="candidateCracks.length === 0"
          title="没有可复测的裂缝"
          description="先到裂缝初测录入页建立裂缝档案。"
          compact
        />
        <div
          v-for="item in candidateCracks"
          :key="item.crack.id"
          class="section-card"
          :class="{ 'is-active': item.crack.id === activeCrackId }"
          @click="selectCrack(item.crack.id)"
        >
          <div class="section-card__head">
            <span class="section-card__title">{{ item.crack.code }}</span>
            <LevelTag :level="item.level" size="small" />
          </div>
          <div class="section-card__meta">
            <span>{{ item.sectionLabel }}</span>
            <span>· {{ item.ringLabel }}</span>
          </div>
          <div class="section-card__meta">
            <span>{{ item.crack.position }} / {{ item.crack.direction }}</span>
            <span>· 测次 {{ item.surveyCount }}</span>
            <span>· {{ item.rate.toFixed(3) }} mm/月</span>
          </div>
        </div>
      </div>

      <div class="panel">
        <template v-if="activeCrack">
          <div class="panel-head">
            <h3 class="panel-title">
              {{ activeCrack.crack.code }} · 宽度发展曲线
              <span class="muted">{{ activeCrack.sectionLabel }} / {{ activeCrack.ringLabel }}</span>
            </h3>
            <div style="display: flex; align-items: center; gap: 8px">
              <span class="muted">
                累计变化 {{ trend.delta.value.toFixed(2) }} mm · 月均 {{ trend.rate.value.toFixed(3) }} mm/月
              </span>
              <LevelTag :level="trend.level.value" :rate="trend.rate.value" />
            </div>
          </div>

          <div v-if="!chart" class="empty-panel is-compact">
            <p class="empty-panel__desc">该裂缝还没有复测记录，点击「追加测次」录入第一条读数。</p>
          </div>

          <div v-else class="chart-wrap">
            <svg :viewBox="`0 0 ${chart.width} ${chart.height}`" width="100%" height="250" role="img">
              <line
                :x1="chart.padLeft - 12"
                :y1="chart.top"
                :x2="chart.padLeft - 12"
                :y2="chart.baseline"
                stroke="#dbe3ee"
                stroke-width="1"
              />
              <line
                :x1="chart.padLeft - 12"
                :y1="chart.baseline"
                :x2="chart.width - 12"
                :y2="chart.baseline"
                stroke="#dbe3ee"
                stroke-width="1"
              />
              <text :x="8" :y="chart.top + 4" fill="#5b6b82" font-size="12">{{ chart.max.toFixed(2) }}</text>
              <text :x="8" :y="chart.baseline" fill="#5b6b82" font-size="12">{{ chart.min.toFixed(2) }}</text>
              <polyline :points="chart.polyline" fill="none" stroke="#2b5c94" stroke-width="2.5" stroke-linejoin="round" />
              <g v-for="point in chart.coords" :key="point.seq">
                <circle :cx="point.x" :cy="point.y" r="4.5" fill="#fff" stroke="#13335c" stroke-width="2.5" />
                <text :x="point.x" :y="point.y - 12" fill="#16233a" font-size="12" text-anchor="middle">
                  {{ point.widthMm.toFixed(2) }}
                </text>
                <text :x="point.x" :y="chart.baseline + 22" fill="#5b6b82" font-size="11" text-anchor="middle">
                  第{{ point.seq }}次
                </text>
                <text :x="point.x" :y="chart.baseline + 36" fill="#8c99ab" font-size="10" text-anchor="middle">
                  {{ point.date.slice(5) }}
                </text>
              </g>
            </svg>
          </div>

          <h4 class="panel-subtitle">测次明细</h4>
          <el-table :data="trend.surveys.value" border stripe size="small">
            <el-table-column prop="seq" label="测次" width="70" />
            <el-table-column prop="date" label="复测日期" width="120" />
            <el-table-column label="宽度(mm)" width="110">
              <template #default="{ row }">{{ row.widthMm.toFixed(2) }}</template>
            </el-table-column>
            <el-table-column label="长度(mm)" width="100">
              <template #default="{ row }">{{ row.lengthMm }}</template>
            </el-table-column>
            <el-table-column label="变化量(mm)" width="120">
              <template #default="{ row }">
                <span :style="{ color: row.deltaWidthMm > 0 ? '#c0392b' : '#5b6b82' }">
                  {{ row.deltaWidthMm > 0 ? '+' : '' }}{{ row.deltaWidthMm.toFixed(2) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column prop="surveyor" label="复测人" width="100" />
            <el-table-column label="操作" width="140">
              <template #default="{ row }">
                <el-button size="small" text type="primary" @click="openEdit(row.id)">
                  <el-icon><Edit /></el-icon>
                </el-button>
                <el-button size="small" text type="danger" @click="removeSurvey(row.id, row.seq)">
                  <el-icon><Delete /></el-icon>
                </el-button>
              </template>
            </el-table-column>
          </el-table>

          <div v-if="mergeHistory.length > 0" class="panel merge-history">
            <h4 class="panel-subtitle" style="margin-top: 0">归并记录</h4>
            <div v-for="record in mergeHistory" :key="record.id" class="merge-history__item">
              <el-tag size="small" type="info">{{ formatMergeTime(record.mergedAt).slice(0, 10) }}</el-tag>
              <span>
                被并编号 <strong>{{ record.mergedCode }}</strong> 已归入
                <strong>{{ record.primaryCode }}</strong>
                （重复日期 {{ record.duplicates.length }} 个，转入 {{ record.transferredSurveyIds.length }} 个独有测次，归并后
                {{ record.surveyCountAfter }} 测次，核验人 {{ record.reviewer }}）
              </span>
            </div>
          </div>
        </template>

        <EmptyPanel
          v-else
          title="尚未选择裂缝"
          description="在左侧裂缝列表中选择一条裂缝，即可查看历次测次宽度对比曲线。"
          compact
        />
      </div>
    </div>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="520px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="复测日期" prop="date">
          <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="复测宽度(mm)" prop="widthMm">
          <el-input-number v-model="form.widthMm" :min="0" :step="0.01" :precision="2" style="width: 100%" />
        </el-form-item>
        <el-form-item label="复测长度(mm)" prop="lengthMm">
          <el-input-number v-model="form.lengthMm" :min="0" :step="10" style="width: 100%" />
        </el-form-item>
        <el-form-item label="复测人" prop="surveyor">
          <el-input v-model="form.surveyor" placeholder="如 周维" />
        </el-form-item>
        <el-alert
          v-if="trend.latest.value"
          type="info"
          :closable="false"
          :title="`上一测次宽度 ${trend.latest.value.widthMm.toFixed(2)} mm（${trend.latest.value.date}），保存后自动换算变化量与月均速率。`"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="mergeDialogVisible" title="裂缝归并" width="860px" :close-on-click-modal="false">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="用于同一环片重复录入的两条裂缝：先按日期核对两边测次，每个重复日期保留一条读数，确认后被并编号注销、仅留存在归并记录中，图表只认主裂缝。"
        style="margin-bottom: 14px"
      />

      <el-form label-width="100px">
        <el-form-item label="主裂缝">
          <el-select
            v-model="mergePrimaryId"
            filterable
            placeholder="选择归并后保留的裂缝"
            style="width: 100%"
            @change="onMergePrimaryChange"
          >
            <el-option v-for="item in mergePrimaryOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="被并裂缝">
          <el-select
            v-model="mergeMergedId"
            filterable
            :placeholder="
              mergePrimaryId ? '只能选择同一环片上的其它裂缝' : '请先选择主裂缝'
            "
            :disabled="!mergePrimaryId || mergeMergedOptions.length === 0"
            style="width: 100%"
            @change="onMergeMergedChange"
          >
            <el-option v-for="item in mergeMergedOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <span v-if="mergePrimaryId && mergeMergedOptions.length === 0" class="muted" style="margin-left: 10px">
            该环片上没有其它裂缝可归并
          </span>
        </el-form-item>
      </el-form>

      <el-alert
        v-if="mergePreview?.blockReason"
        type="error"
        :closable="false"
        show-icon
        :title="mergePreview.blockReason"
        style="margin-bottom: 12px"
      />

      <div v-loading="mergeLoading">
        <template v-if="mergePreview && !mergePreview.blockReason">
          <h4 class="panel-subtitle">
            逐日期读数核对
            <span class="muted">
              重复日期 {{ mergePreview.duplicates.length }} 个 · 被并转入 {{ mergePreview.mergedOnlyDates.length }} 次
              · 主裂缝独有 {{ mergePreview.primaryOnlyDates.length }} 次
            </span>
          </h4>
          <el-table :data="mergePreview.rows" border stripe size="small">
            <el-table-column prop="date" label="复测日期" width="110" />
            <el-table-column label="主裂缝读数" width="210">
              <template #default="{ row }">
                <template v-if="row.primarySurvey">
                  <el-radio
                    v-model="keptSurveyByDate[row.date]"
                    :value="row.primarySurvey.id"
                    :disabled="!row.duplicate"
                  >
                    <span class="merge-readout" :class="row.duplicate ? keptCellClass(row.date, row.primarySurvey.id) : ''">
                      {{ row.primarySurvey.widthMm.toFixed(2) }} mm / {{ row.primarySurvey.lengthMm }} mm
                    </span>
                  </el-radio>
                  <span class="muted"> · {{ row.primarySurvey.surveyor }}</span>
                </template>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="被并裂缝读数" width="210">
              <template #default="{ row }">
                <template v-if="row.mergedSurvey">
                  <el-radio
                    v-model="keptSurveyByDate[row.date]"
                    :value="row.mergedSurvey.id"
                    :disabled="!row.duplicate"
                  >
                    <span class="merge-readout" :class="row.duplicate ? keptCellClass(row.date, row.mergedSurvey.id) : ''">
                      {{ row.mergedSurvey.widthMm.toFixed(2) }} mm / {{ row.mergedSurvey.lengthMm }} mm
                    </span>
                  </el-radio>
                  <span class="muted"> · {{ row.mergedSurvey.surveyor }}</span>
                </template>
                <span v-else class="muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="处理方式" min-width="180">
              <template #default="{ row }">
                <el-tag v-if="row.duplicate" type="warning" size="small">
                  重复日期二选一 · {{ unresolvedDuplicateDates.includes(row.date) ? '待核对' : '已核对' }}
                </el-tag>
                <el-tag v-else-if="row.mergedSurvey" type="success" size="small">被并独有，转入主裂缝</el-tag>
                <el-tag v-else type="info" size="small">主裂缝独有，保留</el-tag>
              </template>
            </el-table-column>
          </el-table>
          <p class="muted" style="margin: 8px 0 0; font-size: 12px">
            默认保留宽度较大的读数，宽度相同时默认保留主裂缝；核验人可逐条改选，漏选时无法保存。
          </p>

          <el-form label-width="100px" style="margin-top: 16px">
            <el-form-item
              label="核验人"
              required
              :error="mergeReviewer.trim() ? '' : '请填写核验人'"
            >
              <el-input v-model="mergeReviewer" placeholder="谁核对谁签字，如 周维" style="width: 260px" />
            </el-form-item>
          </el-form>
        </template>

        <el-empty
          v-else-if="!mergePreview && mergePrimaryId && mergeMergedId && !mergeLoading"
          description="预览生成失败，请重新选择裂缝"
          :image-size="60"
        />
        <el-empty
          v-else-if="!mergePrimaryId || !mergeMergedId"
          description="选择主裂缝与同一环片上的被并裂缝后，在此按日期预览两边测次"
          :image-size="60"
        />
      </div>

      <template v-if="mergeHistory.length > 0">
        <el-divider content-position="left">归并记录</el-divider>
        <el-timeline>
          <el-timeline-item
            v-for="record in mergeHistory"
            :key="record.id"
            :timestamp="`${formatMergeTime(record.mergedAt)} · 核验人 ${record.reviewer}`"
            placement="top"
            type="primary"
          >
            <span v-if="record.primaryCrackId === mergePrimaryId">
              被并编号 <strong>{{ record.mergedCode }}</strong> 已归入
              <strong>{{ record.primaryCode }}</strong>
              （重复日期 {{ record.duplicates.length }} 个，归并后 {{ record.surveyCountAfter }} 个测次）
            </span>
            <span v-else>本裂缝编号 <strong>{{ record.mergedCode }}</strong> 已归入 {{ record.primaryCode }}</span>
          </el-timeline-item>
        </el-timeline>
      </template>

      <template #footer>
        <el-button @click="mergeDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="mergeSubmitting" :disabled="mergeConfirmDisabled" @click="submitMerge">
          确认归并
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.panel-title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
}

.panel-subtitle {
  margin: 16px 0 8px;
  font-size: 14px;
  font-weight: 600;
}

.panel-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.merge-readout {
  font-weight: 600;
}

.merge-readout.is-kept {
  color: #1e8449;
}

.merge-readout.is-dropped {
  color: #9aa6b5;
  text-decoration: line-through;
}

.merge-history {
  margin-top: 14px;
}

.merge-history__item {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px dashed #e3e8f0;
  font-size: 13px;
}

svg text {
  font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
</style>
