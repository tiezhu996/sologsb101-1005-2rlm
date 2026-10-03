/**
 * 归档判定辅助：检查是否所有支座均已完成四步验收，返回可归档的桥梁摘要。
 * 正式读数确认后按最后一巡重算累计顶升量、同步偏差与超限告警。
 */
import { listAcceptances, listBearings, listBridges, listPiers, listReadings, listSteps } from '../utils/db';
import { ACCEPTANCE_STAGES } from '../types/acceptance';
import { archiveSummary } from '../types/acceptance';
import { buildBridgeMonitoring } from '../utils/monitoring';

export interface ArchiveCheckResult {
  /** 已满足归档条件的桥梁 id */
  archivableBridgeIds: string[];
  /** 摘要文案 */
  summaries: string[];
}

/** 检查全部桥梁的归档条件 */
export async function checkBridgeArchived(): Promise<ArchiveCheckResult> {
  const [bridges, piers, bearings, acceptances, steps, readings] = await Promise.all([
    listBridges(),
    listPiers(),
    listBearings(),
    listAcceptances(),
    listSteps(),
    listReadings(),
  ]);
  const monitoringById = new Map(buildBridgeMonitoring(bridges, steps, readings).map((item) => [item.bridgeId, item]));

  const archivableBridgeIds: string[] = [];
  const summaries: string[] = [];

  for (const bridge of bridges) {
    const pierIds = new Set(piers.filter((item) => item.bridgeId === bridge.id).map((item) => item.id));
    const ownedBearings = bearings.filter((item) => pierIds.has(item.pierId));
    if (ownedBearings.length === 0) continue;
    const fullyAccepted = ownedBearings.filter((bearing) => {
      const passed = new Set(
        acceptances
          .filter((item) => item.bearingId === bearing.id && item.conclusion === 'pass')
          .map((item) => item.stage),
      );
      const failed = acceptances.some((item) => item.bearingId === bearing.id && item.conclusion === 'fail');
      return !failed && ACCEPTANCE_STAGES.every((stage) => passed.has(stage));
    });
    if (fullyAccepted.length < ownedBearings.length) continue;

    const monitor = monitoringById.get(bridge.id);
    archivableBridgeIds.push(bridge.id);
    summaries.push(
      archiveSummary({
        bridgeName: bridge.name,
        bearingCount: ownedBearings.length,
        totalLiftMm: monitor?.observedLiftMm ?? 0,
        stepCount: monitor?.stepCount ?? 0,
        readingCount: monitor?.readingCount ?? 0,
        syncDeviationMm: monitor?.syncDeviationMm ?? 0,
        alertCount: monitor?.overLimitCount ?? 0,
      }),
    );
  }

  return { archivableBridgeIds, summaries };
}
