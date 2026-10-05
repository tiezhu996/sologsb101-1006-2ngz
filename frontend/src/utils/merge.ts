/**
 * 裂缝归并：
 * - 同一环片上重复录入的两条裂缝，经核验人逐日期核对读数后合并到主裂缝；
 * - 跨环片、任一侧已有「已下发/已完成」建议时禁止归并；
 * - 确认在单个 Dexie 读写事务内完成，任何一步失败整体回滚；
 *   先查重再写入，重试不会产生重复归并。
 */
import type { Advice, AdviceState } from '@/types/advice'
import type { Crack } from '@/types/crack'
import type { Survey } from '@/types/survey'
import type { CrackMergeDuplicate } from '@/types/merge'
import {
  createId,
  db,
  ROW_REVISION,
  type AdviceRow,
  type CrackMergeRow,
  type CrackRow,
  type SurveyRow
} from '@/utils/db'
import { basisText, buildSurveyPoints, levelFromRate, round } from '@/utils/rate'

/** 已下发或已完成的建议不允许随裂缝归并处理 */
const BLOCKING_ADVICE_STATES: AdviceState[] = ['已下发', '已完成']

/** 预览中的一个日期行：把两边同日读数摆在一起核对 */
export interface MergePreviewRow {
  date: string
  primarySurvey: Survey | null
  mergedSurvey: Survey | null
  /** 是否为重复日期（两边各有一条读数，需核验人二选一） */
  duplicate: boolean
  /** 默认建议保留的测次 id：宽度较大者，宽度相同默认保留主裂缝读数 */
  defaultKeptSurveyId: string
}

export interface MergePreview {
  primary: Crack
  merged: Crack
  rows: MergePreviewRow[]
  /** 重复日期核对行 */
  duplicates: MergePreviewRow[]
  /** 主裂缝独有的测次日期 */
  primaryOnlyDates: string[]
  /** 被并裂缝独有的测次日期（归并后转入主裂缝） */
  mergedOnlyDates: string[]
  /** 不能归并的原因；非空时确认按钮应禁用 */
  blockReason: string | null
  primaryAdvices: Advice[]
  mergedAdvices: Advice[]
}

/** 归并确认入参：每个重复日期最终保留的测次 id + 核验人 */
export interface ConfirmMergeInput {
  primaryCrackId: string
  mergedCrackId: string
  /** key=复测日期，value=该日期保留的测次 id */
  keptSurveyByDate: Record<string, string>
  reviewer: string
}

export interface ConfirmMergeResult {
  merge: CrackMergeRow
  surveyCountAfter: number
  /** 归并后主裂缝最新月均速率 */
  latestRate: number
  level: ReturnType<typeof levelFromRate>
}

interface MergeSides {
  primary: CrackRow | undefined
  merged: CrackRow | undefined
  primarySurveys: SurveyRow[]
  mergedSurveys: SurveyRow[]
  primaryAdvices: AdviceRow[]
  mergedAdvices: AdviceRow[]
}

async function loadMergeSides(primaryId: string, mergedId: string): Promise<MergeSides> {
  const [primary, merged, primarySurveys, mergedSurveys, primaryAdvices, mergedAdvices] = await Promise.all([
    db.cracks.get(primaryId),
    db.cracks.get(mergedId),
    db.surveys.where('crackId').equals(primaryId).toArray(),
    db.surveys.where('crackId').equals(mergedId).toArray(),
    db.advices.where('crackId').equals(primaryId).toArray(),
    db.advices.where('crackId').equals(mergedId).toArray()
  ])
  return { primary, merged, primarySurveys, mergedSurveys, primaryAdvices, mergedAdvices }
}

/** 归并前置资格校验，返回不能归并的原因；返回 null 表示可以继续 */
export async function checkMergeBlockReason(primaryId: string, mergedId: string): Promise<string | null> {
  if (!primaryId || !mergedId) return '请先选择主裂缝与被并裂缝'
  if (primaryId === mergedId) return '主裂缝与被并裂缝不能是同一条裂缝'

  const { primary, merged, primaryAdvices, mergedAdvices } = await loadMergeSides(primaryId, mergedId)
  if (!primary) return '主裂缝不存在或已被删除'
  if (!merged) return '被并裂缝不存在，可能此前已经完成归并，请勿重复操作'
  if (primary.ringId !== merged.ringId) {
    return `两条裂缝分属不同环片（${primary.code} 与 ${merged.code}），不能跨环片归并`
  }

  // 被并裂缝只能注销一次：主裂缝、被并裂缝任一方已处于归并关系中都拒绝
  const [existingPair, mergedAgain] = await Promise.all([
    db.crackMerges
      .where('primaryCrackId')
      .equals(primaryId)
      .and((record) => record.mergedCrackId === mergedId)
      .count(),
    db.crackMerges.where('mergedCrackId').anyOf([primaryId, mergedId]).count()
  ])
  if (existingPair > 0) return '这两条裂缝已经归并过，不能重复归并'
  if (mergedAgain > 0) return '其中一条裂缝已经作为被并裂缝注销，不能再次归并'

  const blockingPrimary = primaryAdvices.filter((advice) => BLOCKING_ADVICE_STATES.includes(advice.state))
  const blockingMerged = mergedAdvices.filter((advice) => BLOCKING_ADVICE_STATES.includes(advice.state))
  if (blockingPrimary.length > 0 || blockingMerged.length > 0) {
    const sides: string[] = []
    if (blockingPrimary.length > 0) sides.push(`主裂缝 ${primary.code} 已有「${blockingPrimary[0].state}」建议`)
    if (blockingMerged.length > 0) sides.push(`被并裂缝 ${merged.code} 已有「${blockingMerged[0].state}」建议`)
    return `${sides.join('；')}，不能直接归并`
  }
  return null
}

/**
 * 按日期预览两侧测次：重复日期成对展示，默认保留宽度较大的读数
 * （宽度相同默认保留主裂缝，核验人可改选）。
 */
export async function buildMergePreview(primaryId: string, mergedId: string): Promise<MergePreview | null> {
  const { primary, merged, primarySurveys, mergedSurveys, primaryAdvices, mergedAdvices } =
    await loadMergeSides(primaryId, mergedId)
  if (!primary || !merged) return null

  const blockReason = await checkMergeBlockReason(primaryId, mergedId)

  const groups = new Map<string, { primary: SurveyRow | null; merged: SurveyRow | null }>()
  const ensure = (date: string): { primary: SurveyRow | null; merged: SurveyRow | null } => {
    const current = groups.get(date)
    if (current) return current
    const empty = { primary: null, merged: null }
    groups.set(date, empty)
    return empty
  }
  primarySurveys.forEach((survey) => {
    ensure(survey.date).primary = survey
  })
  mergedSurveys.forEach((survey) => {
    ensure(survey.date).merged = survey
  })

  const rows: MergePreviewRow[] = []
  const primaryOnlyDates: string[] = []
  const mergedOnlyDates: string[] = []
  Array.from(groups.entries())
    .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
    .forEach(([date, pair]) => {
      const { primary: ps, merged: ms } = pair
      if (ps && ms) {
        // 默认留宽：取宽度较大者；宽度相同默认主裂缝
        const defaultKeptSurveyId = ms.widthMm > ps.widthMm ? ms.id : ps.id
        rows.push({ date, primarySurvey: ps, mergedSurvey: ms, duplicate: true, defaultKeptSurveyId })
      } else if (ps) {
        rows.push({ date, primarySurvey: ps, mergedSurvey: null, duplicate: false, defaultKeptSurveyId: ps.id })
        primaryOnlyDates.push(date)
      } else if (ms) {
        rows.push({ date, primarySurvey: null, mergedSurvey: ms, duplicate: false, defaultKeptSurveyId: ms.id })
        mergedOnlyDates.push(date)
      }
    })

  return {
    primary,
    merged,
    rows,
    duplicates: rows.filter((row) => row.duplicate),
    primaryOnlyDates,
    mergedOnlyDates,
    blockReason,
    primaryAdvices,
    mergedAdvices
  }
}

/** 校验某个重复日期的保留选择是否属于该日期两侧读数之一 */
function resolveKeptPair(
  row: MergePreviewRow,
  keptSurveyId: string
): { kept: SurveyRow; dropped: SurveyRow } | null {
  const pair = [row.primarySurvey, row.mergedSurvey].filter((item): item is SurveyRow => item !== null)
  const kept = pair.find((survey) => survey.id === keptSurveyId)
  const dropped = pair.find((survey) => survey.id !== keptSurveyId)
  if (!kept || !dropped) return null
  return { kept, dropped }
}

/**
 * 确认归并：单个事务内完成读数取舍、测次重排、变化量/速率重算、
 * 待下发建议重写、归并记录写入与被并裂缝删除。
 * 任一步抛错都会由 Dexie 回滚整个事务；重复执行因前置查重不会写第二遍。
 */
export async function confirmCrackMerge(input: ConfirmMergeInput): Promise<ConfirmMergeResult> {
  const reviewer = input.reviewer.trim()
  if (!reviewer) throw new Error('请填写核验人后再确认归并')

  return db.transaction(
    'rw',
    db.cracks,
    db.surveys,
    db.advices,
    db.crackMerges,
    async (): Promise<ConfirmMergeResult> => {
      // 事务内重新校验，避免预览后数据被其他操作改动
      const reason = await checkMergeBlockReason(input.primaryCrackId, input.mergedCrackId)
      if (reason) throw new Error(reason)

      const preview = await buildMergePreview(input.primaryCrackId, input.mergedCrackId)
      if (!preview) throw new Error('归并预览生成失败，已取消归并')

      const now = Date.now()
      const keptRows: SurveyRow[] = []
      const discardedIds: string[] = []
      const transferredSurveyIds: string[] = []
      const duplicateRecords: CrackMergeDuplicate[] = []

      preview.rows.forEach((row) => {
        if (row.duplicate) {
          const resolved = resolveKeptPair(row, input.keptSurveyByDate[row.date] ?? '')
          if (!resolved) {
            // 漏选 / 选了不属于该日期的读数：直接中止，避免把读数差误当成新增变化
            throw new Error(`重复日期 ${row.date} 的保留读数未核对，请逐条选择后再保存`)
          }
          const { kept, dropped } = resolved
          keptRows.push({ ...kept, crackId: input.primaryCrackId })
          discardedIds.push(dropped.id)
          duplicateRecords.push({
            date: row.date,
            keptSurveyId: kept.id,
            keptCrackId: kept.crackId,
            keptWidthMm: kept.widthMm,
            droppedSurveyId: dropped.id,
            droppedCrackId: dropped.crackId,
            droppedWidthMm: dropped.widthMm
          })
        } else if (row.mergedSurvey) {
          keptRows.push({ ...row.mergedSurvey, crackId: input.primaryCrackId })
          transferredSurveyIds.push(row.mergedSurvey.id)
        } else if (row.primarySurvey) {
          keptRows.push(row.primarySurvey)
        }
      })

      // 按日期重排序次，重算与上一测次的变化量
      keptRows.sort((a, b) => (a.date === b.date ? a.seq - b.seq : a.date.localeCompare(b.date)))
      const recalculated: SurveyRow[] = keptRows.map((survey, index) => {
        const previous = index === 0 ? null : keptRows[index - 1]
        return {
          ...survey,
          seq: index + 1,
          deltaWidthMm: previous ? round(survey.widthMm - previous.widthMm, 2) : 0,
          updatedAt: now
        }
      })

      // 重算最新月均速率与分级（建议依据随之更新）
      const points = buildSurveyPoints(recalculated)
      const latest = points[points.length - 1]
      const latestRateValue = latest ? latest.rate : 0
      const level = levelFromRate(latestRateValue)
      const basis = basisText(latestRateValue, level)

      // 落库：测次取舍 → 主裂缝读数同步 → 待下发建议按新速率重算依据 → 归并记录 → 删除被并裂缝
      await db.surveys.bulkPut(recalculated)
      if (discardedIds.length > 0) await db.surveys.bulkDelete(discardedIds)

      if (latest) {
        await db.cracks.update(input.primaryCrackId, {
          widthMm: latest.widthMm,
          lengthMm: latest.lengthMm,
          updatedAt: now
        })
      }

      // 资格校验已保证没有已下发/已完成建议：主裂缝待下发建议保留并按新速率更新；被并侧待下发建议注销
      const pendingPrimary = preview.primaryAdvices.filter((advice) => advice.state === '待下发')
      if (pendingPrimary.length > 0) {
        await db.advices.bulkPut(
          pendingPrimary.map((advice) => ({
            ...advice,
            level,
            basis,
            updatedAt: now
          }))
        )
      }
      const mergedPendingIds = preview.mergedAdvices
        .filter((advice) => advice.state === '待下发')
        .map((advice) => advice.id)
      if (mergedPendingIds.length > 0) await db.advices.bulkDelete(mergedPendingIds)

      const mergeRow: CrackMergeRow = {
        id: createId('mrg'),
        primaryCrackId: preview.primary.id,
        mergedCrackId: preview.merged.id,
        ringId: preview.primary.ringId,
        sectionId: preview.primary.sectionId,
        primaryCode: preview.primary.code,
        mergedCode: preview.merged.code,
        duplicates: duplicateRecords,
        transferredSurveyIds,
        discardedSurveyIds: discardedIds,
        surveyCountAfter: recalculated.length,
        reviewer,
        mergedAt: now,
        createdAt: now,
        updatedAt: now,
        revision: ROW_REVISION
      }
      await db.crackMerges.add(mergeRow)
      await db.cracks.delete(preview.merged.id)

      return {
        merge: mergeRow,
        surveyCountAfter: recalculated.length,
        latestRate: latestRateValue,
        level
      }
    }
  )
}
