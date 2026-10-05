<script setup lang="ts">
/**
 * 归并记录抽屉：列出全部裂缝归并留痕，展开可查看重复日期核对结果、
 * 被并裂缝快照、迁移/丢弃测次与建议变更。
 */
import { computed } from 'vue'
import { useIdbTable } from '@/hooks/useIdbTable'
import { type CrackMergeRow } from '@/utils/db'
import { formatMm, formatRate } from '@/utils/rate'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

const mergeTable = useIdbTable<CrackMergeRow>((database) => database.crackMerges, {
  sortByUpdatedAt: false
})

const records = computed(() =>
  [...mergeTable.rows.value].sort((a, b) => b.mergedAt - a.mergedAt)
)

function formatTime(stamp: number): string {
  if (!stamp) return '—'
  const date = new Date(stamp)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function choiceRows(record: CrackMergeRow): Array<{ date: string; keep: string }> {
  return Object.entries(record.duplicateChoices).map(([date, side]) => ({
    date,
    keep: side === 'primary' ? record.primaryCrackCode : record.mergedCrackCode
  }))
}

/** 展开区的建议变更表数据（主裂缝重算 / 被并侧删除） */
function adviceChangeRows(
  record: CrackMergeRow
): Array<{ target: string; before: string; after: string }> {
  const describe = (item: { level: string; measure: string; state: string }): string =>
    `${item.level} / ${item.measure}（${item.state}）`
  const rows: Array<{ target: string; before: string; after: string }> = []
  if (record.primaryAdviceBefore) {
    rows.push({
      target: `主裂缝 ${record.primaryCrackCode}`,
      before: describe(record.primaryAdviceBefore),
      after: record.primaryAdviceAfter ? describe(record.primaryAdviceAfter) : '未变化'
    })
  }
  record.removedMergedAdvices.forEach((item) => {
    rows.push({
      target: `被并裂缝 ${record.mergedCrackCode}`,
      before: describe(item),
      after: '随归并删除'
    })
  })
  return rows
}
</script>

<template>
  <el-drawer v-model="visible" title="裂缝归并记录" size="720px">
    <el-empty v-if="records.length === 0" description="还没有归并记录" />
    <el-table v-else :data="records" border stripe size="small" row-key="id">
      <el-table-column type="expand">
        <template #default="{ row }">
          <div style="padding: 8px 16px">
            <p class="muted" style="margin: 4px 0">
              被并裂缝：{{ row.mergedCrack.code }}（{{ row.mergedCrack.position }} / {{ row.mergedCrack.direction }}，
              台账状态 {{ row.mergedCrack.state }}，归并前宽度 {{ formatMm(row.mergedCrack.widthMm) }}），编号仅在本记录留痕。
            </p>
            <p class="muted" style="margin: 4px 0">
              并入测次 {{ row.movedSurveyIds.length }} 条；重复日期弃留 {{ row.droppedSurveyIds.length }} 条；
              归并后主裂缝共 {{ row.resultSurveyCount }} 个测次，末测次月均速率
              {{ formatRate(row.resultRate) }}，分级「{{ row.resultLevel }}」。
            </p>
            <template v-if="choiceRows(row).length > 0">
              <h4 class="record-subtitle">重复日期核对</h4>
              <el-table :data="choiceRows(row)" border size="small">
                <el-table-column prop="date" label="复测日期" width="140" />
                <el-table-column label="保留读数来源" prop="keep" />
              </el-table>
            </template>
            <template v-if="row.primaryAdviceBefore || row.removedMergedAdvices.length > 0">
              <h4 class="record-subtitle">建议变更</h4>
              <el-table :data="adviceChangeRows(row)" border size="small">
                <el-table-column prop="target" label="对象" width="180" />
                <el-table-column prop="before" label="归并前" min-width="200" />
                <el-table-column prop="after" label="归并后" min-width="200" />
              </el-table>
            </template>
            <p v-if="row.remark" class="muted" style="margin-top: 8px">归并说明：{{ row.remark }}</p>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="归并时间" width="150">
        <template #default="{ row }">{{ formatTime(row.mergedAt) }}</template>
      </el-table-column>
      <el-table-column label="主裂缝" min-width="130">
        <template #default="{ row }"><strong>{{ row.primaryCrackCode }}</strong></template>
      </el-table-column>
      <el-table-column label="被并编号" min-width="130">
        <template #default="{ row }">
          <el-tag size="small" type="info" effect="plain">{{ row.mergedCrackCode }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="重复核对" width="90">
        <template #default="{ row }">{{ Object.keys(row.duplicateChoices).length }} 组</template>
      </el-table-column>
      <el-table-column label="归并后速率" width="130">
        <template #default="{ row }">{{ formatRate(row.resultRate) }}</template>
      </el-table-column>
      <el-table-column label="分级" width="80">
        <template #default="{ row }">
          <el-tag
            size="small"
            :type="row.resultLevel === '严重' ? 'danger' : row.resultLevel === '较重' ? 'warning' : 'success'"
            effect="plain"
          >
            {{ row.resultLevel }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="verifier" label="核验人" width="100" />
    </el-table>
  </el-drawer>
</template>

<style scoped>
.record-subtitle {
  margin: 10px 0 6px;
  font-size: 13px;
  font-weight: 600;
}
</style>
