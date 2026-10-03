import { createReducer, on } from '@ngrx/store';
import type { ImportJobRow, PendingReadingRow } from '../utils/db';
import { mergeActions } from './merge.actions';

export interface MergeStateSlice {
  pending: PendingReadingRow[];
  jobs: ImportJobRow[];
  busy: boolean;
  /** 最近一次提示（成功文案） */
  notice: string;
  error: string;
}

export const initialMergeState: MergeStateSlice = {
  pending: [],
  jobs: [],
  busy: false,
  notice: '',
  error: '',
};

export const mergeReducer = createReducer(
  initialMergeState,
  on(
    mergeActions.stagePackage,
    mergeActions.resumeJob,
    mergeActions.confirmCandidates,
    (state) => ({ ...state, busy: true, error: '', notice: '' }),
  ),
  on(mergeActions.stagePackageSuccess, (state, { pending, jobs, staged, reused }) => ({
    ...state,
    busy: false,
    pending,
    jobs,
    notice: reused ? '该设备包已暂存，未重复建档' : `已按顺序暂存 ${staged} 条读数，请逐项核对`,
  })),
  on(mergeActions.stagePackageFailure, mergeActions.confirmCandidatesFailure, (state, { message }) => ({
    ...state,
    busy: false,
    error: message,
  })),
  on(mergeActions.loadSuccess, mergeActions.discardJobSuccess, (state, { pending, jobs }) => ({
    ...state,
    pending,
    jobs,
  })),
  on(mergeActions.resumeJobSuccess, (state, { pending, jobs, job }) => ({
    ...state,
    busy: false,
    pending,
    jobs,
    notice: job.state === 'done' ? '已从检查点继续并完成正式读数写入' : '已从检查点继续暂存',
  })),
  on(mergeActions.confirmCandidatesSuccess, (state, { pending, jobs, finalized }) => ({
    ...state,
    busy: false,
    pending,
    jobs,
    notice: `${finalized} 条读数已确认进入正式读数，累计顶升量 / 同步偏差 / 告警已重算`,
  })),
  on(mergeActions.clearError, (state) => ({ ...state, error: '', notice: '' })),
);
