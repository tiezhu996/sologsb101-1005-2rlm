import type { Bridge } from '../types/bridge';
import type { Step } from '../types/step';
import type { Reading } from '../types/reading';
import { meanDisplacement, syncDeviationMm } from '../types/reading';
import { overallLevel, syncLevel } from './tolerance';

export interface BridgeMonitoringAlert {
  level: 'watch' | 'exceed';
  message: string;
}

export interface BridgeMonitoringSummary {
  bridgeId: string;
  bridgeName: string;
  stepCount: number;
  readingCount: number;
  /** 按步骤目标值累计的计划顶升量 */
  plannedLiftMm: number;
  /** 按各步最后一巡正式读数均值重算的实测累计顶升量 */
  observedLiftMm: number;
  /** 各步最后一巡中的最大同步偏差（正数，未知为 null） */
  syncDeviationMm: number | null;
  overLimitCount: number;
  alerts: BridgeMonitoringAlert[];
}

export interface OfficialStepView extends Step {
  bridgeName: string;
  plannedCumulativeMm: number;
  observedLiftMm: number | null;
  observedCumulativeMm: number | null;
  syncDeviationMm: number | null;
  readingCount: number;
  overLimit: boolean;
  alerts: BridgeMonitoringAlert[];
  validation: string;
}

/** 取某步骤最后一巡测点：同一 recordedAt 视为同一巡，未填时间时全部读数合并。 */
export function latestReadingRound(step: Step, readings: Reading[]): Reading[] {
  const rows = readings.filter((item) => item.stepId === step.id);
  if (rows.length === 0) return [];
  const stamped = rows.filter((item) => item.recordedAt);
  const source = stamped.length > 0 ? stamped : rows;
  const latestAt = source.map((item) => item.recordedAt).sort().at(-1) ?? '';
  return source.filter((item) => item.recordedAt === latestAt);
}

export function actualStepLiftMm(step: Step, readings: Reading[]): number | null {
  const round = latestReadingRound(step, readings);
  return round.length === 0 ? null : meanDisplacement(round);
}

/** 只使用正式读数构建步骤视图；按桥梁分别累计，避免多桥梁序号互相串计。 */
export function buildOfficialStepViews(bridges: Bridge[], steps: Step[], readings: Reading[]): OfficialStepView[] {
  const bridgeName = new Map(bridges.map((item) => [item.id, item.name]));
  const views: OfficialStepView[] = [];

  for (const bridge of bridges) {
    let plannedCumulative = 0;
    let observedCumulative = 0;
    const bridgeSteps = steps.filter((item) => item.bridgeId === bridge.id).sort((a, b) => a.seq - b.seq);
    for (const step of bridgeSteps) {
      plannedCumulative = Number((plannedCumulative + step.targetLiftMm).toFixed(3));
      const round = latestReadingRound(step, readings);
      const observed = round.length === 0 ? null : Number(meanDisplacement(round).toFixed(3));
      if (observed !== null) observedCumulative = Number((observedCumulative + observed).toFixed(3));
      const deviation = round.length === 0 ? null : Number(syncDeviationMm(round).toFixed(3));
      const alerts = buildStepAlerts(step, round, deviation, plannedCumulative, observed);
      views.push({
        ...step,
        bridgeName: bridge.name,
        plannedCumulativeMm: plannedCumulative,
        observedLiftMm: observed,
        observedCumulativeMm: observed === null ? null : observedCumulative,
        syncDeviationMm: deviation,
        readingCount: readings.filter((item) => item.stepId === step.id).length,
        overLimit: alerts.some((item) => item.level === 'exceed'),
        alerts,
        validation: alerts.length ? alerts.map((item) => item.message).join('；') : '顶升参数与正式监测数据均在控制范围内',
      });
    }
  }

  // 保留历史数据中步骤指向已删除桥梁时的可见性
  const knownBridgeIds = new Set(bridges.map((item) => item.id));
  for (const step of steps.filter((item) => !knownBridgeIds.has(item.bridgeId)).sort((a, b) => a.seq - b.seq)) {
    const round = latestReadingRound(step, readings);
    const deviation = round.length === 0 ? null : syncDeviationMm(round);
    views.push({
      ...step,
      bridgeName: bridgeName.get(step.bridgeId) ?? '未归属桥梁',
      plannedCumulativeMm: step.targetLiftMm,
      observedLiftMm: actualStepLiftMm(step, readings),
      observedCumulativeMm: actualStepLiftMm(step, readings),
      syncDeviationMm: deviation,
      readingCount: readings.filter((item) => item.stepId === step.id).length,
      overLimit: false,
      alerts: [],
      validation: '步骤未挂接到桥梁，请先核对桥梁数据',
    });
  }
  return views;
}

function buildStepAlerts(
  step: Step,
  round: Reading[],
  deviation: number | null,
  plannedCumulative: number,
  observed: number | null,
): BridgeMonitoringAlert[] {
  const alerts: BridgeMonitoringAlert[] = [];
  if (plannedCumulative > step.limitMm) {
    alerts.push({
      level: 'exceed',
      message: `计划累计顶升量 ${plannedCumulative} mm 超过限位 ${step.limitMm} mm`,
    });
  }
  if (deviation !== null) {
    const level = syncLevel(deviation);
    if (level !== 'ok') alerts.push({ level, message: `最后一巡同步偏差 ${deviation} mm` });
  }
  for (const reading of round) {
    const level = overallLevel(reading.displacementMm, step.limitMm, reading.stressMpa);
    if (level !== 'ok') {
      alerts.push({
        level,
        message: `${reading.pointCode} 位移 ${reading.displacementMm} mm / 应力 ${reading.stressMpa} MPa`,
      });
    }
  }
  if (observed !== null && observed > step.targetLiftMm + step.limitMm * 0.1) {
    alerts.push({
      level: 'watch',
      message: `实测顶升 ${observed} mm 明显高于本步目标 ${step.targetLiftMm} mm`,
    });
  }
  return alerts;
}

/** 正式读数确认后按桥梁重算累计顶升量、同步偏差和超限告警。 */
export function buildBridgeMonitoring(
  bridges: Bridge[],
  steps: Step[],
  readings: Reading[],
): BridgeMonitoringSummary[] {
  const stepViews = buildOfficialStepViews(bridges, steps, readings);
  return bridges.map((bridge) => {
    const bridgeSteps = stepViews.filter((item) => item.bridgeId === bridge.id);
    const stepIds = new Set(bridgeSteps.map((item) => item.id));
    const bridgeReadings = readings.filter((item) => stepIds.has(item.stepId));
    const observed = bridgeSteps.reduce((sum, item) => sum + (item.observedLiftMm ?? 0), 0);
    const deviation = bridgeSteps.reduce((max, item) => Math.max(max, item.syncDeviationMm ?? 0), 0);
    const alerts = bridgeSteps.flatMap((item) => item.alerts);
    return {
      bridgeId: bridge.id,
      bridgeName: bridge.name,
      stepCount: bridgeSteps.length,
      readingCount: bridgeReadings.length,
      plannedLiftMm: Number(bridgeSteps.reduce((sum, item) => sum + item.targetLiftMm, 0).toFixed(3)),
      observedLiftMm: Number(observed.toFixed(3)),
      syncDeviationMm: Number(deviation.toFixed(3)),
      overLimitCount: alerts.filter((item) => item.level === 'exceed').length,
      alerts,
    };
  });
}
