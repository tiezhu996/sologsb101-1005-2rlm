import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { StepStateSlice } from './step.reducer';
import type { BridgeRow, ReadingRow, StepRow } from '../utils/db';
import { SYNC_REQUIREMENT_LABEL, syncLayoutHint, type StepView } from '../types/step';
import { meanDisplacement, syncDeviationMm } from '../types/reading';
import { latestReadingRound } from '../utils/monitoring';
import { syncLevel, type ToleranceLevel } from '../utils/tolerance';

export const selectStepState = createFeatureSelector<StepStateSlice>('step');
export const selectSteps = createSelector(selectStepState, (state) => state.steps);
export const selectReadings = createSelector(selectStepState, (state) => state.readings);
export const selectActiveStepBridgeId = createSelector(selectStepState, (state) => state.activeBridgeId);

/** 按桥梁分组 */
export const selectStepsByBridge = createSelector(selectSteps, (steps) => {
  const grouped = new Map<string, StepRow[]>();
  for (const step of steps) {
    const list = grouped.get(step.bridgeId) ?? [];
    list.push(step);
    grouped.set(step.bridgeId, list);
  }
  for (const list of grouped.values()) list.sort((a, b) => a.seq - b.seq);
  return grouped;
});

/** 找出受影响桥梁的步骤列表 */
export const selectActiveSteps = createSelector(
  selectSteps,
  selectActiveStepBridgeId,
  (steps, bridgeId) => steps.filter((item) => !bridgeId || item.bridgeId === bridgeId).sort((a, b) => a.seq - b.seq),
);

/** 步骤视图：按桥梁分别累计计划 / 实测顶升量，并用最后一巡正式读数计算同步偏差。 */
export function buildStepViews(steps: StepRow[], readings: ReadingRow[], bridges: BridgeRow[]): StepView[] {
  const bridgeName = new Map(bridges.map((item) => [item.id, item.name]));
  const views: StepView[] = [];

  for (const bridge of bridges) {
    let plannedCumulative = 0;
    let observedCumulative = 0;
    const bridgeSteps = steps.filter((item) => item.bridgeId === bridge.id).sort((a, b) => a.seq - b.seq);
    for (const step of bridgeSteps) {
      plannedCumulative = Number((plannedCumulative + step.targetLiftMm).toFixed(3));
      const round = latestReadingRound(step, readings);
      const observed = round.length ? Number(meanDisplacement(round).toFixed(3)) : null;
      if (observed !== null) observedCumulative = Number((observedCumulative + observed).toFixed(3));
      const deviation = round.length ? Number(syncDeviationMm(round).toFixed(3)) : null;
      const overLimit = plannedCumulative > step.limitMm;
      views.push({
        ...step,
        bridgeName: bridge.name,
        cumulativeLiftMm: plannedCumulative,
        observedLiftMm: observed,
        observedCumulativeMm: observed === null ? null : observedCumulative,
        overLimit,
        readingCount: readings.filter((item) => item.stepId === step.id).length,
        syncDeviationMm: deviation,
        validation: overLimit
          ? `累计顶升量 ${plannedCumulativeMmText(plannedCumulative)} 超过限位 ${step.limitMm} mm`
          : deviation !== null && syncLevel(deviation) === 'exceed'
            ? `最后一巡同步偏差 ${deviation.toFixed(2)} mm 超允许值`
            : '顶升参数与正式监测数据均在控制范围内',
      });
    }
  }

  for (const step of steps.filter((item) => !bridges.some((bridge) => bridge.id === item.bridgeId))) {
    const round = latestReadingRound(step, readings);
    views.push({
      ...step,
      bridgeName: bridgeName.get(step.bridgeId) ?? '未归属桥梁',
      cumulativeLiftMm: step.targetLiftMm,
      observedLiftMm: round.length ? meanDisplacement(round) : null,
      observedCumulativeMm: round.length ? meanDisplacement(round) : null,
      overLimit: false,
      readingCount: readings.filter((item) => item.stepId === step.id).length,
      syncDeviationMm: round.length ? syncDeviationMm(round) : null,
      validation: '步骤未挂接到桥梁，请先核对桥梁数据',
    });
  }

  return views;
}

function plannedCumulativeMmText(value: number): string {
  return value.toFixed(2);
}

/** 步骤统计：按桥梁分别累计，避免不同桥梁的步骤序号串计。 */
export const selectStepStats = createSelector(selectSteps, selectReadings, (steps, readings) => {
  const bridges = new Map<string, StepRow[]>();
  for (const step of steps) {
    const list = bridges.get(step.bridgeId) ?? [];
    list.push(step);
    bridges.set(step.bridgeId, list);
  }
  const cumulative = [...bridges.values()].reduce((sum, list) => {
    const planned = list.reduce((total, step) => total + step.targetLiftMm, 0);
    return sum + planned;
  }, 0);
  return {
    total: steps.length,
    cumulativeMm: Number(cumulative.toFixed(2)),
    arrived: steps.filter((item) => item.state === 'arrived').length,
    lifting: steps.filter((item) => item.state === 'lifting').length,
    idle: steps.filter((item) => item.state === 'idle').length,
    readingCount: readings.length,
    maxLimitMm: steps.reduce((max, item) => Math.max(max, item.limitMm), 0),
  };
});

/** 同步偏差等级（按步骤最后一巡正式读数） */
export const selectSyncLevels = createSelector(selectReadings, selectSteps, (readings, steps) => {
  const result: Record<string, ToleranceLevel> = {};
  for (const step of steps) {
    const round = latestReadingRound(step, readings);
    result[step.id] = syncLevel(round.length ? syncDeviationMm(round) : 0);
  }
  return result;
});

/** 步骤同步布置建议 */
export const selectSyncHints = createSelector(selectSteps, (steps) =>
  steps.map((step) => ({
    id: step.id,
    seq: step.seq,
    requirement: SYNC_REQUIREMENT_LABEL[step.syncRequirement],
    hint: syncLayoutHint(step.syncRequirement),
  })),
);

/** 各步骤最后一巡平均位移（测点页展示） */
export const selectStepAverages = createSelector(selectReadings, selectSteps, (readings, steps) => {
  const result: Record<string, number> = {};
  for (const step of steps) {
    result[step.id] = meanDisplacement(latestReadingRound(step, readings));
  }
  return result;
});
