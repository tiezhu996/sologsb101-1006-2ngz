/**
 * 裂缝归并逻辑验证脚本（仅本地验证，不参与构建）：
 * 用 fake-indexeddb 驱动 Dexie，验证：
 * 1) 跨环片阻断；2) 任一侧已有已下发/已完成建议阻断；
 * 3) 重复日期默认较宽读数、等宽漏选不能保存；
 * 4) 正常归并：测次迁移/丢弃、按日期重排、变化量/速率重算、主裂缝台账同步、建议重算、被并待下发建议删除；
 * 5) 事务失败整体回滚；6) 重试不产生重复记录。
 */
import 'fake-indexeddb/auto'
import { db } from '../src/utils/db'
import { buildMergePreview, buildFinalSurveys, commitMerge, MergeBlockedError } from '../src/utils/crackMerge'

let passed = 0
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`断言失败: ${message}`)
  passed += 1
  console.log(`  ✓ ${message}`)
}

async function seed(): Promise<void> {
  const now = Date.now()
  const ringA = { id: 'ring-a', sectionId: 'sec', ringNo: 1, mileage: 100, segmentType: '钢筋混凝土', installDate: '2020-01-01', createdAt: now, updatedAt: now }
  const ringB = { id: 'ring-b', sectionId: 'sec', ringNo: 2, mileage: 200, segmentType: '钢筋混凝土', installDate: '2020-01-01', createdAt: now, updatedAt: now }
  // 主裂缝 P 与被并裂缝 M 同在 ring-a；另有一条跨环片裂缝 X
  const cracks = [
    { id: 'p', ringId: 'ring-a', sectionId: 'sec', code: 'P', position: '拱顶', direction: '纵向', widthMm: 0.4, lengthMm: 100, state: '观察', createdAt: now, updatedAt: now },
    { id: 'm', ringId: 'ring-a', sectionId: 'sec', code: 'M', position: '侧墙', direction: '环向', widthMm: 0.5, lengthMm: 200, state: '观察', createdAt: now, updatedAt: now },
    { id: 'x', ringId: 'ring-b', sectionId: 'sec', code: 'X', position: '道床', direction: '斜向', widthMm: 0.3, lengthMm: 90, state: '观察', createdAt: now, updatedAt: now }
  ]
  const mk = (id: string, crackId: string, seq: number, date: string, widthMm: number, lengthMm: number, surveyor = 'tester'): object => ({
    id, crackId, seq, date, widthMm, lengthMm, deltaWidthMm: 0, surveyor, createdAt: now, updatedAt: now
  })
  // P: 2024-01-01 0.40 / 2024-02-01 0.60（重复日，比 M 的 0.55 宽）
  // M: 2024-02-01 0.55 / 2024-03-01 0.80（独有日，并入）
  // 归并后应为：01-01 0.40(P) → 02-01 0.60(P) → 03-01 0.80(M)
  const surveys = [
    mk('p1', 'p', 1, '2024-01-01', 0.4, 100),
    mk('p2', 'p', 2, '2024-02-01', 0.6, 110),
    mk('m1', 'm', 1, '2024-02-01', 0.55, 200),
    mk('m2', 'm', 2, '2024-03-01', 0.8, 220)
  ]
  await db.rings.bulkPut([ringA, ringB])
  await db.cracks.bulkPut(cracks)
  await db.surveys.bulkPut(surveys)
}

async function main(): Promise<void> {
  await db.open()
  await seed()

  console.log('1. 阻断校验')
  const crossRing = await buildMergePreview('p', 'x')
  assert(crossRing.blocked.some((r) => r.includes('不同环片')), '跨环片阻断')
  const crossReverse = await buildMergePreview('x', 'p')
  assert(crossReverse.blocked.some((r) => r.includes('不同环片')), '反向选择同样跨环片阻断')

  const now = Date.now()
  await db.advices.put({ id: 'ad-locked', crackId: 'm', level: '一般', measure: '观测', basis: 'b', state: '已下发', createdAt: now, updatedAt: now })
  const locked = await buildMergePreview('p', 'm')
  assert(locked.blocked.some((r) => r.includes('已下发')), '被并侧已有已下发建议阻断')
  await db.advices.clear()
  await db.advices.put({ id: 'ad-locked2', crackId: 'p', level: '一般', measure: '观测', basis: 'b', state: '已完成', createdAt: now, updatedAt: now })
  const locked2 = await buildMergePreview('p', 'm')
  assert(locked2.blocked.some((r) => r.includes('已完成')), '主侧已有已完成建议阻断')
  await db.advices.clear()

  console.log('2. 预览与默认选择')
  const preview = await buildMergePreview('p', 'm')
  assert(preview.blocked.length === 0, '同环片且无锁定建议时可归并')
  assert(preview.duplicateCount === 1, '识别出 1 组重复日期')
  assert(preview.mergedOnlyCount === 1 && preview.primaryOnlyCount === 1, '识别双方各 1 个独有日期')
  const dup = preview.rows.find((r) => r.date === '2024-02-01')
  assert(dup?.defaultWinner === 'primary' && dup?.choice === 'primary', '重复日期默认保留宽度较大的主裂缝读数 (0.60 > 0.55)')

  console.log('3. 等宽漏选不能保存')
  // 构造等宽重复日
  await db.surveys.put({ id: 'm1', crackId: 'm', seq: 1, date: '2024-02-01', widthMm: 0.6, lengthMm: 200, deltaWidthMm: 0, surveyor: 't', createdAt: now, updatedAt: now })
  const equalPreview = await buildMergePreview('p', 'm')
  const equalDup = equalPreview.rows.find((r) => r.date === '2024-02-01')
  assert(equalDup?.equalWidth === true && equalDup.choice === null, '等宽时不默认勾选')
  let blockedByMissing = false
  try {
    await commitMerge({ primaryCrackId: 'p', mergedCrackId: 'm', choiceByDate: {}, verifier: '核验人', remark: '' })
  } catch (error) {
    blockedByMissing = error instanceof MergeBlockedError
  }
  assert(blockedByMissing, '漏选重复日期时提交被拒')
  // 恢复 0.55 的场景
  await db.surveys.put({ id: 'm1', crackId: 'm', seq: 1, date: '2024-02-01', widthMm: 0.55, lengthMm: 200, deltaWidthMm: 0, surveyor: 't', createdAt: now, updatedAt: now })

  console.log('4. 正常归并 + 建议处理')
  // 主裂缝待下发建议（归并后应按新速率重算等级/依据）；被并裂缝待下发建议（应删除）
  await db.advices.bulkPut([
    { id: 'ad-p', crackId: 'p', level: '严重', measure: '注浆', basis: '旧依据', state: '待下发', createdAt: now, updatedAt: now },
    { id: 'ad-m', crackId: 'm', level: '一般', measure: '观测', basis: '被并依据', state: '待下发', createdAt: now, updatedAt: now }
  ])
  const okPreview = await buildMergePreview('p', 'm')
  const choiceByDate: Record<string, string> = {}
  okPreview.rows.forEach((row) => {
    if (row.duplicate && row.choice && row.primary) choiceByDate[row.date] = row.primary.surveyId
  })
  const record = await commitMerge({ primaryCrackId: 'p', mergedCrackId: 'm', choiceByDate, verifier: '核验人甲', remark: '编号重复' })
  assert(!!record.id && record.movedSurveyIds.includes('m2'), '被并独有测次 m2 迁移')
  assert(record.droppedSurveyIds.includes('m1'), '重复日落败测次 m1 丢弃')

  const mergedCrack = await db.cracks.get('m')
  assert(mergedCrack === undefined, '被并裂缝已删除，图表/台账只认主裂缝')
  const finalSurveys = (await db.surveys.where('crackId').equals('p').toArray()).sort((a, b) => a.seq - b.seq)
  assert(finalSurveys.length === 3, '归并后主裂缝 3 个测次')
  assert(finalSurveys.map((s) => s.seq).join(',') === '1,2,3', '按日期重排序次 1/2/3')
  assert(finalSurveys.map((s) => s.date).join(',') === '2024-01-01,2024-02-01,2024-03-01', '测次日期顺序正确')
  assert(finalSurveys[1].deltaWidthMm === 0.2 && finalSurveys[2].deltaWidthMm === 0.2, '变化量重算 (0.20 / 0.20)')
  assert(finalSurveys[2].widthMm === 0.8 && finalSurveys[2].lengthMm === 220, '末次读数来自被并裂缝')
  const result = buildFinalSurveys(finalSurveys)
  assert(record.resultRate === result.rate, `月均速率重算一致 (${record.resultRate})`)
  assert(record.resultRate >= 0.1 && record.resultRate < 0.25, '0.2mm/29天 月均约 0.207 → 分级应为较重')
  assert(record.resultLevel === '较重', `分级为较重，实际 ${record.resultLevel}`)
  const primaryAfter = await db.cracks.get('p')
  assert(primaryAfter?.widthMm === 0.8 && primaryAfter?.lengthMm === 220, '主裂缝台账宽度/长度同步到末次读数')
  const adP = await db.advices.get('ad-p')
  assert(adP?.level === '较重' && adP.measure === '注浆' && adP.basis.includes('归并后'), '主裂缝待下发建议等级/依据重算，措施保留人工选择')
  const adM = await db.advices.get('ad-m')
  assert(adM === undefined, '被并裂缝待下发建议随归并删除')
  assert(record.removedMergedAdvices[0]?.adviceId === 'ad-m', '被删建议在留痕中有快照')
  assert(record.verifier === '核验人甲' && record.remark === '编号重复', '核验人与说明留痕')
  assert(record.mergedCrack.code === 'M', '被并编号留在归并记录')

  console.log('5. 重试幂等')
  const again = await commitMerge({ primaryCrackId: 'p', mergedCrackId: 'm', choiceByDate, verifier: '核验人甲', remark: '' })
  assert(again.id === record.id, '同对裂缝重试返回同一条记录，不重复写入')
  const mergeCount = await db.crackMerges.count()
  assert(mergeCount === 1, '归并记录只有 1 条')

  console.log('6. 事务失败整体回滚')
  // 再造一对裂缝，并在写入归并记录时让事务抛错 → 所有变更回滚
  await db.cracks.bulkPut([
    { id: 'q', ringId: 'ring-a', sectionId: 'sec', code: 'Q', position: '拱顶', direction: '纵向', widthMm: 0.2, lengthMm: 50, state: '观察', createdAt: now, updatedAt: now },
    { id: 'r', ringId: 'ring-a', sectionId: 'sec', code: 'R', position: '拱顶', direction: '纵向', widthMm: 0.3, lengthMm: 60, state: '观察', createdAt: now, updatedAt: now }
  ])
  await db.surveys.bulkPut([
    { id: 'q1', crackId: 'q', seq: 1, date: '2024-05-01', widthMm: 0.2, lengthMm: 50, deltaWidthMm: 0, surveyor: 't', createdAt: now, updatedAt: now },
    { id: 'r1', crackId: 'r', seq: 1, date: '2024-06-01', widthMm: 0.3, lengthMm: 60, deltaWidthMm: 0, surveyor: 't', createdAt: now, updatedAt: now }
  ])
  const spy = db.crackMerges.put.bind(db.crackMerges)
  db.crackMerges.put = (() => {
    throw new Error('模拟写入失败')
  }) as never
  let rolled = false
  try {
    await commitMerge({ primaryCrackId: 'q', mergedCrackId: 'r', choiceByDate: {}, verifier: '核验人乙', remark: '' })
  } catch (error) {
    rolled = error instanceof Error && error.message.includes('模拟写入失败')
  }
  db.crackMerges.put = spy as never
  assert(rolled, '写入归并记录失败时事务抛错')
  const rStill = await db.cracks.get('r')
  assert(rStill?.id === 'r', '回滚后被并裂缝恢复存在')
  const qSurveys = await db.surveys.where('crackId').equals('q').toArray()
  const rSurveys = await db.surveys.where('crackId').equals('r').toArray()
  assert(qSurveys.length === 1 && rSurveys.length === 1 && rSurveys[0].crackId === 'r', '回滚后双方测次恢复原状（未迁移）')
  const mergeCountAfter = await db.crackMerges.count()
  assert(mergeCountAfter === 1, '失败的归并不留记录，重试不会产生半条数据')

  console.log(`\n全部 ${passed} 项断言通过`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
