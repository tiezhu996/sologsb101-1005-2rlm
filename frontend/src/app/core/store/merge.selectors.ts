import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { MergeStateSlice } from './merge.reducer';
import { groupPending, type PendingGroup } from '../types/merge';

export const selectMergeState = createFeatureSelector<MergeStateSlice>('merge');
export const selectPendingReadings = createSelector(selectMergeState, (state) => state.pending);
export const selectImportJobs = createSelector(selectMergeState, (state) => state.jobs);
export const selectMergeBusy = createSelector(selectMergeState, (state) => state.busy);
export const selectMergeNotice = createSelector(selectMergeState, (state) => state.notice);
export const selectMergeError = createSelector(selectMergeState, (state) => state.error);

/** 暂存按业务主键（桥梁 + 步骤序号 + 测点）分组 */
export const selectPendingGroups = createSelector(selectPendingReadings, (pending): PendingGroup[] =>
  groupPending(pending),
);

/** 存在数值冲突、必须逐项确认的分组 */
export const selectConflictGroups = createSelector(selectPendingGroups, (groups) =>
  groups.filter((group) => group.status === 'conflict'),
);

/** 无法挂接回本机桥梁 / 步骤的分组 */
export const selectUnresolvedGroups = createSelector(selectPendingGroups, (groups) =>
  groups.filter((group) => group.status === 'unresolved'),
);

/** 可从检查点继续 / 已暂存待确认的任务 */
export const selectRecoverableJobs = createSelector(selectImportJobs, (jobs) =>
  jobs.filter((job) => job.state === 'failed' || job.state === 'staging' || job.state === 'finalizing'),
);

/** 是否仍有暂存读数待确认（导航徽标用） */
export const selectPendingCount = createSelector(selectPendingReadings, (pending) => pending.length);
