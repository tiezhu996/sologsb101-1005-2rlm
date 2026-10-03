import { Component, computed, inject, signal, type Signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar, MatSnackBarModule } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { STEP_STATE_LABEL, SYNC_REQUIREMENT_LABEL, type StepView } from '../../../core/types/step';
import {
  POINT_CODES,
  STRESS_ALERT_MPA,
  meanDisplacement,
  readingDateHint,
  suggestPointCodes,
  syncDeviationMm,
  type ReadingView,
} from '../../../core/types/reading';
import { ROUTES } from '../../../core/router/app.routes';
import { stepActions } from '../../../core/store/step.actions';
import { buildStepViews, selectStepStats } from '../../../core/store/step.selectors';
import { selectBridges } from '../../../core/store/bridge.selectors';
import { mergeActions } from '../../../core/store/merge.actions';
import {
  selectConflictGroups,
  selectImportJobs,
  selectMergeBusy,
  selectMergeError,
  selectMergeNotice,
  selectPendingGroups,
  selectUnresolvedGroups,
} from '../../../core/store/merge.selectors';
import {
  PendingReviewDialogComponent,
  type PendingReviewResult,
} from '../../../shared/components/common/pending-review-dialog.component';
import { IdbTableService } from '../../../core/services/idb-table.service';
import { putReadings, rowMeta, newId, type ReadingRow, type DatabaseSnapshot } from '../../../core/utils/db';
import { formatMm, formatStress } from '../../../core/utils/unit';
import {
  TOLERANCE_HEX,
  TOLERANCE_LEVEL_LABEL,
  limitAlertText,
  overallLevel,
  syncAlertText,
} from '../../../core/utils/tolerance';
import { nowDateTime, readJsonFile } from '../../../core/utils/export';
import { StatBadgeComponent } from '../../../shared/components/common/stat-badge.component';
import { EmptyPanelComponent } from '../../../shared/components/common/empty-panel.component';
import { FilterBarComponent, type FilterSelectSpec } from '../../../shared/components/common/filter-bar.component';
import type { BridgeRow, ImportJobRow, StepRow } from '../../../core/utils/db';
import type { PendingGroup } from '../../../core/types/merge';
import type { ToleranceLevel } from '../../../core/utils/tolerance';

/** 批量录入的临时行 */
interface BatchRow {
  pointCode: string;
  displacementMm: number;
  stressMpa: number;
}

/**
 * /readings 测点读数录入
 * 按步骤批量录入位移与应力，实时显示同步偏差与限位告警；
 * 消费 Reading、Step 与 <FilterBar>。
 */
@Component({
  selector: 'app-reading-entry-page',
  standalone: true,
  imports: [
    FormsModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatChipsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSnackBarModule,
    MatTooltipModule,
    MatProgressBarModule,
    StatBadgeComponent,
    EmptyPanelComponent,
    FilterBarComponent,
  ],
  template: `
    <div class="page-head">
      <div>
        <h2 class="page-title">测点读数录入</h2>
        <div class="page-sub">
          选择顶升步骤后批量录入多测点位移与应力，实时计算同步偏差并按限位值给出告警。
        </div>
      </div>
      <div class="gb-inline-actions">
        <button mat-stroked-button (click)="go(ROUTES.steps)">
          <mat-icon>stairs</mat-icon>
          顶升步骤编排
        </button>
        <button mat-flat-button color="primary" [disabled]="batchRows().length === 0" (click)="submitBatch()">
          <mat-icon>save</mat-icon>
          提交 {{ batchRows().length }} 条读数
        </button>
      </div>
    </div>

    <div class="stat-grid">
      <app-stat-badge title="测点读数" [value]="stats().readingCount" [suffix]="'条'" color="#1565c0" />
      <app-stat-badge
        title="当前步骤平均位移"
        [value]="formatMm(currentAverage())"
        color="#00897b"
        [hint]="selectedStepLabel()"
      />
      <app-stat-badge
        title="同步偏差"
        [value]="formatMm(currentDeviation())"
        [percent]="deviationShare()"
        [color]="syncColor()"
        [hint]="'允许值 1.5 mm，当前 ' + syncLevelText()"
      />
      <app-stat-badge
        title="超限读数"
        [value]="exceedCount()"
        [suffix]="'条'"
        color="#c62828"
        [hint]="'限位值 ' + (selectedStep()?.limitMm ?? 0) + ' mm，应力关注值 ' + stressAlert + ' MPa'"
      />
    </div>

    <app-filter-bar
      keywordLabel="关键字"
      keywordPlaceholder="按测点编号 / 记录人搜索"
      [keyword]="keyword()"
      [selects]="selects()"
      [values]="filters()"
      [resultCount]="filtered().length"
      countUnit="条读数"
      (keywordChange)="onKeyword($event)"
      (filtersChange)="onFilters($event)"
    >
      <button mat-stroked-button (click)="clearFilters()">
        <mat-icon>filter_alt_off</mat-icon>
        清空筛选
      </button>
    </app-filter-bar>

    <div class="gb-section">
      <mat-card appearance="outlined">
        <div style="padding: 12px 14px">
          <div class="gb-card-title">批量录入面板</div>
          <div class="gb-inline-actions" style="margin-top: 10px">
            <mat-form-field appearance="outline" style="min-width: 300px">
              <mat-label>顶升步骤</mat-label>
              <mat-select
                [ngModel]="selectedStepId()"
                (ngModelChange)="onStepChange($event)"
              >
                @for (step of stepViews(); track step.id) {
                  <mat-option [value]="step.id">
                    #{{ step.seq }} {{ step.bridgeName }} · 目标 {{ step.targetLiftMm }} mm ·
                    {{ syncRequirementLabel[step.syncRequirement] }} · {{ stepStateLabel[step.state] }}
                  </mat-option>
                }
              </mat-select>
            </mat-form-field>
            <mat-form-field appearance="outline" style="min-width: 190px">
              <mat-label>记录人</mat-label>
              <input matInput [ngModel]="operator()" (ngModelChange)="operator.set($event)" />
            </mat-form-field>
            <mat-form-field appearance="outline" style="min-width: 230px">
              <mat-label>记录时间</mat-label>
              <input
                matInput
                type="datetime-local"
                [ngModel]="recordedAt()"
                (ngModelChange)="recordedAt.set($event)"
              />
            </mat-form-field>
            <button mat-stroked-button (click)="regenerateRows()">
              <mat-icon>autorenew</mat-icon>
              重排测点
            </button>
            <button mat-stroked-button (click)="fillReference()">
              <mat-icon>functions</mat-icon>
              按目标顶升量填参考值
            </button>
          </div>
          <div class="gb-hint">{{ dateHint() }}</div>

          @if (selectedStep(); as step) {
            <div class="gb-table-wrap" style="margin-top: 10px">
              <table class="gb-table">
                <thead>
                  <tr>
                    <th style="width: 120px">测点编号</th>
                    <th style="width: 190px">位移（mm）</th>
                    <th style="width: 190px">应力（MPa）</th>
                    <th>判定</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of batchRows(); track row.pointCode) {
                    <tr>
                      <td class="gb-mono">{{ row.pointCode }}</td>
                      <td>
                        <input
                          class="gb-input"
                          type="number"
                          step="0.01"
                          [ngModel]="row.displacementMm"
                          (ngModelChange)="updateRow(row.pointCode, 'displacementMm', $event)"
                        />
                      </td>
                      <td>
                        <input
                          class="gb-input"
                          type="number"
                          step="0.01"
                          [ngModel]="row.stressMpa"
                          (ngModelChange)="updateRow(row.pointCode, 'stressMpa', $event)"
                        />
                      </td>
                      <td>
                        <span [style.color]="rowColor(row)">
                          {{ rowLevelText(row) }}
                        </span>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
            <div class="gb-timeline" style="margin-top: 10px">
              <div
                class="gb-timeline-node"
                [class.is-exceed]="batchDeviationLevel() === 'exceed'"
                [class.is-watch]="batchDeviationLevel() === 'watch'"
              >
                <div>{{ syncAlertText(batchDeviation(), syncRequirementLabel[step.syncRequirement]) }}</div>
                <div class="gb-hint">
                  本批 {{ batchRows().length }} 个测点，平均位移 {{ formatMm(batchAverage()) }}；{{ limitAlertText(batchMax(), step.limitMm) }}
                </div>
              </div>
            </div>
          } @else {
            <app-empty-panel
              title="请选择顶升步骤"
              description="先在顶升步骤编排页创建步骤，再回到本页批量录入测点读数。"
              icon="monitor_heart"
              actionLabel="去编排步骤"
              (action)="go(ROUTES.steps)"
            />
          }
        </div>
      </mat-card>
    </div>

    <div class="gb-section">
      <mat-card appearance="outlined">
        <div style="padding: 12px 14px">
          <div class="gb-card-title">
            离线合并（两组平板回机）
            @if (mergeBusy()) {
              <mat-progress-bar mode="indeterminate" style="max-width: 260px; display: inline-block; vertical-align: middle; margin-left: 12px"></mat-progress-bar>
            }
          </div>
          <div class="gb-hint" style="margin-top: 4px">
            选择另一组平板导出的整库 JSON：不信任设备记录号，先按「桥梁名称 + 步骤序号 + 测点编号」挂回本机步骤并按顺序暂存；
            两边数值不同会并列保留，逐项确认后才进入正式读数。缺少应力字段的旧数据按缺测兼容读入。
          </div>
          <div class="gb-inline-actions" style="margin-top: 10px">
            <label class="upload-label">
              <input type="file" accept="application/json" hidden (change)="handleMergeFile($event)" />
              <span mat-stroked-button>
                <mat-icon>sync</mat-icon>
                暂存设备包并挂接
              </span>
            </label>
            <button
              mat-stroked-button
              [disabled]="recoverableJobs().length === 0 || mergeBusy()"
              (click)="retryMerge()"
            >
              <mat-icon>history</mat-icon>
              从检查点重试（{{ recoverableJobs().length }}）
            </button>
            <button
              mat-flat-button
              color="primary"
              [disabled]="pendingGroups().length === 0 || mergeBusy()"
              (click)="openReview()"
            >
              <mat-icon>fact_check</mat-icon>
              逐项核对确认（{{ pendingGroups().length }} 组待处理）
            </button>
          </div>

          @if (mergeError()) {
            <div class="merge-err">
              <mat-icon>error_outline</mat-icon>
              <span>{{ mergeError() }}（已保留检查点，可点击「从检查点重试」，重试同一包不会重复建档）</span>
            </div>
          }
          @if (mergeNotice()) {
            <div class="merge-ok">
              <mat-icon>check_circle_outline</mat-icon>
              <span>{{ mergeNotice() }}</span>
            </div>
          }

          @if (stagedJobs().length > 0) {
            <div class="gb-table-wrap" style="margin-top: 10px">
              <table class="gb-table">
                <thead>
                  <tr>
                    <th>设备包</th>
                    <th>来源</th>
                    <th>阶段</th>
                    <th>检查点进度</th>
                    <th>状态</th>
                    <th style="width: 120px">操作</th>
                  </tr>
                </thead>
                <tbody>
                  @for (job of stagedJobs(); track job.id) {
                    <tr>
                      <td class="gb-mono">{{ job.fileName }}</td>
                      <td>{{ job.deviceId }}</td>
                      <td>{{ job.phase === 'stage' ? '暂存建档' : '确认写入' }}</td>
                      <td>{{ jobProgress(job) }}</td>
                      <td [class.merge-err-text]="job.state === 'failed'">{{ jobStateLabel(job.state) }}</td>
                      <td>
                        <div class="gb-row-actions">
                          @if (job.state === 'failed' || job.state === 'staging' || job.state === 'finalizing') {
                            <button mat-button color="primary" [disabled]="mergeBusy()" (click)="resumeJob(job.id)">
                              从检查点继续
                            </button>
                          } @else {
                            <button mat-button color="primary" [disabled]="mergeBusy()" (click)="openReview()">
                              逐项核对
                            </button>
                            <button mat-button color="warn" [disabled]="mergeBusy()" (click)="discardJob(job.id)">
                              放弃暂存
                            </button>
                          }
                        </div>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }

          @if (pendingGroups().length > 0) {
            <div class="gb-tags" style="margin-top: 10px">
              <mat-chip highlighted>待确认分组 {{ pendingGroups().length }}</mat-chip>
              <mat-chip class="merge-chip-conflict">数值冲突 {{ conflictGroups().length }}</mat-chip>
              <mat-chip class="merge-chip-warn">无法挂接 {{ unresolvedGroups().length }}</mat-chip>
            </div>
          }
        </div>
      </mat-card>
    </div>

    <div class="gb-section">
      <div class="gb-card-title" style="margin-bottom: 8px">已录入读数（{{ filtered().length }} 条）</div>
      @if (filtered().length === 0) {
        <app-empty-panel
          title="暂无测点读数"
          description="选择步骤后批量录入，或在步骤页推进状态后再录入。"
          icon="sensors"
        />
      } @else {
        <div class="gb-table-wrap">
          <table class="gb-table">
            <thead>
              <tr>
                <th>步骤</th>
                <th>桥梁</th>
                <th>测点</th>
                <th>位移</th>
                <th>相对偏差</th>
                <th>应力</th>
                <th>记录时间</th>
                <th>记录人</th>
                <th>判定</th>
                <th style="width: 90px">操作</th>
              </tr>
            </thead>
            <tbody>
              @for (reading of filtered(); track reading.id) {
                <tr>
                  <td>#{{ reading.stepSeq }}</td>
                  <td>{{ reading.bridgeName }}</td>
                  <td class="gb-mono">{{ reading.pointCode }}</td>
                  <td>{{ formatMm(reading.displacementMm) }}</td>
                  <td [style.color]="reading.deviationMm === 0 ? '#2e7d32' : '#ed6c02'">
                    {{ formatMm(reading.deviationMm) }}
                  </td>
                  <td [style.color]="reading.stressAlert ? '#c62828' : '#2e7d32'">
                    {{ formatStress(reading.stressMpa) }}
                  </td>
                  <td>{{ reading.recordedAt }}</td>
                  <td>{{ reading.operator }}</td>
                  <td>
                    <mat-chip-set>
                      <mat-chip [style.background]="readingColor(reading)" [style.color]="'#fff'">
                        {{ readingLevelText(reading) }}
                      </mat-chip>
                    </mat-chip-set>
                  </td>
                  <td>
                    <button mat-button color="warn" (click)="deleteReading(reading)">
                      <mat-icon>delete</mat-icon>
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .gb-input {
        width: 100%;
        padding: 6px 8px;
        border: 1px solid rgba(22, 34, 46, 0.2);
        border-radius: 6px;
        font-size: 13px;
      }
      .upload-label {
        display: inline-block;
      }
      .merge-err,
      .merge-ok {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 10px;
        padding: 8px 12px;
        border-radius: 8px;
        font-size: 13px;
      }
      .merge-err {
        background: #ffebee;
        color: #b71c1c;
      }
      .merge-ok {
        background: #e8f5e9;
        color: #1b5e20;
      }
      .merge-err-text {
        color: #c62828;
      }
      .merge-chip-conflict {
        background: #ffebee !important;
        color: #b71c1c !important;
      }
      .merge-chip-warn {
        background: #fff4e5 !important;
        color: #8d4b00 !important;
      }
    `,
  ],
})
export class ReadingEntryPage {
  private readonly store = inject(Store);
  private readonly idb = inject(IdbTableService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly ROUTES = ROUTES;
  readonly syncRequirementLabel = SYNC_REQUIREMENT_LABEL;
  readonly stepStateLabel = STEP_STATE_LABEL;
  readonly stressAlert = STRESS_ALERT_MPA;
  readonly formatMm = formatMm;
  readonly formatStress = formatStress;
  readonly syncAlertText = syncAlertText;
  readonly limitAlertText = limitAlertText;

  private readonly bridges: Signal<BridgeRow[]> = toSignal(this.store.select(selectBridges), {
    initialValue: [] as BridgeRow[],
  });
  private readonly steps: Signal<StepRow[]> = toSignal(this.store.select((state) => state.step.steps), {
    initialValue: [] as StepRow[],
  });
  private readonly readings: Signal<ReadingRow[]> = toSignal(
    this.store.select((state) => state.step.readings),
    { initialValue: [] as ReadingRow[] },
  );

  readonly stats = toSignal(this.store.select(selectStepStats), {
    initialValue: {
      total: 0,
      cumulativeMm: 0,
      arrived: 0,
      lifting: 0,
      idle: 0,
      readingCount: 0,
      maxLimitMm: 0,
    },
  });

  /* ===================== 离线合并（两组平板回机） ===================== */
  readonly pendingGroups: Signal<PendingGroup[]> = toSignal(this.store.select(selectPendingGroups), {
    initialValue: [] as PendingGroup[],
  });
  readonly conflictGroups = toSignal(this.store.select(selectConflictGroups), { initialValue: [] as PendingGroup[] });
  readonly unresolvedGroups = toSignal(this.store.select(selectUnresolvedGroups), {
    initialValue: [] as PendingGroup[],
  });
  readonly mergeJobs: Signal<ImportJobRow[]> = toSignal(this.store.select(selectImportJobs), {
    initialValue: [] as ImportJobRow[],
  });
  readonly mergeBusy = toSignal(this.store.select(selectMergeBusy), { initialValue: false });
  readonly mergeNotice = toSignal(this.store.select(selectMergeNotice), { initialValue: '' });
  readonly mergeError = toSignal(this.store.select(selectMergeError), { initialValue: '' });

  /** 尚未结束（暂存 / 待确认 / 失败）的任务，按更新时间倒序 */
  readonly stagedJobs = computed(() => this.mergeJobs().filter((job) => job.state !== 'done'));
  /** 可从检查点继续的任务 */
  readonly recoverableJobs = computed(() =>
    this.mergeJobs().filter((job) => ['failed', 'staging', 'finalizing'].includes(job.state)),
  );

  jobStateLabel(state: ImportJobRow['state']): string {
    switch (state) {
      case 'staging':
        return '暂存中…';
      case 'staged':
        return '已暂存待确认';
      case 'finalizing':
        return '确认写入中…';
      case 'done':
        return '已完成';
      case 'failed':
        return '写入失败（可继续）';
    }
  }

  jobProgress(job: ImportJobRow): string {
    if (job.phase === 'finalize') {
      const total = job.finalized + job.finalizeQueue.length;
      return `${job.finalized} / ${total || job.total} 条正式读数`;
    }
    return `${job.staged} / ${job.total} 条暂存`;
  }

  readonly stepViews: Signal<StepView[]> = computed(() =>
    buildStepViews(this.steps(), this.readings(), this.bridges()),
  );

  readonly keyword = signal('');
  readonly filters = signal<Record<string, string[]>>({ step: [], level: [] });
  readonly selectedStepId = signal('');
  readonly batchRows = signal<BatchRow[]>([]);
  /** 记录人（signal，模板双向绑定到 signal.set） */
  readonly operator = signal('陈立强');
  /** 记录时间（datetime-local 口径 yyyy-MM-ddTHH:mm） */
  readonly recordedAt = signal(nowDateTime().replace(' ', 'T'));

  readonly selects = computed<FilterSelectSpec[]>(() => [
    {
      key: 'step',
      label: '顶升步骤',
      options: this.stepViews().map((step) => `#${step.seq} ${step.bridgeName}`),
    },
    { key: 'level', label: '判定', options: ['正常', '关注', '超限'] },
  ]);

  /** 读数视图：带步骤上下文与相对偏差 */
  readonly readingViews: Signal<ReadingView[]> = computed(() => {
    const steps = new Map(this.stepViews().map((step) => [step.id, step]));
    return this.readings()
      .map((reading) => {
        const step = steps.get(reading.stepId);
        const sameRound = this.readings().filter(
          (item) => item.stepId === reading.stepId && item.recordedAt === reading.recordedAt,
        );
        const average = meanDisplacement(sameRound);
        const limitMm = step?.limitMm ?? 0;
        return {
          ...reading,
          stepSeq: step?.seq ?? 0,
          bridgeId: step?.bridgeId ?? '',
          bridgeName: step?.bridgeName ?? '未归属桥梁',
          syncRequirement: step ? SYNC_REQUIREMENT_LABEL[step.syncRequirement] : '-',
          deviationMm: Number((reading.displacementMm - average).toFixed(3)),
          overLimit: limitMm > 0 && Math.abs(reading.displacementMm) >= limitMm,
          stressAlert: reading.stressMpa !== null && reading.stressMpa >= STRESS_ALERT_MPA,
        };
      })
      .sort((a, b) => (a.stepSeq === b.stepSeq ? b.recordedAt.localeCompare(a.recordedAt) : a.stepSeq - b.stepSeq));
  });

  readonly filtered = computed(() => {
    const lower = this.keyword().trim().toLowerCase();
    const stepLabels = this.filters()['step'] ?? [];
    const levelLabels = this.filters()['level'] ?? [];
    return this.readingViews().filter((reading) => {
      if (stepLabels.length > 0 && !stepLabels.includes(`#${reading.stepSeq} ${reading.bridgeName}`)) return false;
      if (levelLabels.length > 0 && !levelLabels.includes(this.readingLevelText(reading))) return false;
      if (lower && !`${reading.pointCode} ${reading.operator}`.toLowerCase().includes(lower)) return false;
      return true;
    });
  });

  readonly selectedStep = computed(() =>
    this.stepViews().find((step) => step.id === this.selectedStepId()) ?? null,
  );

  readonly currentAverage = computed(() => {
    const step = this.selectedStep();
    if (!step) return 0;
    return meanDisplacement(this.readings().filter((item) => item.stepId === step.id));
  });

  readonly currentDeviation = computed(() => {
    const step = this.selectedStep();
    if (!step) return 0;
    return syncDeviationMm(this.readings().filter((item) => item.stepId === step.id));
  });

  readonly exceedCount = computed(() =>
    this.readingViews().filter((reading) => reading.overLimit || reading.stressAlert).length,
  );

  readonly batchAverage = computed(() => meanDisplacement(this.batchRows()));
  readonly batchDeviation = computed(() => syncDeviationMm(this.batchRows()));
  readonly batchMax = computed(() =>
    this.batchRows().length === 0 ? 0 : Math.max(...this.batchRows().map((item) => Math.abs(item.displacementMm))),
  );

  constructor() {
    this.route.queryParamMap.subscribe((params) => {
      this.keyword.set(params.get('kw') ?? '');
      const next: Record<string, string[]> = { step: [], level: [] };
      for (const key of Object.keys(next)) {
        const raw = params.get(key);
        next[key] = raw ? raw.split(',').map((item) => item.trim()).filter(Boolean) : [];
      }
      this.filters.set(next);
      const stepId = params.get('stepId');
      if (stepId) this.onStepChange(stepId);
    });

    // 默认选中第一个步骤并生成测点行
    queueMicrotask(() => {
      if (!this.selectedStepId() && this.stepViews().length > 0) {
        this.onStepChange(this.stepViews()[0].id);
      }
      // 进入页面即拉取离线合并暂存与检查点
      this.store.dispatch(mergeActions.load());
    });
  }

  selectedStepLabel(): string {
    const step = this.selectedStep();
    if (!step) return '未选择步骤';
    return `#${step.seq} ${step.bridgeName} · 目标 ${step.targetLiftMm} mm · 限位 ${step.limitMm} mm`;
  }

  dateHint(): string {
    const step = this.selectedStep();
    return readingDateHint(this.recordedAt().replace('T', ' '), step?.state ?? 'idle');
  }

  onStepChange(stepId: string): void {
    this.selectedStepId.set(stepId);
    this.regenerateRows();
    const queryParams: Record<string, string> = { stepId };
    if (this.keyword().trim()) queryParams['kw'] = this.keyword().trim();
    for (const [key, list] of Object.entries(this.filters())) {
      if (list.length > 0) queryParams[key] = list.join(',');
    }
    void this.router.navigate([], { relativeTo: this.route, queryParams, replaceUrl: true });
  }

  /** 按同步要求生成测点行（同步 4 点、交叉 4 点、单点 1 点） */
  regenerateRows(): void {
    const step = this.selectedStep();
    if (!step) {
      this.batchRows.set([]);
      return;
    }
    const codes = step.syncRequirement === 'single' ? ['P1'] : suggestPointCodes(2).slice(0, 4);
    this.batchRows.set(
      codes.map((pointCode) => ({ pointCode, displacementMm: step.targetLiftMm, stressMpa: 8 })),
    );
  }

  /** 按目标顶升量填参考值（略带测点间差异，便于观察同步偏差） */
  fillReference(): void {
    const step = this.selectedStep();
    if (!step) return;
    this.batchRows.set(
      this.batchRows().map((row, index) => ({
        ...row,
        displacementMm: Number((step.targetLiftMm - index * 0.2).toFixed(2)),
        stressMpa: Number((8 + index * 0.4).toFixed(2)),
      })),
    );
  }

  updateRow(pointCode: string, field: 'displacementMm' | 'stressMpa', value: number): void {
    this.batchRows.set(
      this.batchRows().map((row) => (row.pointCode === pointCode ? { ...row, [field]: Number(value) } : row)),
    );
  }

  rowLevelText(row: BatchRow): string {
    const step = this.selectedStep();
    if (!step) return '—';
    const level = overallLevel(row.displacementMm, step.limitMm, row.stressMpa);
    return TOLERANCE_LEVEL_LABEL[level];
  }

  rowColor(row: BatchRow): string {
    const step = this.selectedStep();
    if (!step) return TOLERANCE_HEX.ok;
    return TOLERANCE_HEX[overallLevel(row.displacementMm, step.limitMm, row.stressMpa)];
  }

  batchDeviationLevel(): ToleranceLevel {
    const deviation = this.batchDeviation();
    if (deviation >= 1.5) return 'exceed';
    if (deviation >= 0.8) return 'watch';
    return 'ok';
  }

  syncColor(): string {
    return TOLERANCE_HEX[this.currentDeviation() >= 1.5 ? 'exceed' : this.currentDeviation() >= 0.8 ? 'watch' : 'ok'];
  }

  syncLevelText(): string {
    const deviation = this.currentDeviation();
    return TOLERANCE_LEVEL_LABEL[deviation >= 1.5 ? 'exceed' : deviation >= 0.8 ? 'watch' : 'ok'];
  }

  deviationShare(): number {
    return Math.min(100, Number(((this.currentDeviation() / 1.5) * 100).toFixed(1)));
  }

  readingLevelText(reading: ReadingView): string {
    const step = this.selectedStep();
    const limitMm = this.stepViews().find((item) => item.id === reading.stepId)?.limitMm ?? step?.limitMm ?? 0;
    return TOLERANCE_LEVEL_LABEL[overallLevel(reading.displacementMm, limitMm, reading.stressMpa)];
  }

  readingColor(reading: ReadingView): string {
    const limitMm = this.stepViews().find((item) => item.id === reading.stepId)?.limitMm ?? 0;
    return TOLERANCE_HEX[overallLevel(reading.displacementMm, limitMm, reading.stressMpa)];
  }

  async submitBatch(): Promise<void> {
    const step = this.selectedStep();
    const rows = this.batchRows();
    if (!step || rows.length === 0) return;
    const recorded = this.recordedAt().replace('T', ' ');
    const payload = rows.map((row) => ({
      stepId: step.id,
      pointCode: row.pointCode,
      displacementMm: row.displacementMm,
      stressMpa: row.stressMpa,
      recordedAt: recorded,
      operator: this.operator(),
    }));
    await putReadings(
      payload.map((row) => ({ ...row, id: newId('read'), ...rowMeta() })),
    );
    this.idb.emitChange();
    this.snackBar.open(
      `已录入 ${payload.length} 条读数，同步偏差 ${formatMm(syncDeviationMm(rows))}`,
      '关闭',
      { duration: 3000 },
    );
  }

  async deleteReading(reading: ReadingView): Promise<void> {
    if (!confirm(`确认删除测点 ${reading.pointCode} 的读数？`)) return;
    await this.idb.database.readings.delete(reading.id);
    this.idb.emitChange();
    this.snackBar.open('测点读数已删除', '关闭', { duration: 2400 });
  }

  /* ============================= 离线合并 ============================= */

  /** 选择另一组平板的整库 JSON：挂接 → 顺序暂存（同包幂等，失败留检查点） */
  async handleMergeFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const snapshot = await readJsonFile<DatabaseSnapshot>(file);
      if (!snapshot || !Array.isArray(snapshot.readings) || !Array.isArray(snapshot.steps)) {
        this.snackBar.open('文件格式不正确：缺少 steps / readings 数据，无法挂接', '关闭', { duration: 3200 });
        return;
      }
      this.store.dispatch(mergeActions.stagePackage({ snapshot, fileName: file.name }));
    } catch (error) {
      this.snackBar.open(
        `设备包解析失败：${error instanceof Error ? error.message : '文件异常'}`,
        '关闭',
        { duration: 3200 },
      );
    }
  }

  /** 打开逐项核对对话框；确认结果交给 effect 写正式读数并重算 */
  openReview(): void {
    const groups = this.pendingGroups();
    if (groups.length === 0) return;
    const dialogRef = this.dialog.open(PendingReviewDialogComponent, {
      width: '880px',
      maxWidth: '94vw',
      data: { groups },
    });
    dialogRef.afterClosed().subscribe((result: PendingReviewResult | null) => {
      if (!result) return;
      this.store.dispatch(
        mergeActions.confirmCandidates({
          acceptedPendingIds: result.acceptedPendingIds,
          rejectedPendingIds: result.rejectedPendingIds,
        }),
      );
    });
  }

  /** 一键继续最近失败 / 中断的任务 */
  retryMerge(): void {
    const job = this.recoverableJobs()[0];
    this.store.dispatch(mergeActions.resumeJob({ jobId: job?.id }));
  }

  /** 继续指定任务（暂存或确认阶段） */
  resumeJob(jobId: string): void {
    this.store.dispatch(mergeActions.resumeJob({ jobId }));
  }

  /** 放弃整包暂存（仅在尚未确认进入正式读数时允许） */
  discardJob(jobId: string): void {
    if (!confirm('放弃该设备包的全部暂存读数？不会影响已确认的正式读数。')) return;
    this.store.dispatch(mergeActions.discardJob({ jobId }));
  }

  go(path: string): void {
    void this.router.navigate([path]);
  }

  onKeyword(value: string): void {
    this.keyword.set(value);
    this.syncQuery(value, this.filters());
  }

  onFilters(values: Record<string, string[]>): void {
    this.filters.set(values);
    this.syncQuery(this.keyword(), values);
  }

  clearFilters(): void {
    this.keyword.set('');
    this.filters.set({ step: [], level: [] });
    this.syncQuery('', { step: [], level: [] });
  }

  private syncQuery(keyword: string, values: Record<string, string[]>): void {
    const queryParams: Record<string, string> = {};
    if (keyword.trim()) queryParams['kw'] = keyword.trim();
    if (this.selectedStepId()) queryParams['stepId'] = this.selectedStepId();
    for (const [key, list] of Object.entries(values)) {
      if (list.length > 0) queryParams[key] = list.join(',');
    }
    void this.router.navigate([], { relativeTo: this.route, queryParams, replaceUrl: true });
  }
}
