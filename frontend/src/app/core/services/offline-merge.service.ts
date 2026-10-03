import { Injectable } from '@angular/core';
import {
  db,
  getOfflineImportJob,
  hasStressField,
  listBearings,
  listBridges,
  listPendingReadings,
  listPiers,
  listReadings,
  listSteps,
  newId,
  normalizeReadingRow,
  putAcceptance,
  putBearing,
  putBridge,
  putOfflineImportJob,
  putPendingReadings,
  putPier,
  putReading,
  putStep,
  rowMeta,
  type DatabaseSnapshot,
  type LegacyReadingRow,
  type OfflineImportJobRow,
  type AcceptanceRow,
  type PendingReadingRow,
} from '../utils/db';
import type { Acceptance } from '../types/acceptance';
import type { Bearing } from '../types/bearing';
import type { Bridge } from '../types/bridge';
import type { Pier } from '../types/pier';
import type { Step } from '../types/step';
import { ACCEPTANCE_STAGES } from '../types/acceptance';
import {
  pendingConflictKey,
  type OfflineImportResult,
  type PendingReadingStatus,
  type PendingReadingView,
} from '../types/offline-merge';
import { buildBridgeMonitoring, type BridgeMonitoringSummary } from '../utils/monitoring';

const CHUNK_SIZE = 100;

interface SourceStepRef {
  localId: string;
  bridgeId: string;
  bridgeName: string;
  seq: number;
}

interface EntityMaps {
  bridgeById: Map<string, string>;
  pierById: Map<string, string>;
  bearingById: Map<string, string>;
  stepById: Map<string, string>;
  bridgeByName: Map<string, Bridge>;
  sourceStepById: Map<string, SourceStepRef>;
  localStepByNaturalKey: Map<string, string>;
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, '0');
}

function canonicalId(prefix: string, ...parts: Array<string | number | undefined>): string {
  return `${prefix}-canon-${stableHash(parts.map((part) => String(part ?? '').trim()).join('::'))}`;
}

function packageIdFor(snapshot: DatabaseSnapshot, fileName: string): string {
  if (typeof snapshot.name === 'string' && snapshot.name.startsWith('package:')) return snapshot.name;
  // 使用原始包内容计算，不能先 normalize（旧包缺少应力字段也必须得到同一 packageId，保证失败重试幂等）
  const sample = JSON.stringify(snapshot.readings ?? []).slice(0, 5000);
  return `package:${stableHash([fileName, snapshot.exportedAt ?? '', snapshot.schemaVersion ?? '', sample].join('::'))}`;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function stamp(): string {
  return new Date().toISOString();
}

/**
 * 离线整库合并服务。
 * 读数不直接信任平板记录号，而按桥梁名称 + 步骤序号 + 测点编号挂接；
 * 写入按检查点分批执行，同一个 packageId 可安全重试且不会重复建档。
 */
@Injectable({ providedIn: 'root' })
export class OfflineMergeService {
  async mergeSnapshot(snapshot: DatabaseSnapshot, fileName: string): Promise<OfflineImportResult> {
    const packageId = packageIdFor(snapshot, fileName);
    const existingJob = await getOfflineImportJob(packageId);
    const existingRows = await db.pendingReadings.where('packageId').equals(packageId).toArray();
    const sourceReadings = (snapshot.readings ?? []).map((row) => normalizeReadingRow(row) as LegacyReadingRow);

    if (existingJob?.status === 'completed' && existingJob.totalCount === sourceReadings.length) {
      return {
        job: existingJob,
        resumed: false,
        insertedCount: 0,
        skippedCount: existingRows.length,
        conflictCount: existingRows.filter((row) => row.hasConflict).length,
        unmatchedCount: existingRows.filter((row) => !row.stepId).length,
      };
    }

    const maps = await this.upsertReferenceEntities(snapshot);
    const now = stamp();
    const job: OfflineImportJobRow =
      existingJob ??
      ({
        id: newId('offline-import'),
        packageId,
        fileName,
        status: 'running',
        totalCount: sourceReadings.length,
        processedCount: 0,
        pendingCount: 0,
        confirmedCount: 0,
        rejectedCount: 0,
        conflictCount: 0,
        importedAt: now,
        updatedAt: now,
        ...rowMeta(),
      } satisfies OfflineImportJobRow);

    const rows = sourceReadings.map((source, index) =>
      this.buildPendingRow(source, index, maps, packageId, job.id),
    );
    this.markConflicts([...existingRows, ...rows]);
    await putOfflineImportJob(job);

    try {
      const start = job.processedCount;
      let insertedCount = 0;
      for (let offset = start; offset < rows.length; offset += CHUNK_SIZE) {
        const chunk = rows.slice(offset, offset + CHUNK_SIZE);
        await db.transaction('rw', [db.offlineImports, db.pendingReadings], async () => {
          await putPendingReadings(chunk);
          job.processedCount = Math.min(offset + chunk.length, rows.length);
          job.status = 'running';
          job.updatedAt = stamp();
          job.lastError = undefined;
          await putOfflineImportJob(job);
        });
        insertedCount += chunk.length;
      }

      const finalRows = await db.pendingReadings.where('packageId').equals(packageId).toArray();
      this.markConflicts(finalRows);
      await putPendingReadings(finalRows);
      job.status = 'completed';
      job.totalCount = rows.length;
      job.pendingCount = finalRows.filter((row) => row.status === 'pending').length;
      job.confirmedCount = finalRows.filter((row) => row.status === 'confirmed').length;
      job.rejectedCount = finalRows.filter((row) => row.status === 'rejected').length;
      job.conflictCount = finalRows.filter((row) => row.hasConflict).length;
      job.updatedAt = stamp();
      await putOfflineImportJob(job);

      return {
        job,
        resumed: start > 0,
        insertedCount,
        skippedCount: existingRows.length,
        conflictCount: job.conflictCount,
        unmatchedCount: finalRows.filter((row) => !row.stepId).length,
      };
    } catch (error) {
      job.status = 'failed';
      job.lastError = error instanceof Error ? error.message : '离线包写入失败';
      job.updatedAt = stamp();
      await putOfflineImportJob(job);
      throw error;
    }
  }

  async listPendingViews(): Promise<PendingReadingView[]> {
    const [rows, bridges, steps] = await Promise.all([listPendingReadings(), listBridges(), listSteps()]);
    const bridgeById = new Map(bridges.map((item) => [item.id, item]));
    const stepById = new Map(steps.map((item) => [item.id, item]));
    const groupSize = new Map<string, number>();
    for (const row of rows) groupSize.set(row.conflictKey, (groupSize.get(row.conflictKey) ?? 0) + 1);

    return rows
      .map((row) => {
        const step = stepById.get(row.stepId);
        const bridge = step ? bridgeById.get(step.bridgeId) : undefined;
        return {
          ...row,
          bridgeId: bridge?.id ?? '',
          localBridgeName: bridge?.name ?? '',
          matched: Boolean(step),
          groupSize: groupSize.get(row.conflictKey) ?? 1,
        };
      })
      .sort((a, b) =>
        a.bridgeName === b.bridgeName
          ? a.stepSeq === b.stepSeq
            ? a.pointCode.localeCompare(b.pointCode) || a.packageSeq - b.packageSeq
            : a.stepSeq - b.stepSeq
          : a.bridgeName.localeCompare(b.bridgeName),
      );
  }

  /** 确认一个暂存候选进入正式读数；其它候选仍并列保留，必须逐项确认或驳回。 */
  async confirmPending(pendingId: string): Promise<{ monitoring: BridgeMonitoringSummary[] }> {
    const pending = await db.pendingReadings.get(pendingId);
    if (!pending) throw new Error('待确认读数不存在');
    if (!pending.stepId) throw new Error('尚未挂接到本机顶升步骤，不能确认');

    if (pending.status === 'confirmed' && pending.officialReadingId) {
      return this.recalculateAfterConfirmation();
    }

    const officialId =
      pending.officialReadingId ??
      canonicalId('read', pending.bridgeName, pending.stepSeq, pending.pointCode, pending.recordedAt);
    const now = stamp();
    const official = {
      id: officialId,
      stepId: pending.stepId,
      pointCode: pending.pointCode,
      displacementMm: pending.displacementMm,
      stressMpa: pending.stressMpa ?? 0,
      recordedAt: pending.recordedAt,
      operator: pending.operator,
      createdAt: now,
      revision: rowMeta().revision,
    };

    await db.transaction('rw', [db.pendingReadings, db.readings, db.offlineImports], async () => {
      await putReading(official);
      await db.pendingReadings.put({ ...pending, status: 'confirmed', officialReadingId: officialId, reviewedAt: now });
      await this.syncJobCounters(pending.importJobId);
    });

    await this.refreshPendingConflictFlags();
    return this.recalculateAfterConfirmation();
  }

  async rejectPending(pendingId: string, reason = '现场复核后驳回'): Promise<{ monitoring: BridgeMonitoringSummary[] }> {
    const pending = await db.pendingReadings.get(pendingId);
    if (!pending) throw new Error('待确认读数不存在');
    const now = stamp();
    await db.transaction('rw', [db.pendingReadings, db.offlineImports], async () => {
      await db.pendingReadings.put({ ...pending, status: 'rejected', reviewedAt: now, note: reason });
      await this.syncJobCounters(pending.importJobId);
    });
    return this.recalculateAfterConfirmation();
  }

  async monitoring(): Promise<BridgeMonitoringSummary[]> {
    const [bridges, steps, readings] = await Promise.all([listBridges(), listSteps(), listReadings()]);
    return buildBridgeMonitoring(bridges, steps, readings);
  }

  private async upsertReferenceEntities(snapshot: DatabaseSnapshot): Promise<EntityMaps> {
    const [localBridges, localPiers, localBearings, localSteps] = await Promise.all([
      listBridges(),
      listPiers(),
      listBearings(),
      listSteps(),
    ]);
    const now = stamp();

    const bridgeById = new Map<string, string>();
    const bridgeByName = new Map<string, Bridge>();
    for (const local of localBridges) {
      bridgeById.set(local.id, local.id);
      bridgeByName.set(local.name.trim(), local);
    }
    const incomingBridges = (snapshot.bridges ?? []).map((row, index) => {
      const localByName = bridgeByName.get(row.name.trim());
      const id = localByName?.id ?? canonicalId('bridge', row.name);
      bridgeById.set(row.id, id);
      const bridge: Bridge =
        localByName ??
        ({
          id,
          name: asString(row.name, `离线桥梁-${index + 1}`),
          spanCombo: asString(row.spanCombo),
          bridgeType: row.bridgeType ?? 'beam',
          builtYear: asNumber(row.builtYear, new Date().getFullYear()),
          roadClass: row.roadClass ?? 'third',
          archived: Boolean(row.archived),
          createdAt: asString(row.createdAt, now),
          revision: row.revision ?? rowMeta().revision,
        } satisfies Bridge);
      bridgeByName.set(bridge.name.trim(), bridge);
      return bridge;
    });

    const pierById = new Map<string, string>(localPiers.map((item) => [item.id, item.id]));
    const incomingPiers = (snapshot.piers ?? []).map((row, index) => {
      const bridgeId = bridgeById.get(row.bridgeId) ?? '';
      const local =
        localPiers.find((item) => item.id === pierById.get(row.id)) ??
        localPiers.find((item) => item.bridgeId === bridgeId && item.code === row.code);
      const id = local?.id ?? canonicalId('pier', bridgeId, row.code);
      pierById.set(row.id, id);
      return {
        id,
        bridgeId,
        code: asString(row.code, `P${index + 1}`),
        capElevation: asNumber(row.capElevation),
        type: row.type ?? 'pier',
        bearingCount: asNumber(row.bearingCount),
        createdAt: asString(row.createdAt, now),
        revision: row.revision ?? rowMeta().revision,
      } satisfies Pier;
    });

    const bearingById = new Map<string, string>(localBearings.map((item) => [item.id, item.id]));
    const incomingBearings = (snapshot.bearings ?? []).map((row, index) => {
      const pierId = pierById.get(row.pierId) ?? '';
      const local =
        localBearings.find((item) => item.id === bearingById.get(row.id)) ??
        localBearings.find((item) => item.pierId === pierId && item.serial === row.serial);
      const id = local?.id ?? canonicalId('bearing', pierId, row.serial);
      bearingById.set(row.id, id);
      return {
        id,
        pierId,
        serial: asString(row.serial, String(index + 1)),
        type: row.type ?? 'plate',
        spec: asString(row.spec),
        diseaseGrade: row.diseaseGrade ?? 'intact',
        diseaseNote: asString(row.diseaseNote),
        createdAt: asString(row.createdAt, now),
        revision: row.revision ?? rowMeta().revision,
      } satisfies Bearing;
    });

    const stepById = new Map<string, string>(localSteps.map((item) => [item.id, item.id]));
    const sourceStepById = new Map<string, SourceStepRef>();
    const localStepByNaturalKey = new Map<string, string>();
    for (const step of localSteps) {
      const stepBridge = localBridges.find((item) => item.id === step.bridgeId);
      if (stepBridge) localStepByNaturalKey.set(`${stepBridge.name.trim()}::${step.seq}`, step.id);
    }
    const incomingSteps = (snapshot.steps ?? []).map((row, index) => {
      const bridgeId = bridgeById.get(row.bridgeId) ?? '';
      const local =
        localSteps.find((item) => item.id === stepById.get(row.id)) ??
        localSteps.find((item) => item.bridgeId === bridgeId && item.seq === row.seq);
      const id = local?.id ?? canonicalId('step', bridgeId, row.seq);
      stepById.set(row.id, id);
      const bridgeName =
        incomingBridges.find((item) => item.id === bridgeId)?.name.trim() ??
        localBridges.find((item) => item.id === bridgeId)?.name.trim() ??
        '';
      localStepByNaturalKey.set(`${bridgeName}::${row.seq}`, id);
      sourceStepById.set(row.id, {
        localId: id,
        bridgeId,
        bridgeName,
        seq: asNumber(row.seq, index + 1),
      });
      return {
        id,
        bridgeId,
        seq: asNumber(row.seq, index + 1),
        targetLiftMm: asNumber(row.targetLiftMm),
        syncRequirement: row.syncRequirement ?? 'sync',
        limitMm: asNumber(row.limitMm),
        leader: asString(row.leader),
        state: row.state ?? 'idle',
        createdAt: asString(row.createdAt, now),
        revision: row.revision ?? rowMeta().revision,
      } satisfies Step;
    });

    await db.transaction('rw', [db.bridges, db.piers, db.bearings, db.steps], async () => {
      await Promise.all(incomingBridges.map((row) => putBridge(row)));
      await Promise.all(incomingPiers.map((row) => putPier(row)));
      await Promise.all(incomingBearings.map((row) => putBearing(row)));
      await Promise.all(incomingSteps.map((row) => putStep(row)));
    });
    await this.upsertAcceptances(snapshot, bearingById, now);

    return { bridgeById, pierById, bearingById, stepById, bridgeByName, sourceStepById, localStepByNaturalKey };
  }

  private async upsertAcceptances(snapshot: DatabaseSnapshot, bearingById: Map<string, string>, now: string): Promise<void> {
    const incoming = (snapshot.acceptances ?? []).map((row) => {
      const bearingId = bearingById.get(row.bearingId) ?? row.bearingId;
      const id = ACCEPTANCE_STAGES.includes(row.stage)
        ? canonicalId('acc', bearingId, row.stage)
        : newId('acc');
      return {
        ...row,
        id,
        bearingId,
        acceptor: asString(row.acceptor),
        acceptedAt: asString(row.acceptedAt),
        createdAt: asString(row.createdAt, now),
        revision: row.revision ?? rowMeta().revision,
      } satisfies Acceptance;
    });
    await Promise.all(incoming.map((row) => putAcceptance(row)));
  }

  private buildPendingRow(
    source: LegacyReadingRow,
    index: number,
    maps: EntityMaps,
    packageId: string,
    jobId: string,
  ): PendingReadingRow {
    const explicitBridgeName = asString((source as { bridgeName?: string }).bridgeName);
    const explicitSeq = asNumber((source as { stepSeq?: number }).stepSeq);
    const refFromDeviceId =
      explicitBridgeName || explicitSeq ? undefined : maps.sourceStepById.get(source.stepId);
    const bridgeName = refFromDeviceId?.bridgeName || explicitBridgeName || '未匹配桥梁';
    const stepSeq = refFromDeviceId?.seq || explicitSeq;
    const stepId = this.findStepByNaturalKey(bridgeName, stepSeq, maps) ?? refFromDeviceId?.localId ?? '';
    const stressKnown = hasStressField(source);
    return {
      id: canonicalId('pending', packageId, source.id, index),
      importJobId: jobId,
      packageSeq: index + 1,
      packageId,
      sourceRecordId: asString(source.id, `device-${index + 1}`),
      bridgeName,
      stepSeq,
      pointCode: asString(source.pointCode, `P${index + 1}`),
      stepId,
      displacementMm: asNumber(source.displacementMm),
      stressMpa: stressKnown ? asNumber(source.stressMpa ?? 0) : null,
      recordedAt: asString(source.recordedAt),
      operator: asString(source.operator),
      status: 'pending',
      conflictKey: pendingConflictKey({
        bridgeName,
        stepSeq,
        pointCode: asString(source.pointCode),
        recordedAt: asString(source.recordedAt),
      }),
      hasConflict: false,
      createdAt: asString(source.createdAt, stamp()),
      revision: rowMeta().revision,
      note: stressKnown ? undefined : '旧版数据缺少应力字段，已按兼容方式读入，确认时按 0 MPa 入正式读数',
    };
  }

  private findStepByNaturalKey(bridgeName: string, seq: number, maps: EntityMaps): string {
    if (!bridgeName || !seq) return '';
    return maps.localStepByNaturalKey.get(`${bridgeName.trim()}::${seq}`) ?? '';
  }

  private markConflicts(rows: PendingReadingRow[]): void {
    const groups = new Map<string, PendingReadingRow[]>();
    for (const row of rows) {
      const list = groups.get(row.conflictKey) ?? [];
      list.push(row);
      groups.set(row.conflictKey, list);
    }
    for (const group of groups.values()) {
      const values = new Set(group.map((row) => `${row.displacementMm}|${row.stressMpa ?? ''}`));
      group.forEach((row) => {
        row.hasConflict = values.size > 1;
      });
    }
  }

  private async refreshPendingConflictFlags(): Promise<void> {
    const rows = await listPendingReadings();
    this.markConflicts(rows);
    await putPendingReadings(rows);
  }

  private async syncJobCounters(jobId: string): Promise<void> {
    const job = await db.offlineImports.get(jobId);
    if (!job) return;
    const rows = await db.pendingReadings.where('importJobId').equals(jobId).toArray();
    job.pendingCount = rows.filter((row) => row.status === 'pending').length;
    job.confirmedCount = rows.filter((row) => row.status === 'confirmed').length;
    job.rejectedCount = rows.filter((row) => row.status === 'rejected').length;
    job.conflictCount = rows.filter((row) => row.hasConflict).length;
    job.updatedAt = stamp();
    await putOfflineImportJob(job);
  }

  private async recalculateAfterConfirmation(): Promise<{ monitoring: BridgeMonitoringSummary[] }> {
    const [bridges, steps, readings] = await Promise.all([listBridges(), listSteps(), listReadings()]);
    const monitoring = buildBridgeMonitoring(bridges, steps, readings);
    await this.syncAcceptanceArchive(bridges);
    return { monitoring };
  }

  private async syncAcceptanceArchive(bridges: Bridge[]): Promise<void> {
    const [piers, bearings, acceptances] = await Promise.all([listPiers(), listBearings(), db.acceptances.toArray()]);
    const updates: Bridge[] = [];
    for (const bridge of bridges) {
      const ownedBearings = bearings.filter((bearing) => {
        const pier = piers.find((item) => item.id === bearing.pierId);
        return pier?.bridgeId === bridge.id;
      });
      const allPassed =
        ownedBearings.length > 0 &&
        this.allBearingsAccepted(ownedBearings.map((item) => item.id), acceptances);
      if (allPassed && !bridge.archived) updates.push({ ...bridge, archived: true });
      if (!allPassed && bridge.archived) updates.push({ ...bridge, archived: false });
    }
    await Promise.all(updates.map((row) => putBridge(row)));
  }

  private allBearingsAccepted(bearingIds: string[], acceptances: AcceptanceRow[]): boolean {
    return bearingIds.every((bearingId) => {
      const passed = new Set(
        acceptances
          .filter((item) => item.bearingId === bearingId && item.conclusion === 'pass')
          .map((item) => item.stage),
      );
      const failed = acceptances.some((item) => item.bearingId === bearingId && item.conclusion === 'fail');
      return !failed && ACCEPTANCE_STAGES.every((stage) => passed.has(stage));
    });
  }
}
