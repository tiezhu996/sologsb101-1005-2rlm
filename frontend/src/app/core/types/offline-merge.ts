import type { RowMeta } from './persistence';

/** 离线读数暂存状态 */
export type PendingReadingStatus = 'pending' | 'confirmed' | 'rejected';

/** 离线整库导入批次状态 */
export type OfflineImportStatus = 'running' | 'completed' | 'failed';

/** 跨平板导入的测点读数暂存行：先按桥梁名 + 步骤序号 + 测点编号挂接原记录 */
export interface PendingReading extends RowMeta {
  id: string;
  /** 离线合并批次 id */
  importJobId: string;
  /** 导入包内顺序，从 1 开始 */
  packageSeq: number;
  /** 包 id：同一文件重试时保持一致，用于幂等去重 */
  packageId: string;
  /** 源设备记录号，仅作追溯，不作为本机关联依据 */
  sourceRecordId: string;
  bridgeName: string;
  stepSeq: number;
  pointCode: string;
  /** 挂接后的本机步骤 id；缺少桥梁 / 步骤时为空 */
  stepId: string;
  displacementMm: number;
  /** 旧版平板包可能没有应力字段，读入时按 null 兼容 */
  stressMpa: number | null;
  recordedAt: string;
  operator: string;
  status: PendingReadingStatus;
  /** 已确认进入正式 readings 表后的记录 id */
  officialReadingId?: string;
  /** 并列候选分组键：桥梁名 + 步骤序号 + 测点编号；同一测点多次测量由正式读数 id 区分 */
  conflictKey: string;
  /** 同组是否存在不同数值 */
  hasConflict: boolean;
  /** 确认 / 驳回时间 */
  reviewedAt?: string;
  /** 处理备注，如缺少应力、未找到步骤等 */
  note?: string;
}

/** 离线导入批次 / 检查点 */
export interface OfflineImportJob extends RowMeta {
  id: string;
  packageId: string;
  fileName: string;
  status: OfflineImportStatus;
  totalCount: number;
  /** 已完成暂存的条数；失败重试从该检查点继续 */
  processedCount: number;
  pendingCount: number;
  confirmedCount: number;
  rejectedCount: number;
  conflictCount: number;
  lastError?: string;
  importedAt: string;
  updatedAt: string;
}

/** 暂存读数视图，补充本机桥梁 / 步骤上下文 */
export interface PendingReadingView extends PendingReading {
  bridgeId: string;
  localBridgeName: string;
  matched: boolean;
  /** 同组候选项，便于并列展示 */
  groupSize: number;
}

/** 离线导入结果 */
export interface OfflineImportResult {
  job: OfflineImportJob;
  resumed: boolean;
  insertedCount: number;
  skippedCount: number;
  conflictCount: number;
  unmatchedCount: number;
}

/** 生成桥名 / 步骤 / 测点使用的稳定分组键 */
export function pendingConflictKey(input: {
  bridgeName: string;
  stepSeq: number;
  pointCode: string;
  recordedAt?: string;
}): string {
  return [input.bridgeName.trim(), input.stepSeq, input.pointCode.trim().toUpperCase(), input.recordedAt ?? '']
    .join('::')
    .trim();
}
