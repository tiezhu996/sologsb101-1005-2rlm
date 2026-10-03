/**
 * 离线合并驱动服务（Angular Injectable）：
 * - stageImportPackage：整包按顺序暂存；同包（内容摘要）重复导入复用任务，绝不重复建档；
 *   分批写入并把进度落到 importJobs 检查点，失败后可 resumeImport 从检查点继续。
 * - confirmCandidates：逐项确认的暂存读数才写入正式 readings；确定性 id 保证重试不重复。
 * - 正式读数落地后由调用方重算累计顶升量 / 同步偏差 / 超限告警与支座验收归档。
 */
import { Injectable } from '@angular/core';
import {
  deletePendingReadings,
  getImportJob,
  getPendingReadings,
  listBridges,
  listImportJobs,
  listSteps,
  putImportJob,
  putPendingReadings,
  putReadings,
  rowMeta,
  type ImportJobRow,
  type PendingReadingRow,
  type ReadingRow,
} from '../utils/db';
import type { DatabaseSnapshot } from '../utils/db';
import {
  buildLocalIndex,
  formalReadingIdOf,
  hashPacket,
  normalizePackage,
  pendingIdOf,
  resolveReading,
} from '../utils/merge-packet';
import { pendingGroupKey, type NormalizedPackage } from '../types/merge';

/** 单批写入条数：检查点粒度，失败重跑时最多重复一个批次（确定性 id 去重） */
const STAGE_BATCH = 30;
/** 确认入正式读数时单批条数 */
const FINALIZE_BATCH = 30;

export interface StageResult {
  job: ImportJobRow;
  /** 本次新暂存条数（重复包为 0） */
  staged: number;
  /** 是否复用了已有任务（同一包重复导入） */
  reused: boolean;
}

@Injectable({ providedIn: 'root' })
export class MergeService {
  /**
   * 暂存一个设备导出包。
   * 同一份包（按归一化内容摘要）已有任务时直接返回，不重复建档；
   * 写入失败时检查点已持久化，调用 resumeImport 即可继续。
   */
  async stageImportPackage(snapshot: DatabaseSnapshot, fileName: string): Promise<StageResult> {
    const packet = normalizePackage(snapshot);
    const jobId = hashPacket(packet);

    const existing = await getImportJob(jobId);
    if (existing) {
      // 已完成暂存的包：绝不重复建档；仍处于暂存中断态的则断点续传
      if (existing.phase === 'finalize' || ['staged', 'done'].includes(existing.state)) {
        return { job: existing, staged: 0, reused: true };
      }
      return this.runStaging(jobId, packet, fileName, existing);
    }
    return this.runStaging(jobId, packet, fileName);
  }

  /** 从检查点继续未完成的导入（暂存或确认阶段） */
  async resumeImport(job?: ImportJobRow, packet?: NormalizedPackage): Promise<ImportJobRow> {
    const current = job ?? (await this.findRecoverableJob());
    if (!current) throw new Error('没有可继续的导入任务');
    if (current.phase === 'finalize' || current.state === 'finalizing') {
      return this.runFinalize(current);
    }
    const payload = packet ?? current.payload;
    if (!payload) throw new Error('导入任务缺少检查点数据，请重新选择该设备包文件');
    const result = await this.runStaging(current.id, payload, current.fileName, current);
    return result.job;
  }

  /** 最近一个失败 / 中断的任务（供页面一键继续） */
  async findRecoverableJob(): Promise<ImportJobRow | undefined> {
    const jobs = await listImportJobs();
    return jobs.find((item) => item.state === 'failed' || item.state === 'staging');
  }

  /**
   * 确认采纳的暂存读数进入正式 readings；未采纳的同组候选一并丢弃。
   * 一次核对可能覆盖多个设备包，按候选自身 jobId 分别推进检查点。
   * 每个分组至少需要采纳一条；采用确定性正式 id，重试不会产生重复正式读数。
   */
  async confirmCandidates(
    acceptedPendingIds: string[],
    rejectedPendingIds: string[],
  ): Promise<{ jobs: ImportJobRow[]; finalized: number }> {
    const acceptedSet = new Set(acceptedPendingIds);
    const rejectedSet = new Set(rejectedPendingIds);
    for (const id of acceptedSet) rejectedSet.delete(id);

    const rows = await getPendingReadings([...acceptedSet, ...rejectedSet]);
    const byId = new Map(rows.map((row) => [row.id, row]));

    const accepted: PendingReadingRow[] = [];
    for (const id of acceptedSet) {
      const row = byId.get(id);
      if (row && row.resolvedStepId) accepted.push(row);
    }

    // 校验：同业务主键组不能整组丢弃，否则该测点无正式读数
    const acceptedGroups = new Set(
      accepted.map((row) => pendingGroupKey(row.bridgeName, row.stepSeq, row.pointCode)),
    );
    for (const row of rows) {
      if (!acceptedSet.has(row.id) && row.resolvedStepId) {
        const key = pendingGroupKey(row.bridgeName, row.stepSeq, row.pointCode);
        if (!acceptedGroups.has(key)) {
          throw new Error(`测点 ${row.bridgeName} 第${row.stepSeq}步 ${row.pointCode} 至少需保留一条读数`);
        }
      }
    }

    // 按设备包分组，每个包独立建立确认检查点并写入
    const byJob = new Map<string, { accepted: string[]; rejected: string[] }>();
    for (const row of rows) {
      const bucket = byJob.get(row.jobId) ?? { accepted: [], rejected: [] };
      if (acceptedSet.has(row.id)) bucket.accepted.push(row.id);
      else bucket.rejected.push(row.id);
      byJob.set(row.jobId, bucket);
    }

    let finalized = 0;
    const jobs: ImportJobRow[] = [];
    for (const [jobId, bucket] of byJob) {
      const job = await getImportJob(jobId);
      if (!job) continue;
      const acceptedRows = (await getPendingReadings(bucket.accepted)).filter((row) => row.resolvedStepId);
      const updated: ImportJobRow = {
        ...job,
        phase: 'finalize',
        state: 'finalizing',
        finalizeQueue: acceptedRows.map((row) => row.id),
        discardQueue: bucket.rejected,
        finalized: 0,
        payload: undefined,
        lastError: '',
        updatedAt: new Date().toISOString(),
      };
      await putImportJob(updated);
      const finished = await this.runFinalize(updated, acceptedRows);
      finalized += finished.finalized;
      jobs.push(finished);
    }
    return { jobs, finalized };
  }

  /** 丢弃整包暂存（无法挂接或放弃合并时使用） */
  async discardJob(jobId: string): Promise<void> {
    const job = await getImportJob(jobId);
    if (!job) return;
    const ids = [...job.pendingIds];
    if (ids.length) await deletePendingReadings(ids);
    await putImportJob({ ...job, state: 'done', phase: 'finalize', finalizeQueue: [], discardQueue: [], updatedAt: new Date().toISOString() });
  }

  /* ------------------------------ 内部 ------------------------------ */

  private async runStaging(
    jobId: string,
    packet: NormalizedPackage,
    fileName: string,
    existing?: ImportJobRow,
  ): Promise<StageResult> {
    const [bridges, steps] = await Promise.all([listBridges(), listSteps()]);
    const index = buildLocalIndex({ bridges, steps });
    const stamp = new Date().toISOString();

    // 已暂存部分（检查点续跑时跳过），用 Set 去重
    const startOrdinal = existing?.staged ?? 0;
    let job: ImportJobRow =
      existing ??
      ({
        id: jobId,
        packageHash: jobId,
        fileName,
        deviceId: packet.deviceId,
        state: 'staging',
        phase: 'stage',
        total: packet.readings.length,
        staged: 0,
        pendingIds: [],
        finalizeQueue: [],
        discardQueue: [],
        finalized: 0,
        lastError: '',
        payload: packet,
        createdAt: stamp,
        updatedAt: stamp,
      } satisfies ImportJobRow);

    let newlyStaged = 0;
    try {
      for (let i = startOrdinal; i < packet.readings.length; i += STAGE_BATCH) {
        const slice = packet.readings.slice(i, i + STAGE_BATCH);
        const rows: PendingReadingRow[] = slice.map((reading, offset) => {
          const ordinal = i + offset;
          const resolved = resolveReading(reading, packet, index);
          return {
            id: pendingIdOf(jobId, ordinal),
            jobId,
            packageHash: jobId,
            resolvedStepId: resolved.resolvedStepId,
            bridgeName: resolved.bridgeName,
            stepSeq: resolved.stepSeq,
            pointCode: resolved.pointCode,
            status: resolved.resolvedStepId ? 'ready' : 'unresolved',
            reason: resolved.reason,
            displacementMm: reading.displacementMm,
            stressMpa: reading.stressMpa,
            stressMissing: !!reading.stressMissing,
            recordedAt: reading.recordedAt,
            operator: reading.operator,
            sourceRecordId: reading.id,
            deviceId: packet.deviceId,
            ordinal,
            createdAt: stamp,
          };
        });
        await putPendingReadings(rows);
        const nextStaged = Math.min(i + slice.length, packet.readings.length);
        job = {
          ...job,
          staged: nextStaged,
          pendingIds: [...job.pendingIds, ...rows.map((row) => row.id)],
          updatedAt: new Date().toISOString(),
        };
        await putImportJob(job);
        newlyStaged += rows.length;
      }
      job = {
        ...job,
        state: 'staged',
        phase: 'stage',
        payload: undefined,
        lastError: '',
        updatedAt: new Date().toISOString(),
      };
      await putImportJob(job);
      return { job, staged: newlyStaged, reused: !!existing };
    } catch (error) {
      await this.markFailed(job, error);
      throw error;
    }
  }

  private async runFinalize(job: ImportJobRow, preloaded?: PendingReadingRow[]): Promise<ImportJobRow> {
    let current = job;
    try {
      // 检查点恢复：finalizeQueue 始终保存尚未写入正式表的候选 id
      const acceptedIds = [...job.finalizeQueue];
      const rowsById = new Map((preloaded ?? (await getPendingReadings(acceptedIds))).map((row) => [row.id, row]));

      for (let i = 0; i < acceptedIds.length; i += FINALIZE_BATCH) {
        const sliceIds = acceptedIds.slice(i, i + FINALIZE_BATCH);
        const formal: ReadingRow[] = [];
        for (const id of sliceIds) {
          const candidate = rowsById.get(id);
          if (!candidate || !candidate.resolvedStepId) continue;
          formal.push({
            id: formalReadingIdOf({
              stepId: candidate.resolvedStepId,
              pointCode: candidate.pointCode,
              displacementMm: candidate.displacementMm,
              stressMpa: candidate.stressMpa,
              recordedAt: candidate.recordedAt,
              operator: candidate.operator,
            }),
            stepId: candidate.resolvedStepId,
            pointCode: candidate.pointCode,
            displacementMm: candidate.displacementMm,
            stressMpa: candidate.stressMpa,
            stressMissing: candidate.stressMissing,
            recordedAt: candidate.recordedAt,
            operator: candidate.operator,
            ...rowMeta(),
          });
        }
        // bulkPut + 确定性 id：失败重试同批次不会重复正式读数
        await putReadings(formal);
        const writtenBefore = current.finalized;
        current = {
          ...current,
          finalized: writtenBefore + formal.length,
          finalizeQueue: acceptedIds.slice(i + FINALIZE_BATCH),
          updatedAt: new Date().toISOString(),
        };
        await putImportJob(current);
      }

      if (current.discardQueue.length) await deletePendingReadings(current.discardQueue);
      // 已采纳的暂存行完成历史使命，确认后清理
      await deletePendingReadings(acceptedIds);
      current = {
        ...current,
        state: 'done',
        phase: 'finalize',
        finalizeQueue: [],
        discardQueue: [],
        pendingIds: current.pendingIds.filter((id) => !acceptedIds.includes(id) && !job.discardQueue.includes(id)),
        lastError: '',
        updatedAt: new Date().toISOString(),
      };
      await putImportJob(current);
      return current;
    } catch (error) {
      await this.markFailed(current, error);
      throw error;
    }
  }

  private async markFailed(job: ImportJobRow, error: unknown): Promise<void> {
    await putImportJob({
      ...job,
      state: 'failed',
      lastError: error instanceof Error ? error.message : '写入失败',
      updatedAt: new Date().toISOString(),
    });
  }
}
