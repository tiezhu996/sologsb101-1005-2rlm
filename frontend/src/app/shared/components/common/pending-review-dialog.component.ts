/**
 * 离线合并暂存核对对话框：
 * - 同一「桥梁 / 步骤序号 / 测点」分组并列展示两台设备的读数；
 * - 数值不同的分组高亮为冲突，逐项勾选采纳值（每组至少保留一条）；
 * - 无法挂接回本机记录的分组单独提示，可整组放弃；
 * - 确认结果回传页面，由 NgRx effect 写入正式 readings（可重试、不重复建档）。
 */
import { Component, Inject, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatChipsModule } from '@angular/material/chips';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialogModule, MatDialogRef, MAT_DIALOG_DATA } from '@angular/material/dialog';
import { MatTooltipModule } from '@angular/material/tooltip';
import { formatMm, formatStress } from '../../../core/utils/unit';
import { valueSignature, type PendingGroup } from '../../../core/types/merge';

export interface PendingReviewData {
  /** 一次核对可覆盖多个设备包，分组内候选自带 jobId */
  groups: PendingGroup[];
}

export interface PendingReviewResult {
  acceptedPendingIds: string[];
  rejectedPendingIds: string[];
  /** 用户在对话框中明确放弃的无法挂接分组 */
  unresolvedDropped: boolean;
}

@Component({
  selector: 'app-pending-review-dialog',
  standalone: true,
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatChipsModule,
    MatCheckboxModule,
    MatDialogModule,
    MatTooltipModule,
  ],
  template: `
    <h2 mat-dialog-title>
      离线读数核对
      <span class="dlg-sub">同一测点两边数值不同时并列保留，请逐项确认后进入正式读数</span>
    </h2>
    <mat-dialog-content>
      @if (unresolvedGroups().length > 0) {
        <div class="dlg-warn">
          <mat-icon>link_off</mat-icon>
          <div>
            {{ unresolvedGroups().length }} 个测点无法按「桥梁名称 + 步骤序号」挂回本机记录，
            确认时将不写入这些读数。
            <label class="dlg-drop">
              <mat-checkbox [(ngModel)]="dropUnresolved" />
              确认后同时清理这些无法挂接的暂存
            </label>
          </div>
        </div>
      }

      <div class="dlg-summary">
        <mat-chip highlighted>待核对分组 {{ data.groups.length }}</mat-chip>
        <mat-chip class="chip-conflict">数值冲突 {{ conflictGroups().length }}</mat-chip>
        <mat-chip>数值一致 {{ readyGroups().length }}</mat-chip>
        <mat-chip class="chip-warn">无法挂接 {{ unresolvedGroups().length }}</mat-chip>
      </div>

      @for (group of resolvableGroups(); track group.key; let gi = $index) {
        <div class="grp" [class.grp-conflict]="group.status === 'conflict'">
          <div class="grp-head">
            <span class="grp-title">
              {{ gi + 1 }}. {{ group.bridgeName }} · 第 {{ group.stepSeq }} 步 · 测点
              <b>{{ group.pointCode }}</b>
            </span>
            @if (group.status === 'conflict') {
              <mat-chip class="chip-conflict">
                <mat-icon>warning</mat-icon>数值不同，逐项确认
              </mat-chip>
            } @else {
              <mat-chip highlighted>数值一致</mat-chip>
            }
            <span class="grp-spacer"></span>
            <button mat-button type="button" (click)="selectAll(group, true)">全采纳</button>
            <button mat-button type="button" (click)="selectAll(group, false)">全不选</button>
          </div>
          <table class="dlg-table">
            <thead>
              <tr>
                <th style="width: 46px">采纳</th>
                <th>设备 / 记录号</th>
                <th>位移</th>
                <th>应力</th>
                <th>记录时间</th>
                <th>记录人</th>
              </tr>
            </thead>
            <tbody>
              @for (candidate of group.candidates; track candidate.id) {
                <tr [class.is-same]="sameSignature(group, candidate.id)">
                  <td>
                    <mat-checkbox
                      [checked]="isChecked(candidate.id)"
                      (change)="toggle(candidate.id)"
                    />
                  </td>
                  <td class="dlg-mono">
                    {{ candidate.deviceId }}
                    <span class="dlg-hint">#{{ candidate.sourceRecordId }}</span>
                  </td>
                  <td>{{ formatMm(candidate.displacementMm) }}</td>
                  <td [class.dlg-missing]="candidate.stressMissing">
                    {{ formatStress(candidate.stressMpa) }}
                  </td>
                  <td>{{ candidate.recordedAt || '—' }}</td>
                  <td>{{ candidate.operator || '—' }}</td>
                </tr>
              }
            </tbody>
          </table>
          @if (groupError(group.key)) {
            <div class="dlg-error">{{ groupError(group.key) }}</div>
          }
        </div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="close()">取消</button>
      <button mat-flat-button color="primary" [disabled]="!canConfirm()" (click)="confirm()">
        确认进入正式读数（{{ acceptedCount() }} 条）
      </button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .dlg-sub {
        font-size: 12px;
        font-weight: 400;
        opacity: 0.7;
        margin-left: 10px;
      }
      .dlg-summary {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin: 6px 0 14px;
      }
      .dlg-warn {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        background: #fff4e5;
        color: #8d4b00;
        border: 1px solid #ffcc80;
        border-radius: 8px;
        padding: 10px 12px;
        margin-bottom: 12px;
        font-size: 13px;
      }
      .dlg-drop {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-left: 8px;
      }
      .grp {
        border: 1px solid rgba(22, 34, 46, 0.14);
        border-radius: 10px;
        padding: 10px 12px;
        margin-bottom: 12px;
      }
      .grp-conflict {
        border-color: #ef9a9a;
        background: #fff8f8;
      }
      .grp-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      .grp-title {
        font-size: 13px;
      }
      .grp-spacer {
        flex: 1;
      }
      .chip-conflict {
        background: #ffebee !important;
        color: #b71c1c !important;
      }
      .chip-warn {
        background: #fff4e5 !important;
        color: #8d4b00 !important;
      }
      .dlg-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .dlg-table th,
      .dlg-table td {
        text-align: left;
        padding: 6px 8px;
        border-top: 1px solid rgba(22, 34, 46, 0.08);
      }
      .dlg-mono {
        font-family: monospace;
      }
      .dlg-hint {
        opacity: 0.55;
        margin-left: 4px;
      }
      .dlg-missing {
        color: #ed6c02;
      }
      .dlg-error {
        color: #c62828;
        font-size: 12px;
        margin-top: 6px;
      }
    `,
  ],
})
export class PendingReviewDialogComponent {
  readonly formatMm = formatMm;
  readonly formatStress = formatStress;

  /** 勾选的暂存 id */
  private readonly checked = signal<Set<string>>(new Set());
  readonly dropUnresolved = signal(false);

  constructor(
    private readonly dialogRef: MatDialogRef<PendingReviewDialogComponent>,
    @Inject(MAT_DIALOG_DATA) readonly data: PendingReviewData,
  ) {
    // 默认：数值一致组全采纳；冲突组也预选全部，由用户逐项取消
    const initial = new Set<string>();
    for (const group of data.groups) {
      if (group.status !== 'unresolved') for (const candidate of group.candidates) initial.add(candidate.id);
    }
    this.checked.set(initial);
  }

  readonly resolvableGroups = computed(() => this.data.groups.filter((group) => group.status !== 'unresolved'));
  readonly conflictGroups = computed(() => this.data.groups.filter((group) => group.status === 'conflict'));
  readonly readyGroups = computed(() => this.data.groups.filter((group) => group.status === 'ready'));
  readonly unresolvedGroups = computed(() => this.data.groups.filter((group) => group.status === 'unresolved'));

  isChecked(id: string): boolean {
    return this.checked().has(id);
  }

  toggle(id: string): void {
    const next = new Set(this.checked());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.checked.set(next);
  }

  selectAll(group: PendingGroup, value: boolean): void {
    const next = new Set(this.checked());
    for (const candidate of group.candidates) {
      if (value) next.add(candidate.id);
      else next.delete(candidate.id);
    }
    this.checked.set(next);
  }

  /** 同组内与某候选数值签名相同的其他记录（提示并列重复观测） */
  sameSignature(group: PendingGroup, id: string): boolean {
    const target = group.candidates.find((item) => item.id === id);
    if (!target) return false;
    return group.candidates.some(
      (item) =>
        item.id !== id &&
        valueSignature(item.displacementMm, item.stressMpa) ===
          valueSignature(target.displacementMm, target.stressMpa),
    );
  }

  acceptedCount(): number {
    return this.checked().size;
  }

  /** 每个可挂接分组至少保留一条，否则给出错误 */
  groupError(key: string): string {
    const group = this.data.groups.find((item) => item.key === key);
    if (!group || group.status === 'unresolved') return '';
    const kept = group.candidates.some((candidate) => this.checked().has(candidate.id));
    return kept ? '' : '该测点至少需保留一条读数，或整包放弃';
  }

  canConfirm(): boolean {
    return this.resolvableGroups().every((group) =>
      group.candidates.some((candidate) => this.checked().has(candidate.id)),
    );
  }

  confirm(): void {
    if (!this.canConfirm()) return;
    const acceptedPendingIds = [...this.checked()];
    const rejectedPendingIds: string[] = [];
    for (const group of this.data.groups) {
      for (const candidate of group.candidates) {
        if (group.status === 'unresolved') {
          if (this.dropUnresolved()) rejectedPendingIds.push(candidate.id);
        } else if (!this.checked().has(candidate.id)) {
          rejectedPendingIds.push(candidate.id);
        }
      }
    }
    const result: PendingReviewResult = {
      acceptedPendingIds,
      rejectedPendingIds,
      unresolvedDropped: this.dropUnresolved(),
    };
    this.dialogRef.close(result);
  }

  close(): void {
    this.dialogRef.close(null);
  }
}
