/**
 * 离线合并包处理（纯函数，便于重试与测试）：
 * - 归一化设备导出包：设备记录号不信任、应力字段缺失按兼容方式读入
 * - 按「桥梁名称 + 步骤序号 + 测点编号」把设备读数挂接回本机步骤
 * - 整包内容摘要（FNV-1a）：同一份包重复导入不会重复建档
 */
import type { DatabaseSnapshot } from './db';
import { ROW_REVISION } from './db';
import type { Reading } from '../types/reading';
import type { NormalizedPackage } from '../types/merge';

/** 任意记录转数值：非法值回退兜底 */
function toNumber(value: unknown, fallback = 0): number {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(3)) : fallback;
}

/** 应力字段兼容读取：旧设备数据包可能根本没有该字段 */
export function readStress(value: unknown): { stressMpa: number | null; stressMissing: boolean } {
  if (value === null || value === undefined || value === '') return { stressMpa: null, stressMissing: true };
  const num = Number(value);
  if (!Number.isFinite(num)) return { stressMpa: null, stressMissing: true };
  return { stressMpa: Number(num.toFixed(3)), stressMissing: false };
}

/**
 * 把设备导出的整库 JSON 归一化为合并包。
 * 注意：设备侧步骤 / 桥梁的 id 与本机可能完全不同，只保留名称与序号用于挂接。
 */
export function normalizePackage(raw: DatabaseSnapshot): NormalizedPackage {
  const bridgeRows = Array.isArray(raw?.bridges) ? raw.bridges : [];
  const stepRows = Array.isArray(raw?.steps) ? raw.steps : [];
  const readingRows = Array.isArray(raw?.readings) ? raw.readings : [];

  return {
    deviceId: typeof raw.name === 'string' && raw.name ? raw.name : 'unknown-device',
    bridges: bridgeRows
      .filter((item) => item && typeof item.name === 'string')
      .map((item) => ({ id: String(item.id), name: item.name.trim() })),
    steps: stepRows
      .filter((item) => item && item.bridgeId !== undefined)
      .map((item) => ({ id: String(item.id), bridgeId: String(item.bridgeId), seq: toNumber(item.seq, 1) })),
    readings: readingRows
      .filter((item) => item && typeof item.pointCode === 'string')
      .map((item) => {
        const { stressMpa, stressMissing } = readStress((item as Partial<Reading>).stressMpa);
        return {
          id: String(item.id),
          stepId: String(item.stepId),
          pointCode: String(item.pointCode).trim(),
          displacementMm: toNumber(item.displacementMm),
          stressMpa,
          stressMissing,
          recordedAt: typeof item.recordedAt === 'string' ? item.recordedAt : '',
          operator: typeof item.operator === 'string' ? item.operator : '',
          createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
          revision: typeof item.revision === 'number' ? item.revision : ROW_REVISION,
        };
      }),
  };
}

/** 本机侧桥梁 / 步骤解析上下文 */
export interface LocalIndex {
  /** 桥梁名称 → 桥梁 id */
  bridgeByName: Map<string, string>;
  /** 桥梁 id + 步骤序号 → 步骤 id */
  stepByBridgeSeq: Map<string, string>;
}

/** 桥梁 id + 步骤序号的组合键 */
export function bridgeStepKey(bridgeId: string, seq: number): string {
  return `${bridgeId}#${seq}`;
}

/** 由本机快照建立名称 / 序号索引（不依赖设备 id） */
export function buildLocalIndex(input: {
  bridges: Array<{ id: string; name: string }>;
  steps: Array<{ id: string; bridgeId: string; seq: number }>;
}): LocalIndex {
  const bridgeByName = new Map<string, string>();
  for (const bridge of input.bridges) {
    if (bridge.name) bridgeByName.set(bridge.name.trim(), bridge.id);
  }
  const stepByBridgeSeq = new Map<string, string>();
  for (const step of input.steps) {
    stepByBridgeSeq.set(bridgeStepKey(step.bridgeId, toNumber(step.seq, 1)), step.id);
  }
  return { bridgeByName, stepByBridgeSeq };
}

/** 挂接结果 */
export interface ResolvedReading {
  bridgeName: string;
  stepSeq: number;
  pointCode: string;
  resolvedStepId: string | null;
  reason?: string;
}

/** 按桥梁名称 + 步骤序号把一条设备读数挂回本机步骤 */
export function resolveReading(
  reading: Pick<Reading, 'stepId' | 'pointCode'>,
  packet: NormalizedPackage,
  index: LocalIndex,
): ResolvedReading {
  const deviceStep = packet.steps.find((item) => item.id === reading.stepId);
  if (!deviceStep) {
    return {
      bridgeName: '',
      stepSeq: 0,
      pointCode: reading.pointCode,
      resolvedStepId: null,
      reason: '设备包缺少对应步骤',
    };
  }
  const deviceBridge = packet.bridges.find((item) => item.id === deviceStep.bridgeId);
  const bridgeName = deviceBridge?.name ?? '';
  const localBridgeId = bridgeName ? index.bridgeByName.get(bridgeName) : undefined;
  if (!localBridgeId) {
    return {
      bridgeName,
      stepSeq: deviceStep.seq,
      pointCode: reading.pointCode,
      resolvedStepId: null,
      reason: `本机不存在桥梁「${bridgeName || '未知'}」`,
    };
  }
  const localStepId = index.stepByBridgeSeq.get(bridgeStepKey(localBridgeId, deviceStep.seq));
  if (!localStepId) {
    return {
      bridgeName,
      stepSeq: deviceStep.seq,
      pointCode: reading.pointCode,
      resolvedStepId: null,
      reason: `桥梁「${bridgeName}」缺少第 ${deviceStep.seq} 步`,
    };
  }
  return {
    bridgeName,
    stepSeq: deviceStep.seq,
    pointCode: reading.pointCode,
    resolvedStepId: localStepId,
  };
}

/** FNV-1a 32 位摘要：对整包归一化后的稳定 JSON 求哈希，用作幂等导入键 */
export function hashPacket(packet: NormalizedPackage): string {
  const stable = {
    deviceId: packet.deviceId,
    bridges: packet.bridges,
    steps: packet.steps,
    readings: packet.readings.map((item) => [
      item.id,
      item.stepId,
      item.pointCode,
      item.displacementMm,
      item.stressMpa,
      item.recordedAt,
      item.operator,
    ]),
  };
  const text = JSON.stringify(stable);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `pkg-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/** 暂存行确定性 id：同包同序号重试得到同一 id，bulkPut 天然去重 */
export function pendingIdOf(jobId: string, ordinal: number): string {
  return `${jobId}-r${String(ordinal).padStart(5, '0')}`;
}

/**
 * 正式读数确定性 id：同一挂接步骤 + 测点 + 数值 + 记录时间 + 记录人
 * 只产生一条正式读数，重复确认 / 重试不会重复建档；
 * 数值不同的并列记录因签名不同而各自保留。
 */
export function formalReadingIdOf(input: {
  stepId: string;
  pointCode: string;
  displacementMm: number;
  stressMpa: number | null;
  recordedAt: string;
  operator: string;
}): string {
  const sig = [
    input.stepId,
    input.pointCode,
    (Math.round(input.displacementMm * 100) / 100).toFixed(2),
    input.stressMpa === null ? 'na' : (Math.round(input.stressMpa * 100) / 100).toFixed(2),
    input.recordedAt || '',
    input.operator || '',
  ].join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < sig.length; i += 1) {
    hash ^= sig.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `read-merge-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
