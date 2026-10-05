/**
 * 裂缝归并：同一环片上重复录入的两条裂缝，经核验后合并为一条主裂缝。
 * 被并裂缝删除，其编号与逐日期的读数取舍留存在本记录中，图表只认主裂缝。
 */

/** 归并时同一复测日期两边各有一条读数的核对结果 */
export interface CrackMergeDuplicate {
  /** 重复的复测日期 YYYY-MM-DD */
  date: string
  /** 最终保留的测次 id */
  keptSurveyId: string
  /** 保留读数所属裂缝（主裂缝或被并裂缝） */
  keptCrackId: string
  /** 保留读数宽度（mm） */
  keptWidthMm: number
  /** 被放弃的测次 id */
  droppedSurveyId: string
  /** 放弃读数所属裂缝 */
  droppedCrackId: string
  /** 放弃读数宽度（mm） */
  droppedWidthMm: number
}

export interface CrackMerge {
  id: string
  /** 归并后保留的主裂缝 id */
  primaryCrackId: string
  /** 被归并并注销的裂缝 id */
  mergedCrackId: string
  ringId: string
  /** 冗余区间 id */
  sectionId: string
  /** 归并时主裂缝编号快照 */
  primaryCode: string
  /** 被并裂缝编号（归并后仅留存在本记录中） */
  mergedCode: string
  /** 重复日期的读数取舍明细 */
  duplicates: CrackMergeDuplicate[]
  /** 由被并裂缝转入主裂缝的测次 id（被并侧独有的日期） */
  transferredSurveyIds: string[]
  /** 归并中放弃（重复日期未选中）的测次 id */
  discardedSurveyIds: string[]
  /** 归并后主裂缝的测次总数 */
  surveyCountAfter: number
  /** 核验人 */
  reviewer: string
  /** 归并生效时间（毫秒时间戳） */
  mergedAt: number
  createdAt: number
  updatedAt: number
}
