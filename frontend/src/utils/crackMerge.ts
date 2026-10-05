/**
 * 裂缝归并业务：
 * 1. 预览：同环片两条裂缝按日期对齐测次，重复日期配对核对，默认建议保留宽度较大的读数；
 * 2. 提交：单事务迁移被并测次、删除被弃读数与被并裂缝、按日期重排序次并重算变化量/速率、
 *    重算主裂缝待下发建议的等级与依据，写入归并留痕。
 * 任一步失败由 Dexie 事务整体回滚；归并记录 id 由双方裂缝 id 确定，重试不产生重复记录。
 */
import type { CrackRow, AdviceRow, SurveyRow } from '@/utils/db'
import { db } from '@/utils/db'
import type {
  CommitMergeRequest,
  CommitMergeResult,
  CrackMerge,
  MergeAdviceSnapshot,
  MergePairSide,
  MergePreview,
  MergePreviewRow,
  MergedCrackSnapshot
} from '@/types/crackMerge'
import type { Advice, AdviceLevel } from '@/types/advice'
import { basisText, buildSurveyPoints, levelFromRate, round } from '@/utils/rate'
import type { Survey } from '@/types/survey'

/** 阻断归并的业务错误（UI 直接展示原因） */
export class MergeBlockedError extends Error {
  reasons: string[]
  constructor(reasons: string[]) {
    super(reasons.join('；'))
    this.name = 'MergeBlockedError'
    this.reasons = reasons
  }
}

const LOCKED_ADVICE_STATES: Advice['state'][] = ['已下发', '已完成']

function toPairSide(code: string, survey: Survey, side: 'primary' | 'merged'): MergePairSide {
  return {
    side,
    code,
    widthMm: survey.widthMm,
    lengthMm: survey.lengthMm,
    surveyor: survey.surveyor,
    surveyId: survey.id,
    seq: survey.seq
  }
}

function adviceSnapshot(advice: AdviceRow | null | undefined): MergeAdviceSnapshot | null {
  if (!advice) return null
  return {
    adviceId: advice.id,
    level: advice.level,
    measure: advice.measure,
    basis: advice.basis,
    state: advice.state
  }
}

/** 归并记录主键：由双方裂缝 id 确定，同一对裂缝无论重试几次只产生一条记录 */
export function mergeRecordId(primaryCrackId: string, mergedCrackId: string): string {
  return `mrg_${primaryCrackId}__${mergedCrackId}`
}

/**
 * 构建归并预览：按日期对齐双方测次。
 * 不做写操作；存在阻断条件时 rows 仍会给出（供查看），但 blocked 非空，禁止确认。
 */
export async function buildMergePreview(primaryCrackId: string, mergedCrackId: string): Promise<MergePreview> {
  const blocked: string[] = []
  if (!primaryCrackId || !mergedCrackId) {
    blocked.push('请先选定主裂缝与被并裂缝')
    return {
      primaryCrackId,
      mergedCrackId,
      rows: [],
      duplicateCount: 0,
      primaryOnlyCount: 0,
      mergedOnlyCount: 0,
      blocked
    }
  }
  if (primaryCrackId === mergedCrackId) {
    blocked.push('主裂缝与被并裂缝不能是同一条')
  }

  const [primaryCrack, mergedCrack, primarySurveys, mergedSurveys, primaryAdvices, mergedAdvices] = await Promise.all([
    db.cracks.get(primaryCrackId),
    db.cracks.get(mergedCrackId),
    db.surveys.where('crackId').equals(primaryCrackId).toArray(),
    db.surveys.where('crackId').equals(mergedCrackId).toArray(),
    db.advices.where('crackId').equals(primaryCrackId).toArray(),
    db.advices.where('crackId').equals(mergedCrackId).toArray()
  ])

  if (!primaryCrack) blocked.push('主裂缝不存在或已被删除')
  if (!mergedCrack) blocked.push('被并裂缝不存在或已被删除')
  if (primaryCrack && mergedCrack && primaryCrack.ringId !== mergedCrack.ringId) {
    blocked.push('两道裂缝分属不同环片，不能跨环片归并')
  }
  const lockedPrimary = primaryAdvices.find((item) => LOCKED_ADVICE_STATES.includes(item.state))
  if (lockedPrimary) blocked.push(`主裂缝已有「${lockedPrimary.state}」的整治建议，不能直接归并`)
  const lockedMerged = mergedAdvices.find((item) => LOCKED_ADVICE_STATES.includes(item.state))
  if (lockedMerged) blocked.push(`被并裂缝已有「${lockedMerged.state}」的整治建议，不能直接归并`)

  // 已经归并过（留痕存在且被并裂缝已删除）不允许重复归并
  const existed = await db.crackMerges.get(mergeRecordId(primaryCrackId, mergedCrackId))
  if (existed) blocked.push('这两条裂缝已经归并过，不能重复归并')

  const sortSurveys = (list: SurveyRow[]) =>
    [...list].sort((a, b) => (a.date === b.date ? a.seq - b.seq : a.date.localeCompare(b.date)))

  const primarySorted = sortSurveys(primarySurveys)
  const mergedSorted = sortSurveys(mergedSurveys)

  // 同一裂缝同日出现两条及以上测次时无法自动配对，要求先整理测次
  const countByDate = (list: SurveyRow[], label: string): void => {
    const dates = new Map<string, number>()
    list.forEach((row) => dates.set(row.date, (dates.get(row.date) ?? 0) + 1))
    dates.forEach((count, date) => {
      if (count > 1) blocked.push(`${label}在 ${date} 存在 ${count} 条同日期测次，请先删除或整理后再归并`)
    })
  }
  countByDate(primarySorted, '主裂缝')
  countByDate(mergedSorted, '被并裂缝')

  const primaryByDate = new Map(primarySorted.map((row) => [row.date, row]))
  const mergedByDate = new Map(mergedSorted.map((row) => [row.date, row]))
  const allDates = Array.from(new Set([...primaryByDate.keys(), ...mergedByDate.keys()])).sort((a, b) =>
    a.localeCompare(b)
  )

  const rows: MergePreviewRow[] = allDates.map((date) => {
    const p = primaryByDate.get(date) ?? null
    const m = mergedByDate.get(date) ?? null
    const duplicate = Boolean(p && m)
    let defaultWinner: 'primary' | 'merged' | null = null
    let equalWidth = false
    if (p && m) {
      if (p.widthMm > m.widthMm) defaultWinner = 'primary'
      else if (m.widthMm > p.widthMm) defaultWinner = 'merged'
      else {
        equalWidth = true
        defaultWinner = null
      }
    }
    return {
      date,
      primary: p && primaryCrack ? toPairSide(primaryCrack.code, p, 'primary') : null,
      merged: m && mergedCrack ? toPairSide(mergedCrack.code, m, 'merged') : null,
      duplicate,
      equalWidth,
      defaultWinner,
      // 默认勾选宽度较大的读数；等宽时留空，必须核验人显式选择
      choice: defaultWinner
    }
  })

  return {
    primaryCrackId,
    mergedCrackId,
    rows,
    duplicateCount: rows.filter((row) => row.duplicate).length,
    primaryOnlyCount: rows.filter((row) => row.primary && !row.merged).length,
    mergedOnlyCount: rows.filter((row) => row.merged && !row.primary).length,
    blocked
  }
}

/** 提交前的选择完整性校验：任何一个重复日期都不能漏选 */
export function missingChoices(preview: MergePreview): MergePreviewRow[] {
  return preview.rows.filter((row) => row.duplicate && row.choice === null)
}

interface FinalSurveyResult {
  points: ReturnType<typeof buildSurveyPoints>
  rate: number
  level: AdviceLevel
}

/** 归并后按日期重排序次、重算变化量与月均速率（纯计算，便于事务内外复用） */
export function buildFinalSurveys(surveys: Survey[]): FinalSurveyResult {
  const sorted = [...surveys].sort((a, b) => a.date.localeCompare(b.date))
  const points = buildSurveyPoints(
    sorted.map((survey, index) => {
      const previous = index === 0 ? null : sorted[index - 1]
      return {
        ...survey,
        seq: index + 1,
        deltaWidthMm: previous ? round(survey.widthMm - previous.widthMm, 2) : 0
      }
    })
  )
  const last = points[points.length - 1]
  const rate = last ? last.rate : 0
  return { points, rate, level: levelFromRate(rate) }
}

/**
 * 提交归并。全部写入放在同一个 rw 事务中：任何一步失败，裂缝、测次、建议自动恢复原状。
 * 归并记录 id 确定，重复提交（含失败后重试）不会写入第二条。
 */
export async function commitMerge(request: CommitMergeRequest): Promise<CommitMergeResult> {
  const { primaryCrackId, mergedCrackId, choiceByDate, verifier, remark } = request
  const recordId = mergeRecordId(primaryCrackId, mergedCrackId)

  return db.transaction(
    'rw',
    db.cracks,
    db.surveys,
    db.advices,
    db.crackMerges,
    async (): Promise<CommitMergeResult> => {
      // 幂等：同一对裂缝已成功归并，直接返回既有记录，重试不重复
      const existed = (await db.crackMerges.get(recordId)) as CrackMerge | undefined
      if (existed) return existed

      const preview = await buildMergePreview(primaryCrackId, mergedCrackId)
      if (preview.blocked.length > 0) throw new MergeBlockedError(preview.blocked)

      const missing = missingChoices(preview)
      if (missing.length > 0) {
        throw new MergeBlockedError([
          `还有 ${missing.length} 个重复日期未核对保留哪条读数：${missing.map((row) => row.date).join('、')}`
        ])
      }

      const primaryCrack = (await db.cracks.get(primaryCrackId)) as CrackRow
      const mergedCrack = (await db.cracks.get(mergedCrackId)) as CrackRow
      const primarySurveys = await db.surveys.where('crackId').equals(primaryCrackId).toArray()
      const mergedSurveys = await db.surveys.where('crackId').equals(mergedCrackId).toArray()

      const primaryByDate = new Map(primarySurveys.map((row) => [row.date, row]))
      const mergedByDate = new Map(mergedSurveys.map((row) => [row.date, row]))

      // 服务端复算每个重复日期的保留侧，拒绝选择过期/指向不存在读数的请求
      const duplicateChoices: Record<string, 'primary' | 'merged'> = {}
      preview.rows.forEach((row) => {
        if (!row.duplicate) return
        const chosen = choiceByDate[row.date]
        let side: 'primary' | 'merged' | null = null
        if (chosen && chosen === row.primary?.surveyId) side = 'primary'
        else if (chosen && chosen === row.merged?.surveyId) side = 'merged'
        if (!side) {
          throw new MergeBlockedError([`${row.date} 的核对结果无效，请重新预览后再确认`])
        }
        duplicateChoices[row.date] = side
      })

      const now = Date.now()
      const keptSurveys: SurveyRow[] = []
      const movedSurveyIds: string[] = []
      const droppedSurveyIds: string[] = []

      preview.rows.forEach((row) => {
        if (!row.duplicate) {
          if (row.primary) {
            const survey = primaryByDate.get(row.date)
            if (survey) keptSurveys.push(survey)
          } else if (row.merged) {
            const survey = mergedByDate.get(row.date)
            if (survey) {
              keptSurveys.push({ ...survey, crackId: primaryCrackId, updatedAt: now })
              movedSurveyIds.push(survey.id)
            }
          }
          return
        }
        const winnerId = choiceByDate[row.date]
        const winner =
          winnerId === row.primary?.surveyId
            ? primaryByDate.get(row.date)
            : mergedByDate.get(row.date)
        const loserId =
          winnerId === row.primary?.surveyId ? row.merged?.surveyId : row.primary?.surveyId
        if (!winner) throw new MergeBlockedError([`${row.date} 的保留读数不存在，请重新预览`])
        if (winner.crackId === mergedCrackId) {
          keptSurveys.push({ ...winner, crackId: primaryCrackId, updatedAt: now })
          movedSurveyIds.push(winner.id)
        } else {
          keptSurveys.push(winner)
        }
        if (loserId) droppedSurveyIds.push(loserId)
      })

      // 按日期重排序次，重算变化量（月均速率由 points 实时派生，这里同步落库变化量）
      keptSurveys.sort((a, b) => a.date.localeCompare(b.date))
      const finalSurveys: SurveyRow[] = keptSurveys.map((survey, index) => {
        const previous = index === 0 ? null : keptSurveys[index - 1]
        return {
          ...survey,
          crackId: primaryCrackId,
          seq: index + 1,
          deltaWidthMm: previous ? round(survey.widthMm - previous.widthMm, 2) : 0,
          updatedAt: now
        }
      })

      // 被并裂缝独立日期的测次（迁移）与重复日期弃留的测次（删除）必须互斥，
      // 这里再做一次主键去重保护，防止同一条读数被迁移又被删除。
      const movedSet = new Set(movedSurveyIds)
      const droppedSet = new Set(droppedSurveyIds.filter((id) => !movedSet.has(id)))

      await db.surveys.bulkPut(finalSurveys)
      if (droppedSet.size > 0) await db.surveys.bulkDelete(Array.from(droppedSet))

      // 重算月均速率与分级
      const finalResult = buildFinalSurveys(finalSurveys)
      const latest = finalSurveys[finalSurveys.length - 1]

      // 主裂缝台账宽度/长度同步到最新读数（与 recalculate 口径一致）
      if (latest) {
        await db.cracks.update(primaryCrackId, {
          widthMm: latest.widthMm,
          lengthMm: latest.lengthMm,
          updatedAt: now
        })
      }

      // 建议处理：
      // - 主裂缝「待下发」建议：等级/依据按新速率重算（措施保留人工选择）；
      // - 被并裂缝「待下发」建议：随被并裂缝删除（已在阻断校验排除已下发/已完成）；
      // - 双方都无建议时不自动新建建议，避免越权生成。
      const primaryAdvices = await db.advices.where('crackId').equals(primaryCrackId).toArray()
      const mergedAdvices = await db.advices.where('crackId').equals(mergedCrackId).toArray()
      const primaryPending = primaryAdvices.filter((item) => item.state === '待下发')
      const removedMergedAdvices: MergeAdviceSnapshot[] = []

      let primaryAdviceBefore: MergeAdviceSnapshot | null = null
      let primaryAdviceAfter: MergeAdviceSnapshot | null = null

      if (primaryPending.length > 0) {
        const advice = primaryPending[0]
        primaryAdviceBefore = adviceSnapshot(advice)
        const nextLevel = finalResult.level
        const nextBasis = `${basisText(finalResult.rate, nextLevel)}（裂缝归并后按重排测次重算）`
        const updated: AdviceRow = {
          ...advice,
          level: nextLevel,
          basis: nextBasis,
          updatedAt: now
        }
        await db.advices.put(updated)
        primaryAdviceAfter = adviceSnapshot(updated)
      }

      for (const advice of mergedAdvices) {
        removedMergedAdvices.push(adviceSnapshot(advice) as MergeAdviceSnapshot)
        await db.advices.delete(advice.id)
      }

      // 删除被并裂缝（其编号在归并记录里留痕；图表/台账从此只认主裂缝）
      await db.cracks.delete(mergedCrackId)

      const mergedCrackSnapshot: MergedCrackSnapshot = {
        crackId: mergedCrack.id,
        code: mergedCrack.code,
        ringId: mergedCrack.ringId,
        sectionId: mergedCrack.sectionId,
        position: mergedCrack.position,
        direction: mergedCrack.direction,
        state: mergedCrack.state,
        widthMm: mergedCrack.widthMm,
        lengthMm: mergedCrack.lengthMm
      }

      const record: CrackMerge = {
        id: recordId,
        primaryCrackId,
        primaryCrackCode: primaryCrack.code,
        mergedCrackId,
        mergedCrackCode: mergedCrack.code,
        ringId: primaryCrack.ringId,
        sectionId: primaryCrack.sectionId,
        duplicateChoices,
        movedSurveyIds,
        droppedSurveyIds: Array.from(droppedSet),
        resultSurveyCount: finalSurveys.length,
        resultRate: finalResult.rate,
        resultLevel: finalResult.level,
        primaryAdviceBefore,
        primaryAdviceAfter,
        removedMergedAdvices,
        mergedCrack: mergedCrackSnapshot,
        verifier: verifier.trim() || '未署名',
        remark: remark.trim(),
        mergedAt: now,
        createdAt: now,
        updatedAt: now
      }
      await db.crackMerges.put(record)

      return record
    }
  )
}
