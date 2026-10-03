/**
 * 离线合并端到端验证（Node + fake-indexeddb，非生产代码）：
 * npx esbuild scripts/merge.e2e.ts --bundle --platform=node --format=cjs --outfile=/tmp/merge.e2e.cjs
 * node /tmp/merge.e2e.cjs
 */
import 'fake-indexeddb/auto';
import {
  db,
  exportSnapshot,
  listReadings,
  listPendingReadings,
  listImportJobs,
  resetDatabase,
  rowMeta,
  type DatabaseSnapshot,
} from '../src/app/core/utils/db';
import { MergeService } from '../src/app/core/services/merge.service';
import { hashPacket, normalizePackage } from '../src/app/core/utils/merge-packet';
import { groupPending } from '../src/app/core/types/merge';

let failures = 0;
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

/** 模拟一台平板导出的包：步骤 / 读数 id 与本机不同，其中 2 条读数数值冲突，1 条缺应力 */
function deviceSnapshot(local: DatabaseSnapshot, overrides: {
  name: string;
  idSuffix: string;
  readingMutator: (r: { pointCode: string; displacementMm: number; stressMpa: number | null }, seq: number) => void;
  dropStressFor?: string[];
}): DatabaseSnapshot {
  const bridge = local.bridges[0];
  const steps = local.steps.filter((s) => s.bridgeId === bridge.id);
  return {
    name: overrides.name,
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    bridges: [{ ...bridge, id: `dev-${overrides.idSuffix}-bridge` }],
    piers: [],
    bearings: [],
    steps: steps.map((s) => ({ ...s, id: `dev-${overrides.idSuffix}-step-${s.seq}`, bridgeId: `dev-${overrides.idSuffix}-bridge` })),
    readings: steps.flatMap((s) =>
      ['P1', 'P2']
        .map((pointCode) => {
          const base = { pointCode, displacementMm: s.targetLiftMm, stressMpa: 8 as number | null };
          overrides.readingMutator(base, s.seq);
          const row: Record<string, unknown> = {
            id: `dev-${overrides.idSuffix}-read-${s.seq}-${pointCode}`,
            stepId: `dev-${overrides.idSuffix}-step-${s.seq}`,
            pointCode: base.pointCode,
            displacementMm: base.displacementMm,
            recordedAt: `2026-10-03 09:${s.seq}0:0${pointCode === 'P1' ? 1 : 2}`,
            operator: '平板记录员',
            ...rowMeta(),
          };
          if (!overrides.dropStressFor?.includes(`${s.seq}-${pointCode}`)) row['stressMpa'] = base.stressMpa;
          return row as never;
        }),
    ),
    acceptances: [],
  };
}

async function main(): Promise<void> {
  await resetDatabase();

  const merge = new MergeService();

  // 本机仅保留沙河大桥的第 1、2 步
  const local = await exportSnapshot();
  const bridge = local.bridges.find((b) => b.name === '沙河大桥')!;
  const localStepCount = local.steps.filter((s) => s.bridgeId === bridge.id).length;
  const formalBefore = (await listReadings()).filter((r) =>
    local.steps.some((s) => s.id === r.stepId && s.bridgeId === bridge.id),
  ).length;

  // 平板 A：第 1 步 P1 记 3.10；平板 B：同测点记 3.80（冲突）；B 的第 2 步 P2 缺应力
  const packA = deviceSnapshot(local, {
    name: 'tablet-A',
    idSuffix: 'a',
    dropStressFor: [],
    readingMutator: (r, seq) => {
      if (seq === 1 && r.pointCode === 'P1') r.displacementMm = 3.1;
    },
  });
  const packB = deviceSnapshot(local, {
    name: 'tablet-B',
    idSuffix: 'b',
    dropStressFor: ['2-P2'],
    readingMutator: (r, seq) => {
      if (seq === 1 && r.pointCode === 'P1') r.displacementMm = 3.8;
    },
  });

  console.log('1) 挂接与按顺序暂存（不信任设备记录号）');
  const resA = await merge.stageImportPackage(packA, 'a.json');
  const resB = await merge.stageImportPackage(packB, 'b.json');
  check(`A 包暂存条数 = ${localStepCount} 步 × 2 测点 = ${localStepCount * 2}`, resA.staged === localStepCount * 2, `got ${resA.staged}`);
  check(`B 包暂存条数 = ${localStepCount * 2}`, resB.staged === localStepCount * 2, `got ${resB.staged}`);

  const pending = await listPendingReadings();
  check('暂存共 12 条', pending.length === localStepCount * 4, `got ${pending.length}`);
  const groups = groupPending(pending);
  check('按桥梁名+步骤序号+测点编号分成 6 组', groups.length === localStepCount * 2, `got ${groups.length}`);
  const conflict = groups.find((g) => g.stepSeq === 1 && g.pointCode === 'P1');
  check('第1步 P1 组识别为冲突', conflict?.status === 'conflict');
  check('冲突组并列保留 2 条候选', conflict?.candidates.length === 2);
  check(
    '候选挂到本机步骤 id（非设备 id）',
    conflict?.candidates.every((c) => c.resolvedStepId && c.resolvedStepId.startsWith('step-')),
  );
  const missingStress = pending.find((p) => p.stepSeq === 2 && p.pointCode === 'P2' && p.deviceId === 'tablet-B');
  check('缺应力字段按 null + stressMissing 兼容读入', missingStress?.stressMpa === null && missingStress.stressMissing === true);
  const ordinals = pending.filter((p) => p.deviceId === 'tablet-A').map((p) => p.ordinal);
  check('按包内顺序暂存（ordinal 0..n-1）', ordinals.join(',') === Array.from({ length: localStepCount * 2 }, (_, i) => i).join(','));

  console.log('2) 同包重复导入不重复建档');
  const again = await merge.stageImportPackage(packA, 'a.json');
  check('重复包返回 reused', again.reused === true && again.staged === 0);
  check('暂存总数仍为 12', (await listPendingReadings()).length === localStepCount * 4);
  check('任务表仍为 2 个任务', (await listImportJobs()).length === 2);

  console.log('3) 未确认前不进入正式读数');
  const formalMid = (await listReadings()).filter((r) =>
    local.steps.some((s) => s.id === r.stepId && s.bridgeId === bridge.id),
  ).length;
  check('正式读数条数未增加', formalMid === formalBefore, `${formalBefore} -> ${formalMid}`);

  console.log('4) 逐项确认（冲突组采纳 A 的 3.10，其余全采纳）');
  const accepted = groups
    .filter((g) => g.status !== 'unresolved')
    .flatMap((g) =>
      g.candidates
        .filter((c) => {
          if (g.stepSeq === 1 && g.pointCode === 'P1') return c.deviceId === 'tablet-A';
          return true;
        })
        .map((c) => c.id),
    );
  const rejected = groups
    .flatMap((g) => g.candidates)
    .map((c) => c.id)
    .filter((id) => !accepted.includes(id));
  const result = await merge.confirmCandidates(accepted, rejected);
  const expectedAccepted = groups.length * 2 - 1; // 每组 2 候选，冲突组放弃 1 条
  check(`确认完成 ${expectedAccepted} 条（每组至少一条）`, result.finalized === expectedAccepted, `got ${result.finalized}`);

  const readingsAfter = await listReadings();
  const p1 = readingsAfter.filter((r) => r.stepId === local.steps.find((s) => s.seq === 1 && s.bridgeId === bridge.id)!.id && r.pointCode === 'P1');
  const step1Id = local.steps.find((s) => s.seq === 1 && s.bridgeId === bridge.id)!.id;
  const p1Merge = readingsAfter.filter((r) => r.stepId === step1Id && r.pointCode === 'P1' && r.id.startsWith('read-merge-'));
  check('冲突测点只有采纳值进入正式读数（3.10）', p1Merge.length === 1 && p1Merge[0].displacementMm === 3.1,
    p1Merge.map((r) => r.displacementMm).join(','));
  void p1;
  const step2Id = local.steps.find((s) => s.seq === 2 && s.bridgeId === bridge.id)!.id;
  const p2Missing = readingsAfter.find((r) => r.stepId === step2Id && r.pointCode === 'P2' && r.stressMissing);
  check('缺应力读数以缺测进入正式表', !!p2Missing && p2Missing.stressMpa === null);
  check('暂存在确认后清空', (await listPendingReadings()).length === 0);
  check('任务标记 done', (await listImportJobs()).every((j) => j.state === 'done'));

  console.log('5) 确认写入阶段失败重试：确定性 id 保证不重复正式读数');
  // 5.1 相同内容（即使文件名不同）→ 同 hash → 同一任务，已 done 的任务直接复用不建档
  await merge.stageImportPackage(packA, 'a-again.json');
  let jobs = await listImportJobs();
  check('不同文件名但相同内容复用同一任务', jobs.length === 2);

  // 5.2 用一份内容不同的新包制造「确认写入中断」：任务停在 finalizing、finalizeQueue 仍有候选
  const packD = JSON.parse(JSON.stringify(packA)) as DatabaseSnapshot;
  packD.name = 'tablet-D';
  for (const row of packD.readings as Array<{ pointCode: string; displacementMm: number; operator: string }>) {
    row.operator = '丁组记录员';
    if (row.pointCode === 'P1') row.displacementMm = Number((row.displacementMm + 0.11).toFixed(2));
  }
  const resD = await merge.stageImportPackage(packD, 'd.json');
  check('新内容包正常建档', resD.staged === localStepCount * 2);
  const dPending = (await listPendingReadings()).filter((p) => p.deviceId === 'tablet-D');
  const dJob = (await listImportJobs()).find((j) => j.deviceId === 'tablet-D')!;
  const crashedJob = { ...dJob, state: 'failed' as const, phase: 'finalize' as const, finalizeQueue: dPending.map((p) => p.id), finalized: 0 };
  const beforeCount = (await listReadings()).length;
  const finished1 = await merge.resumeImport(crashedJob);
  const afterFirst = (await listReadings()).length;
  check('首次继续写入全部候选', afterFirst - beforeCount === dPending.length, `delta=${afterFirst - beforeCount}`);
  // 5.3 再重试一次同一任务（检查点已空），正式读数条数不再变化
  const finished2 = await merge.resumeImport(finished1);
  check('再次重试不产生重复读数', (await listReadings()).length === afterFirst && finished2.state === 'done');
  const p1Merge2 = (await listReadings()).filter(
    (r) => r.stepId === step1Id && r.pointCode === 'P1' && r.id.startsWith('read-merge-'),
  );
  // 数值不同（3.10 / 3.21）按需求并列保留为重试不重复：各只有 1 条
  check(
    '第1步 P1 合并读数并列保留 3.10 与 3.21 两条，且无重复',
    p1Merge2.length === 2 && p1Merge2.every((r) => [3.1, 3.21].includes(r.displacementMm)),
    `got ${p1Merge2.map((r) => r.displacementMm).join(',')}`,
  );
  jobs = await listImportJobs();

  console.log('6) 无法挂接（本机缺少桥梁/步骤）的记录标记 unresolved');
  const orphan: DatabaseSnapshot = {
    name: 'tablet-C',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    bridges: [{ ...bridge, id: 'dev-c-bridge', name: '不存在的某大桥' }],
    piers: [],
    bearings: [],
    steps: [{ id: 'dev-c-step-9', bridgeId: 'dev-c-bridge', seq: 9, targetLiftMm: 1, syncRequirement: 'sync', limitMm: 10, leader: '', state: 'idle', ...rowMeta() }],
    readings: [
      { id: 'dev-c-r1', stepId: 'dev-c-step-9', pointCode: 'P1', displacementMm: 2, stressMpa: 9, recordedAt: '2026-10-03 10:00', operator: '丙', ...rowMeta() },
    ] as never,
    acceptances: [],
  };
  await merge.stageImportPackage(orphan, 'c.json');
  const orphanPending = (await listPendingReadings()).filter((p) => p.deviceId === 'tablet-C');
  check('找不到桥梁的记录标记 unresolved 且不带 stepId', orphanPending[0]?.status === 'unresolved' && orphanPending[0].resolvedStepId === null);

  console.log('7) 检查点：暂存中途失败后可继续，且不重复建档');
  // 人为构造一个中断在暂存阶段的任务
  const { db: database } = await import('../src/app/core/utils/db');
  const hash = hashPacket(normalizePackage(packB));
  // 模拟已写入前 2 条暂存 + 检查点 staged=2 后崩溃
  const interruptedJob = {
    id: hash,
    packageHash: hash,
    fileName: 'b-retry.json',
    deviceId: 'tablet-B',
    state: 'failed' as const,
    phase: 'stage' as const,
    total: packB.readings.length,
    staged: 2,
    pendingIds: [],
    finalizeQueue: [],
    discardQueue: [],
    finalized: 0,
    lastError: '模拟写入中断',
    payload: normalizePackage(packB),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // 预置前 2 条暂存行（与 runStaging 生成的确定性 id 一致），用于验证续跑不重复
  const { pendingIdOf, buildLocalIndex, resolveReading } = await import('../src/app/core/utils/merge-packet');
  const allBridges = local.bridges;
  const allSteps = local.steps;
  const idx = buildLocalIndex({ bridges: allBridges, steps: allSteps });
  const pkt = normalizePackage(packB);
  const preRows = pkt.readings.slice(0, 2).map((reading, ordinal) => {
    const resolved = resolveReading(reading, pkt, idx);
    return {
      id: pendingIdOf(hash, ordinal),
      jobId: hash,
      packageHash: hash,
      resolvedStepId: resolved.resolvedStepId,
      bridgeName: resolved.bridgeName,
      stepSeq: resolved.stepSeq,
      pointCode: resolved.pointCode,
      status: (resolved.resolvedStepId ? 'ready' : 'unresolved') as 'ready',
      reason: resolved.reason,
      displacementMm: reading.displacementMm,
      stressMpa: reading.stressMpa,
      stressMissing: !!reading.stressMissing,
      recordedAt: reading.recordedAt,
      operator: reading.operator,
      sourceRecordId: reading.id,
      deviceId: pkt.deviceId,
      ordinal,
      createdAt: new Date().toISOString(),
    };
  });
  await database.pendingReadings.bulkPut(preRows);
  await database.importJobs.put(interruptedJob);
  check('可以检出失败任务用于重试', !!(await merge.findRecoverableJob()));
  const resumed = await merge.resumeImport(interruptedJob, pkt);
  check('恢复后任务状态 staged 且进度补满', resumed.state === 'staged' && resumed.staged === pkt.readings.length);
  const resumedPending = (await listPendingReadings()).filter((p) => p.jobId === hash);
  check('从检查点续跑只补齐剩余条数（不重复前 2 条）', resumedPending.length === pkt.readings.length,
    `got ${resumedPending.length}`);
  check('续跑后 ordinal 唯一且连续', new Set(resumedPending.map((p) => p.ordinal)).size === pkt.readings.length);

  // 清理：把这个任务标记 done 不影响后续
  await database.importJobs.delete(hash);
  await database.pendingReadings.where('jobId').equals(hash).delete();

  console.log('8) 整组丢弃必须报错（每测点至少留一条）');
  // 重新暂存 A 包用于校验（复用任务不写数据，所以用一个内容微变的新包）
  const packA2 = JSON.parse(JSON.stringify(packA)) as DatabaseSnapshot;
  packA2.name = 'tablet-A2';
  (packA2.readings[0] as { operator: string }).operator = '另一记录员';
  await merge.stageImportPackage(packA2, 'a2.json');
  const g2 = groupPending(await listPendingReadings()).filter((g) => g.deviceId === undefined || true);
  const a2Groups = groupPending((await listPendingReadings()).filter((p) => p.deviceId === 'tablet-A2'));
  let threw = false;
  try {
    await merge.confirmCandidates([], a2Groups.flatMap((g) => g.candidates.map((c) => c.id)));
  } catch {
    threw = true;
  }
  check('整组拒绝（无采纳）抛出错误', threw);
  void g2;
  void localStepCount;

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`);
  db.close();
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
