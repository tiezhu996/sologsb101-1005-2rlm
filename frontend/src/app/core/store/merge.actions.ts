/**
 * 离线合并动作：
 * 暂存导入（可重试、从检查点继续）→ 加载暂存 → 逐项确认进入正式读数 → 重算与归档。
 */
import { createActionGroup, emptyProps, props } from '@ngrx/store';
import type { DatabaseSnapshot, ImportJobRow, PendingReadingRow } from '../utils/db';

export const mergeActions = createActionGroup({
  source: 'merge',
  events: {
    /** 选择整库 JSON 后发起暂存（同包幂等） */
    'Stage Package': props<{ snapshot: DatabaseSnapshot; fileName: string }>(),
    'Stage Package Success': props<{
      job: ImportJobRow;
      staged: number;
      reused: boolean;
      pending: PendingReadingRow[];
      jobs: ImportJobRow[];
    }>(),
    'Stage Package Failure': props<{ message: string }>(),

    /** 重新拉取暂存与任务列表 */
    'Load': emptyProps(),
    'Load Success': props<{ pending: PendingReadingRow[]; jobs: ImportJobRow[] }>(),

    /** 从检查点继续失败的任务（暂存 / 确认两阶段都适用） */
    'Resume Job': props<{ jobId?: string }>(),
    'Resume Job Success': props<{
      job: ImportJobRow;
      pending: PendingReadingRow[];
      jobs: ImportJobRow[];
    }>(),

    /** 逐项确认：采纳 / 拒绝的暂存 id；确认后进入正式读数并重算（可跨多个设备包） */
    'Confirm Candidates': props<{ acceptedPendingIds: string[]; rejectedPendingIds: string[] }>(),
    'Confirm Candidates Success': props<{
      pending: PendingReadingRow[];
      jobs: ImportJobRow[];
      finalized: number;
    }>(),
    'Confirm Candidates Failure': props<{ message: string }>(),

    /** 放弃整包暂存 */
    'Discard Job': props<{ jobId: string }>(),
    'Discard Job Success': props<{ pending: PendingReadingRow[]; jobs: ImportJobRow[] }>(),

    /** 清理错误 / 成功提示 */
    'Clear Error': emptyProps(),
  },
});
