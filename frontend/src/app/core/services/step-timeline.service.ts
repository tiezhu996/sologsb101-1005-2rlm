/**
 * 顶升步骤时间线服务（Angular 以 Injectable 实现 useStepTimeline 语义）
 * 提供顶升步骤时间线、累计顶升量与同步偏差的 RxJS 派生流，
 * 被顶升步骤页、测点读数页消费。
 */
import { Injectable, inject } from '@angular/core';
import { Observable, map, shareReplay } from 'rxjs';
import { IdbTableService } from './idb-table.service';
import { listBearings, listBridges, listReadings, listSteps } from '../utils/db';
import type { BridgeRow, BearingRow, ReadingRow, StepRow } from '../utils/db';
import { SYNC_REQUIREMENT_LABEL } from '../types/step';
import type { ReadingView } from '../types/reading';
import { meanDisplacement } from '../types/reading';
import { buildOfficialStepViews, latestReadingRound, type OfficialStepView } from '../utils/monitoring';
import { overallLevel, type ToleranceLevel } from '../utils/tolerance';

/** 步骤时间线的一级节点 */
export interface StepTimelineNode {
  step: OfficialStepView;
  /** 该步骤最后一巡正式读数（含偏差） */
  readings: ReadingView[];
  /** 同步偏差等级 */
  deviationLevel: ToleranceLevel;
  /** 综合限位等级 */
  limitLevel: ToleranceLevel;
}

/** 时间线汇总 */
export interface StepTimelineSnapshot {
  steps: StepRow[];
  readings: ReadingRow[];
  bearings: BearingRow[];
  bridges: BridgeRow[];
}

@Injectable({ providedIn: 'root' })
export class StepTimelineService {
  private readonly idb = inject(IdbTableService);

  /** 原始快照流 */
  readonly snapshot$: Observable<StepTimelineSnapshot> = this.idb
    .watch<StepTimelineSnapshot>(
      async () => {
        const [steps, readings, bearings, bridges] = await Promise.all([
          listSteps(),
          listReadings(),
          listBearings(),
          listBridges(),
        ]);
        return { steps, readings, bearings, bridges };
      },
      { steps: [], readings: [], bearings: [], bridges: [] },
    )
    .pipe(shareReplay({ bufferSize: 1, refCount: true }));

  /** 步骤视图流：含按桥重算的累计顶升量、最后一巡同步偏差与校验结论 */
  readonly stepViews$ = this.snapshot$.pipe(
    map((snapshot) => buildOfficialStepViews(snapshot.bridges, snapshot.steps, snapshot.readings)),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 时间线节点流：步骤 + 最后一巡正式读数 + 等级判定 */
  readonly timeline$: Observable<StepTimelineNode[]> = this.snapshot$.pipe(
    map((snapshot) => {
      const stepViews = buildOfficialStepViews(snapshot.bridges, snapshot.steps, snapshot.readings);
      const bridges = new Map(snapshot.bridges.map((item) => [item.id, item.name]));
      return stepViews.map((step) => {
        const round = latestReadingRound(step, snapshot.readings);
        const average = meanDisplacement(round);
        const stepReadings = round.map<ReadingView>((reading) => ({
          ...reading,
          stepSeq: step.seq,
          bridgeId: step.bridgeId,
          bridgeName: bridges.get(step.bridgeId) ?? step.bridgeName,
          syncRequirement: SYNC_REQUIREMENT_LABEL[step.syncRequirement],
          deviationMm: Number((reading.displacementMm - average).toFixed(3)),
          overLimit: Math.abs(reading.displacementMm) >= step.limitMm,
          stressAlert: reading.stressMpa >= 12,
        }));
        const deviationLevel: ToleranceLevel =
          step.syncDeviationMm === null ? 'ok' : step.syncDeviationMm >= 1.5 ? 'exceed' : step.syncDeviationMm >= 0.8 ? 'watch' : 'ok';
        return {
          step,
          readings: stepReadings,
          deviationLevel,
          limitLevel: stepReadings.reduce<ToleranceLevel>((worst, reading) => {
            const level = overallLevel(reading.displacementMm, step.limitMm, reading.stressMpa);
            if (level === 'exceed' || worst === 'exceed') return 'exceed';
            if (level === 'watch' || worst === 'watch') return 'watch';
            return 'ok';
          }, 'ok'),
        };
      });
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 按桥梁分组的步骤流 */
  readonly stepsByBridge$ = this.stepViews$.pipe(
    map((steps) => {
      const grouped = new Map<string, OfficialStepView[]>();
      for (const step of steps) {
        const list = grouped.get(step.bridgeId) ?? [];
        list.push(step);
        grouped.set(step.bridgeId, list);
      }
      return grouped;
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 计划累计顶升量流：桥梁 id → 累计值 */
  readonly cumulativeLift$ = this.stepViews$.pipe(
    map((steps) => {
      const totals: Record<string, number> = {};
      for (const step of steps) {
        if (step.seq === 1) totals[step.bridgeId] = 0;
        totals[step.bridgeId] = Number(((totals[step.bridgeId] ?? 0) + step.targetLiftMm).toFixed(2));
      }
      return totals;
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 最后一巡同步偏差流：步骤 id → 偏差 */
  readonly syncDeviation$ = this.snapshot$.pipe(
    map((snapshot) => {
      const result: Record<string, number> = {};
      for (const step of snapshot.steps) {
        result[step.id] = 0;
        const round = latestReadingRound(step, snapshot.readings);
        if (round.length) result[step.id] = Math.max(...round.map((item) => item.displacementMm)) - Math.min(...round.map((item) => item.displacementMm));
      }
      return result;
    }),
    shareReplay({ bufferSize: 1, refCount: true }),
  );

  /** 构建步骤视图（供派生流与页面共用） */
  buildStepViews(snapshot: StepTimelineSnapshot): OfficialStepView[] {
    return buildOfficialStepViews(snapshot.bridges, snapshot.steps, snapshot.readings);
  }
}
