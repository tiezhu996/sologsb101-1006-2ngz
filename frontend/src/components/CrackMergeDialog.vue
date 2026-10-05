<script setup lang="ts">
/**
 * 裂缝归并弹窗：
 * 1) 选择主裂缝与被并裂缝（仅限同一环片，任一侧存在已下发/已完成建议时阻断）；
 * 2) 按日期预览两侧测次，重复日期两条读数放一行核对，默认勾选宽度较大的读数（等宽必须人工选）；
 * 3) 漏选或未填核验人不能保存；确认后单事务提交，失败整体回滚。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Connection } from '@element-plus/icons-vue'
import type { CrackEnriched } from '@/stores/crackStore'
import type { MergePreview, MergePreviewRow } from '@/types/crackMerge'
import { buildMergePreview, commitMerge, MergeBlockedError, missingChoices } from '@/utils/crackMerge'
import { formatMm } from '@/utils/rate'

const props = defineProps<{
  modelValue: boolean
  candidates: CrackEnriched[]
  defaultPrimaryId: string | null
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'merged', primaryCrackId: string): void
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

const loading = ref(false)
const submitting = ref(false)
const primaryId = ref('')
const mergedId = ref('')
const verifier = ref('')
const remark = ref('')
const preview = ref<MergePreview | null>(null)

const primaryCrack = computed(() => props.candidates.find((item) => item.crack.id === primaryId.value) ?? null)
const mergedCrack = computed(() => props.candidates.find((item) => item.crack.id === mergedId.value) ?? null)

/** 被并裂缝候选：与主裂缝同环片且不能是主裂缝本身 */
const mergedOptions = computed(() =>
  props.candidates
    .filter((item) => item.crack.id !== primaryId.value)
    .filter((item) => (primaryCrack.value ? item.crack.ringId === primaryCrack.value.crack.ringId : true))
    .map((item) => ({
      label: `${item.crack.code} · ${item.crack.position} / ${item.crack.direction} · 测次 ${item.surveyCount}`,
      value: item.crack.id
    }))
)

const primaryOptions = computed(() =>
  props.candidates.map((item) => ({
    label: `${item.crack.code} · 第 ${item.ring ? item.ring.ringNo : '?'} 环 · ${item.crack.position}`,
    value: item.crack.id
  }))
)

const sameRing = computed(() =>
  primaryCrack.value && mergedCrack.value
    ? primaryCrack.value.crack.ringId === mergedCrack.value.crack.ringId
    : false
)

const duplicateRows = computed(() => (preview.value ? preview.value.rows.filter((row) => row.duplicate) : []))
const singleRows = computed(() => (preview.value ? preview.value.rows.filter((row) => !row.duplicate) : []))
const missingRows = computed(() => (preview.value ? missingChoices(preview.value) : []))
const canPreview = computed(() => Boolean(primaryId.value && mergedId.value && sameRing.value))
const canSubmit = computed(
  () =>
    preview.value !== null &&
    preview.value.blocked.length === 0 &&
    missingRows.value.length === 0 &&
    verifier.value.trim().length > 0 &&
    !submitting.value
)

watch(
  () => props.modelValue,
  (open) => {
    if (open) resetState()
  }
)

watch(primaryId, () => {
  // 主裂缝更换后，非同环片的被并选择失效，预览需重新生成
  if (mergedId.value && !mergedOptions.value.some((item) => item.value === mergedId.value)) {
    mergedId.value = ''
  }
  preview.value = null
})

watch(mergedId, () => {
  preview.value = null
})

function resetState(): void {
  primaryId.value = props.defaultPrimaryId ?? props.candidates[0]?.crack.id ?? ''
  mergedId.value = ''
  verifier.value = ''
  remark.value = ''
  preview.value = null
  submitting.value = false
  loading.value = false
}

async function loadPreview(preserveChoices = false): Promise<void> {
  if (!canPreview.value) return
  loading.value = true
  // 失败重试时保留核验人此前的人工选择（按测次 id 重新映射）
  const previousChoices = new Map<string, string>()
  if (preserveChoices && preview.value) {
    preview.value.rows.forEach((row) => {
      if (row.duplicate && row.choice) {
        const side = row.choice === 'primary' ? row.primary : row.merged
        if (side) previousChoices.set(row.date, side.surveyId)
      }
    })
  }
  try {
    const next = await buildMergePreview(primaryId.value, mergedId.value)
    next.rows.forEach((row) => {
      if (!row.duplicate) return
      const keptId = previousChoices.get(row.date)
      if (!keptId) return
      if (row.primary?.surveyId === keptId) row.choice = 'primary'
      else if (row.merged?.surveyId === keptId) row.choice = 'merged'
    })
    preview.value = next
    verifier.value = verifier.value.trim()
  } catch (error) {
    preview.value = null
    ElMessage.error(`生成归并预览失败：${error instanceof Error ? error.message : '未知错误'}`)
  } finally {
    loading.value = false
  }
}

function keepSide(row: MergePreviewRow, side: 'primary' | 'merged'): void {
  row.choice = side
}

/** 一键采用系统建议：每个重复日期勾选宽度较大的读数（等宽的仍需人工选） */
function applyDefaultChoices(): void {
  if (!preview.value) return
  preview.value.rows.forEach((row) => {
    if (row.duplicate && row.defaultWinner) row.choice = row.defaultWinner
  })
}

async function submit(): Promise<void> {
  if (!preview.value) return
  if (preview.value.blocked.length > 0) return
  if (missingRows.value.length > 0) {
    ElMessage.warning(`还有 ${missingRows.value.length} 个重复日期未选择保留读数，请逐条核对`)
    return
  }
  if (!verifier.value.trim()) {
    ElMessage.warning('请填写核验人，漏选或无核验人的归并不允许保存')
    return
  }
  const choiceByDate: Record<string, string> = {}
  preview.value.rows.forEach((row) => {
    if (!row.duplicate || !row.choice) return
    const side = row.choice === 'primary' ? row.primary : row.merged
    if (side) choiceByDate[row.date] = side.surveyId
  })
  submitting.value = true
  try {
    const record = await commitMerge({
      primaryCrackId: primaryId.value,
      mergedCrackId: mergedId.value,
      choiceByDate,
      verifier: verifier.value,
      remark: remark.value
    })
    ElMessage.success(
      `归并完成：${record.mergedCrackCode} 已并入 ${record.primaryCrackCode}，合并后 ${record.resultSurveyCount} 个测次已按日期重排`
    )
    visible.value = false
    emit('merged', primaryId.value)
  } catch (error) {
    if (error instanceof MergeBlockedError) {
      ElMessage.error(`无法归并：${error.reasons.join('；')}`)
    } else {
      ElMessage.error(`归并未生效，已恢复原裂缝、测次与建议：${error instanceof Error ? error.message : '未知错误'}`)
    }
    // 写入失败后允许原样重试；刷新预览时保留此前的人工核对选择
    await loadPreview(true)
  } finally {
    submitting.value = false
  }
}

function widthDiff(row: MergePreviewRow): string {
  if (!row.primary || !row.merged) return '—'
  const diff = Math.abs(row.primary.widthMm - row.merged.widthMm)
  return diff === 0 ? '读数一致' : `相差 ${formatMm(diff)}`
}
</script>

<template>
  <el-dialog v-model="visible" title="裂缝归并" width="900px" :close-on-click-modal="false">
    <div v-loading="loading">
      <el-alert
        type="info"
        :closable="false"
        title="同一环片上编号重复录入的两条裂缝可归并为一条：被并编号只保留在归并记录里，图表与台账只认主裂缝。"
        style="margin-bottom: 14px"
      />

      <el-form label-width="92px">
        <el-form-item label="主裂缝" required>
          <el-select v-model="primaryId" filterable placeholder="选择保留编号的裂缝" style="width: 100%">
            <el-option v-for="item in primaryOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="被并裂缝" required>
          <el-select
            v-model="mergedId"
            filterable
            placeholder="仅可选择同一环片的其他裂缝"
            style="width: 100%"
            :disabled="!primaryId"
          >
            <el-option v-for="item in mergedOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </el-form-item>
      </el-form>

      <div v-if="primaryId && mergedId && !sameRing" class="merge-warn">
        两道裂缝分属不同环片，不能跨环片归并，请重新选择。
      </div>

      <div style="margin: 4px 0 12px; text-align: right">
        <el-button :icon="Connection" type="primary" plain :disabled="!canPreview" :loading="loading" @click="loadPreview">
          按日期预览测次
        </el-button>
      </div>

      <template v-if="preview">
        <el-alert
          v-for="(reason, index) in preview.blocked"
          :key="index"
          type="error"
          :closable="false"
          :title="reason"
          show-icon
          style="margin-bottom: 8px"
        />

        <div class="merge-summary">
          <el-tag type="success" effect="plain">重复日期 {{ preview.duplicateCount }} 组</el-tag>
          <el-tag type="info" effect="plain">主裂缝独有 {{ preview.primaryOnlyCount }} 次</el-tag>
          <el-tag type="warning" effect="plain">被并裂缝独有 {{ preview.mergedOnlyCount }} 次（并入主裂缝）</el-tag>
        </div>

        <template v-if="preview.blocked.length === 0">
          <h4 class="merge-section-title">重复日期核对（两条读数二选一，默认保留宽度较大者）</h4>
          <el-table v-if="duplicateRows.length > 0" :data="duplicateRows" border stripe size="small">
            <el-table-column prop="date" label="复测日期" width="108" />
            <el-table-column label="主裂缝读数" min-width="190">
              <template #default="{ row }">
                <label class="merge-choice" :class="{ 'is-chosen': row.choice === 'primary' }">
                  <el-radio
                    :model-value="row.choice"
                    value="primary"
                    @change="keepSide(row, 'primary')"
                  >
                    <span>{{ row.primary?.code }} · {{ formatMm(row.primary?.widthMm ?? 0) }}</span>
                  </el-radio>
                  <span class="merge-choice__meta">
                    长 {{ row.primary?.lengthMm ?? 0 }} mm · {{ row.primary?.surveyor ?? '—' }}
                    <el-tag v-if="!row.equalWidth && row.primary && row.primary.widthMm > (row.merged?.widthMm ?? 0)" size="small" type="danger" effect="plain">较宽·建议</el-tag>
                  </span>
                </label>
              </template>
            </el-table-column>
            <el-table-column label="被并裂缝读数" min-width="190">
              <template #default="{ row }">
                <label class="merge-choice" :class="{ 'is-chosen': row.choice === 'merged' }">
                  <el-radio
                    :model-value="row.choice"
                    value="merged"
                    @change="keepSide(row, 'merged')"
                  >
                    <span>{{ row.merged?.code }} · {{ formatMm(row.merged?.widthMm ?? 0) }}</span>
                  </el-radio>
                  <span class="merge-choice__meta">
                    长 {{ row.merged?.lengthMm ?? 0 }} mm · {{ row.merged?.surveyor ?? '—' }}
                    <el-tag v-if="!row.equalWidth && row.merged && row.merged.widthMm > (row.primary?.widthMm ?? 0)" size="small" type="danger" effect="plain">较宽·建议</el-tag>
                  </span>
                </label>
              </template>
            </el-table-column>
            <el-table-column label="宽度差" width="110">
              <template #default="{ row }">
                <el-tag v-if="row.equalWidth" size="small" type="warning" effect="dark">等宽·必选</el-tag>
                <span v-else>{{ widthDiff(row) }}</span>
              </template>
            </el-table-column>
          </el-table>
          <el-alert
            v-else
            type="success"
            :closable="false"
            title="两边测次日期没有重复，被并裂缝的全部测次将直接并入主裂缝并按日期重排。"
            style="margin: 8px 0"
          />

          <div v-if="duplicateRows.length > 0" class="merge-actions-line">
            <el-button size="small" text type="primary" @click="applyDefaultChoices">全部采用较宽读数</el-button>
            <span v-if="missingRows.length > 0" class="merge-warn merge-warn--inline">
              还有 {{ missingRows.length }} 组未选择，漏选不能保存
            </span>
          </div>

          <h4 class="merge-section-title">独有日期测次（归并后全部保留）</h4>
          <el-table :data="singleRows" border stripe size="small" max-height="220">
            <el-table-column prop="date" label="复测日期" width="108" />
            <el-table-column label="来源" width="150">
              <template #default="{ row }">
                <el-tag v-if="row.primary" size="small" type="success" effect="plain">{{ row.primary.code }}</el-tag>
                <el-tag v-else size="small" type="warning" effect="plain">{{ row.merged?.code }}（并入）</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="宽度(mm)" width="120">
              <template #default="{ row }">{{ formatMm(row.primary?.widthMm ?? row.merged?.widthMm ?? 0) }}</template>
            </el-table-column>
            <el-table-column label="长度(mm)" width="110">
              <template #default="{ row }">{{ row.primary?.lengthMm ?? row.merged?.lengthMm ?? 0 }}</template>
            </el-table-column>
            <el-table-column label="复测人" min-width="120">
              <template #default="{ row }">{{ row.primary?.surveyor ?? row.merged?.surveyor ?? '—' }}</template>
            </el-table-column>
          </el-table>

          <el-form label-width="92px" style="margin-top: 14px">
            <el-form-item label="核验人" required>
              <el-input v-model="verifier" placeholder="核对重复读数的责任人，必填" style="width: 260px" />
            </el-form-item>
            <el-form-item label="归并说明">
              <el-input v-model="remark" type="textarea" :rows="2" placeholder="可记录重复录入原因等（选填）" />
            </el-form-item>
          </el-form>
        </template>
      </template>
    </div>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button
        type="primary"
        :disabled="!canSubmit"
        :loading="submitting"
        @click="submit"
      >
        确认归并
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.merge-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 4px 0 12px;
}

.merge-section-title {
  margin: 14px 0 8px;
  font-size: 14px;
  font-weight: 600;
}

.merge-choice {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.merge-choice.is-chosen {
  background: #eaf6ee;
  outline: 1px solid #9fceb2;
}

.merge-choice__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding-left: 24px;
  font-size: 12px;
  color: #5b6b82;
}

.merge-actions-line {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 6px 0;
}

.merge-warn {
  margin: 8px 0;
  padding: 8px 12px;
  border-radius: 4px;
  background: #fdecea;
  color: #c0392b;
  font-size: 13px;
}

.merge-warn--inline {
  margin: 0;
  padding: 2px 8px;
}
</style>
