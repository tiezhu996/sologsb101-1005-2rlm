/**
 * 离线合并 NgRx Effects：
 * 动作落到 MergeService 的 IndexedDB 事务，成功后刷新暂存列表、广播数据变更
 * （正式读数写入会触发累计顶升量 / 同步偏差 / 超限告警的响应式重算），
 * 并在确认完成后检查支座验收归档条件。
 */
import { Injectable, inject } from '@angular/core';
import type { Action } from '@ngrx/store';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { catchError, from, map, switchMap } from 'rxjs';
import { mergeActions } from './merge.actions';
import { acceptanceActions } from './acceptance.actions';
import { MergeService } from '../services/merge.service';
import { IdbTableService } from '../services/idb-table.service';
import { getImportJob, listImportJobs, listPendingReadings } from '../utils/db';
import { checkBridgeArchived } from './archive.helper';

async function loadMergeState() {
  const [pending, jobs] = await Promise.all([listPendingReadings(), listImportJobs()]);
  return { pending, jobs };
}

@Injectable()
export class MergeEffects {
  private readonly actions$ = inject(Actions);
  private readonly merge = inject(MergeService);
  private readonly idb = inject(IdbTableService);

  /** 暂存设备包：按业务主键挂接 + 顺序暂存，同包幂等 */
  readonly stage$ = createEffect(() =>
    this.actions$.pipe(
      ofType(mergeActions.stagePackage),
      switchMap(({ snapshot, fileName }) =>
        from(this.merge.stageImportPackage(snapshot, fileName)).pipe(
          switchMap(async (result) => {
            const state = await loadMergeState();
            return mergeActions.stagePackageSuccess({
              job: result.job,
              staged: result.staged,
              reused: result.reused,
              pending: state.pending,
              jobs: state.jobs,
            });
          }),
          catchError((error: unknown) =>
            from([
              mergeActions.stagePackageFailure({
                message: error instanceof Error ? error.message : '设备包暂存失败，可从检查点重试',
              }),
            ]),
          ),
        ),
      ),
    ),
  );

  /** 加载暂存与任务 */
  readonly load$ = createEffect(() =>
    this.actions$.pipe(
      ofType(mergeActions.load),
      switchMap(() =>
        from(loadMergeState()).pipe(
          map((state) => mergeActions.loadSuccess(state)),
          catchError(() => from([])),
        ),
      ),
    ),
  );

  /** 从检查点继续（暂存中断或正式写入中断） */
  readonly resume$ = createEffect(() =>
    this.actions$.pipe(
      ofType(mergeActions.resumeJob),
      switchMap(({ jobId }) =>
        from(
          (async () => {
            const job = await this.merge.resumeImport(jobId ? await getImportJob(jobId) : undefined);
            if (job.state === 'done') this.idb.emitChange();
            const state = await loadMergeState();
            return mergeActions.resumeJobSuccess({ job, pending: state.pending, jobs: state.jobs });
          })(),
        ).pipe(
          catchError((error: unknown) =>
            from([
              mergeActions.stagePackageFailure({
                message: error instanceof Error ? error.message : '从检查点继续失败，可再次重试',
              }),
            ]),
          ),
        ),
      ),
    ),
  );

  /** 逐项确认后写入正式读数，随后重算统计并检查归档条件 */
  readonly confirm$ = createEffect(() =>
    this.actions$.pipe(
      ofType(mergeActions.confirmCandidates),
      switchMap(({ acceptedPendingIds, rejectedPendingIds }) =>
        from(this.merge.confirmCandidates(acceptedPendingIds, rejectedPendingIds)).pipe(
          switchMap(async (result) => {
            // 正式读数已落地：广播变更，累计顶升量 / 同步偏差 / 超限告警由派生流重算
            this.idb.emitChange();
            // 同步重算并更新支座验收归档条件（归档摘要含最新读数条数）
            const archive = await checkBridgeArchived().catch(() => ({
              archivableBridgeIds: [] as string[],
              summaries: [] as string[],
            }));
            const state = await loadMergeState();
            const actions: Action[] = [
              mergeActions.confirmCandidatesSuccess({
                pending: state.pending,
                jobs: state.jobs,
                finalized: result.finalized,
              }),
            ];
            if (archive.summaries.length > 0) {
              actions.push(
                acceptanceActions.archiveResult({
                  summary: `读数确认后已重算：满足归档条件 — ${archive.summaries.join('；')}`,
                }),
              );
            }
            return actions;
          }),
          switchMap((actions) => actions),
          catchError((error: unknown) =>
            from([
              mergeActions.confirmCandidatesFailure({
                message: error instanceof Error ? error.message : '确认写入失败，可从检查点重试',
              }),
            ]),
          ),
        ),
      ),
    ),
  );

  /** 放弃整包 */
  readonly discard$ = createEffect(() =>
    this.actions$.pipe(
      ofType(mergeActions.discardJob),
      switchMap(({ jobId }) =>
        from(this.merge.discardJob(jobId)).pipe(
          switchMap(async () => mergeActions.discardJobSuccess(await loadMergeState())),
          catchError(() => from([])),
        ),
      ),
    ),
  );
}
