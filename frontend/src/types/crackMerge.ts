/**
 * 裂缝归并：同一环片上因编号重复录入的两条裂缝，经核验后合为一条。
 * 被并裂缝物理删除，其未被保留的测次一并删除，主裂缝按日期重排测次；
 * 归并过程留痕到 crackMerges 表，图表/台账只认主裂缝。
 */

/** 归并核对时单侧的一条读数（只读快照，供预览展示） */
export interface MergeSideSnapshot {
  surveyId: string
  seq: number
  date: string
  widthMm: number
  lengthMm: number
  surveyor: string
}

/** 建议快照（归并前留痕；被并侧若有待下发建议会随归并删除） */
export interface MergeAdviceSnapshot {
  adviceId: string
  level: string
  measure: string
  basis: string
  state: string
}

/** 被并裂缝留痕信息 */
export interface MergedCrackSnapshot {
  crackId: string
  code: string
  ringId: string
  sectionId: string
  position: string
  direction: string
  state: string
  widthMm: number
  lengthMm: number
}

/** 重复日期的一条配对读数 */
export interface MergePairSide {
  side: 'primary' | 'merged'
  code: string
  widthMm: number
  lengthMm: number
  surveyor: string
  surveyId: string
  seq: number
}

/** 预览时按日期归并的一行 */
export interface MergePreviewRow {
  date: string
  /** 主裂缝当日读数（唯一日期时可能为空） */
  primary: MergePairSide | null
  /** 被并裂缝当日读数（唯一日期时可能为空） */
  merged: MergePairSide | null
  /** 两侧同日时为重复日期，需要核验人选保留哪条 */
  duplicate: boolean
  /** 重复日期的两条宽度是否完全一致（系统无法默认，必须人工选） */
  equalWidth: boolean
  /** 默认建议保留侧；等宽时为 null */
  defaultWinner: 'primary' | 'merged' | null
  /** 核验人当前选择的保留读数来源 */
  choice: 'primary' | 'merged' | null
}

/** 归并预览结果 */
export interface MergePreview {
  primaryCrackId: string
  mergedCrackId: string
  rows: MergePreviewRow[]
  duplicateCount: number
  /** 主裂缝独立日期条数 */
  primaryOnlyCount: number
  /** 被并裂缝独立日期条数 */
  mergedOnlyCount: number
  /** 阻断原因（跨环片 / 已有已下发或已完成建议 等）；非空时不可进入预览确认 */
  blocked: string[]
}

/** 提交归并的入参（选择结果来自预览） */
export interface CommitMergeRequest {
  primaryCrackId: string
  mergedCrackId: string
  /** 重复日期选择：key 为日期，value 为保留读数的测次 id */
  choiceByDate: Record<string, string>
  /** 核验人 */
  verifier: string
  /** 归并说明（可空） */
  remark: string
}

/** 裂缝归并记录 */
export interface CrackMerge {
  id: string
  /** 主裂缝（归并后保留） */
  primaryCrackId: string
  primaryCrackCode: string
  /** 被并裂缝（归并后删除，编号仅在此留痕） */
  mergedCrackId: string
  mergedCrackCode: string
  ringId: string
  sectionId: string
  /** 重复日期核对结果：日期 → 保留读数来源（主/被并） */
  duplicateChoices: Record<string, 'primary' | 'merged'>
  /** 被保留的被并测次 id 列表（被并入主裂缝的独立日期与重复胜出读数） */
  movedSurveyIds: string[]
  /** 被丢弃的重复测次 id 列表 */
  droppedSurveyIds: string[]
  /** 归并后主裂缝测次数 / 重算后的末测次月均速率 / 分级 */
  resultSurveyCount: number
  resultRate: number
  resultLevel: string
  primaryAdviceBefore: MergeAdviceSnapshot | null
  primaryAdviceAfter: MergeAdviceSnapshot | null
  /** 被并裂缝上随归并删除的待下发建议 */
  removedMergedAdvices: MergeAdviceSnapshot[]
  mergedCrack: MergedCrackSnapshot
  verifier: string
  remark: string
  mergedAt: number
  createdAt: number
  updatedAt: number
}

/** 提交结果，返回写入的归并记录 */
export type CommitMergeResult = CrackMerge
