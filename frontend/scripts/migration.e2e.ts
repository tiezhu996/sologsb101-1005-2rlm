/**
 * IndexedDB 结构升级与兼容读取验证（fake-indexeddb）：
 * 1) v2 库（旧读数缺 stressMpa、无 pendingReadings / importJobs 表）打开后自动升级到 v3；
 * 2) 升级后旧读数 stressMpa 为 null + stressMissing，告警统计只按位移；
 * 3) 含缺应力字段的整库 JSON 走 importSnapshot 也能兼容读入。
 */
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import {
  db,
  listReadings,
  importSnapshot,
  countAll,
  DB_NAME,
  type DatabaseSnapshot,
} from '../src/app/core/utils/db';
import { overallLevel } from '../src/app/core/utils/tolerance';

let failures = 0;
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

async function main(): Promise<void> {
  // 1) 先按 v2 结构建库并写入一条缺应力字段的读数
  const legacy = new Dexie(DB_NAME);
  legacy.version(2).stores({
    bridges: 'id, name, bridgeType, builtYear, roadClass, archived',
    piers: 'id, bridgeId, code, capElevation, [bridgeId+code]',
    bearings: 'id, pierId, diseaseGrade, type, serial, [pierId+serial]',
    steps: 'id, bridgeId, seq, state, syncRequirement, [bridgeId+seq]',
    readings: 'id, stepId, pointCode, recordedAt, [stepId+pointCode]',
    acceptances: 'id, bearingId, stage, conclusion, [bearingId+stage]',
    settings: 'id',
  });
  await legacy.table('bridges').put({
    id: 'b1',
    name: '旧桥',
    spanCombo: '2×20m',
    bridgeType: 'beam',
    builtYear: 2001,
    roadClass: 'second',
    archived: false,
    revision: 2,
    createdAt: '2026-01-01',
  });
  await legacy.table('steps').put({
    id: 's1',
    bridgeId: 'b1',
    seq: 1,
    targetLiftMm: 3,
    syncRequirement: 'sync',
    limitMm: 10,
    leader: '甲',
    state: 'arrived',
    revision: 2,
    createdAt: '2026-01-01',
  });
  // 旧读数：完全没有 stressMpa 字段
  await legacy.table('readings').put({
    id: 'r-old',
    stepId: 's1',
    pointCode: 'P1',
    displacementMm: 11.5, // 超过限位 10mm
    recordedAt: '2026-10-03 09:00',
    operator: '旧设备',
    revision: 2,
    createdAt: '2026-10-01',
  });
  await legacy.close();

  // 2) 用当前 v3 代码打开，触发 upgrade
  await db.open();
  check('v3 新表存在：pendingReadings / importJobs', db.tables.some((t) => t.name === 'pendingReadings') && db.tables.some((t) => t.name === 'importJobs'));

  const readings = await listReadings();
  const old = readings.find((r) => r.id === 'r-old');
  check('旧读数应力字段兼容为 null', old?.stressMpa === null);
  check('旧读数标记 stressMissing', old?.stressMissing === true);
  // 位移 11.5 > 限位 10 → exceed；应力缺测不影响
  check('缺应力时综合告警仍按位移判定为超限', overallLevel(11.5, 10, old?.stressMpa) === 'exceed');
  // 位移正常 + 应力缺测 → ok（不会因 undefined 触发误报）
  check('位移正常 + 应力缺测 → 正常', overallLevel(3, 10, null) === 'ok');

  // 3) 整库导入含缺应力字段的备份
  const snapshot: DatabaseSnapshot = {
    name: 'gbbridgebear',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    bridges: [],
    piers: [],
    bearings: [],
    steps: [],
    readings: [
      {
        id: 'r-import-no-stress',
        stepId: 's1',
        pointCode: 'P9',
        displacementMm: 2.5,
        recordedAt: '2026-10-03 10:00',
        operator: '导入设备',
        revision: 1,
        createdAt: '2026-10-02',
      } as never,
      {
        id: 'r-import-with-stress',
        stepId: 's1',
        pointCode: 'P8',
        displacementMm: 2.4,
        stressMpa: '13.2' as never, // 字符串数值也兼容
        recordedAt: '2026-10-03 10:05',
        operator: '导入设备',
        revision: 1,
        createdAt: '2026-10-02',
      } as never,
    ],
    acceptances: [],
  };
  await importSnapshot(snapshot);
  const imported = await listReadings();
  const noStress = imported.find((r) => r.id === 'r-import-no-stress');
  const withStress = imported.find((r) => r.id === 'r-import-with-stress');
  check('整库导入缺应力读数按缺测读入', noStress?.stressMpa === null && noStress.stressMissing === true);
  check('字符串应力值兼容转数值', withStress?.stressMpa === 13.2 && !withStress.stressMissing);
  const counts = await countAll();
  check('countAll 包含新表计数', 'pendingReadings' in counts && 'importJobs' in counts);

  console.log(failures === 0 ? '\n迁移兼容验证全部通过 ✅' : `\n${failures} 项失败 ❌`);
  db.close();
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
