/**
 * 离线整库合并领域模型：
 * 两台平板各自导出的整库 JSON 回到本机后，读数先按
 * 「桥梁名称 + 步骤序号 + 测点编号」挂回原记录（不信任设备记录号），
 * 数值不一致的并列暂存，逐项确认后才进入正式 readings 表。
 */
import type { Reading } from './reading';

/** 暂存记录状态 */
export type PendingReadingStatus =
  | 'ready' // 同组数值一致，可直接确认
  | 'conflict' // 同组存在不同数值，需逐项确认
  | 'unresolved'; // 无法按桥梁 / 步骤 / 测点挂接

/** 导入任务状态（写入检查点随任务持久化，失败后可从检查点继续） */
export type ImportJobState = 'staging' | 'staged' | 'finalizing' | 'done' | 'failed';

/** 暂存读数：保留设备记录号与来源，仅按业务主键挂接 */
export interface PendingReading {
  /** 暂存行主键，由包摘要 + 包内序号确定性生成（重试同一包不会重复建档） */
  id: string;
  /** 所属导入任务（= 整包内容摘要） */
  jobId: string;
  packageHash: string;
  /** 挂接命中的本机步骤 id；未命中为 null（unresolved） */
  resolvedStepId: string | null;
  /** 业务主键三元组（挂接依据） */
  bridgeName: string;
  stepSeq: number;
  pointCode: string;
  status: PendingReadingStatus;
  /** 无法挂接原因 */
  reason?: string;
  displacementMm: number;
  /** 旧设备数据包可能没有应力字段：null 表示缺测，按兼容方式读入 */
  stressMpa: number | null;
  stressMissing: boolean;
  recordedAt: string;
  operator: string;
  /** 来源设备上的记录号（仅留痕，不作为合并依据） */
  sourceRecordId: string;
  /** 来源设备标识（导出库名 / 设备名，可空） */
  deviceId: string;
  /** 包内顺序号，保证按顺序暂存 */
  ordinal: number;
  createdAt: string;
}

/** 导入任务与检查点 */
export interface ImportJob {
  /** 任务 id = 整包内容摘要：同一份包永远只有一个任务 */
  id: string;
  packageHash: string;
  fileName: string;
  deviceId: string;
  state: ImportJobState;
  /** 当前所处阶段：暂存建档 / 正式读数确认写入 */
  phase: 'stage' | 'finalize';
  /** 总包内候选条数 */
  total: number;
  /** 已写入暂存表的条数（暂存阶段检查点） */
  staged: number;
  /** 已暂存行 id（顺序） */
  pendingIds: string[];
  /** 待确认为正式读数的候选 id（确认阶段检查点，逐个出队） */
  finalizeQueue: string[];
  /** 同组未被采纳、需要丢弃的暂存 id（随确认阶段一起清理） */
  discardQueue: string[];
  /** 已进入正式 readings 表的条数 */
  finalized: number;
  lastError: string;
  /** 失败时保留归一化后的包内容用于断点续传；成功暂存后清空 */
  payload?: NormalizedPackage;
  createdAt: string;
  updatedAt: string;
}

/** 归一化后的设备数据包（旧包缺应力字段也兼容） */
export interface NormalizedPackage {
  deviceId: string;
  bridges: Array<{ id: string; name: string }>;
  steps: Array<{ id: string; bridgeId: string; seq: number }>;
  readings: Reading[];
}

/** 暂存分组：同一桥梁 / 步骤序号 / 测点编号下的各路设备记录 */
export interface PendingGroup {
  key: string;
  bridgeName: string;
  stepSeq: number;
  pointCode: string;
  resolvedStepId: string | null;
  status: PendingReadingStatus;
  candidates: PendingReading[];
}

/** 业务主键分组键：桥梁名称 + 步骤序号 + 测点编号 */
export function pendingGroupKey(bridgeName: string, stepSeq: number, pointCode: string): string {
  return `${bridgeName}__${stepSeq}__${pointCode}`;
}

/** 数值签名：位移与应力都相同即视为同一观测值（应力缺测单独成签） */
export function valueSignature(displacementMm: number, stressMpa: number | null): string {
  return `${round2(displacementMm)}|${stressMpa === null ? 'na' : round2(stressMpa)}`;
}

function round2(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

/** 组内是否出现不同数值 */
export function groupHasConflict(candidates: PendingReading[]): boolean {
  const resolved = candidates.filter((item) => item.resolvedStepId !== null);
  return new Set(resolved.map((item) => valueSignature(item.displacementMm, item.stressMpa))).size > 1;
}

/** 按业务主键分组并排序（桥梁 → 步骤序号 → 测点编号 → 包内顺序） */
export function groupPending(rows: PendingReading[]): PendingGroup[] {
  const map = new Map<string, PendingGroup>();
  for (const row of [...rows].sort((a, b) => a.ordinal - b.ordinal)) {
    const key = pendingGroupKey(row.bridgeName, row.stepSeq, row.pointCode);
    const group = map.get(key);
    if (group) {
      group.candidates.push(row);
      if (row.status === 'unresolved') group.status = 'unresolved';
      else if (group.status !== 'unresolved' && groupHasConflict(group.candidates)) group.status = 'conflict';
      else if (group.status === 'ready' && groupHasConflict(group.candidates)) group.status = 'conflict';
    } else {
      map.set(key, {
        key,
        bridgeName: row.bridgeName,
        stepSeq: row.stepSeq,
        pointCode: row.pointCode,
        resolvedStepId: row.resolvedStepId,
        status: row.status,
        candidates: [row],
      });
    }
  }
  const groups = [...map.values()];
  for (const group of groups) {
    if (group.status === 'unresolved') continue;
    group.status = groupHasConflict(group.candidates) ? 'conflict' : 'ready';
    group.candidates.sort((a, b) => a.ordinal - b.ordinal);
  }
  return groups.sort(
    (a, b) =>
      a.bridgeName.localeCompare(b.bridgeName, 'zh-Hans-CN') ||
      a.stepSeq - b.stepSeq ||
      a.pointCode.localeCompare(b.pointCode, 'en'),
  );
}
