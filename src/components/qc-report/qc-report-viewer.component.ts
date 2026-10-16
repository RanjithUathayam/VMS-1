import {
    ChangeDetectionStrategy, Component, ElementRef, EventEmitter, Input, OnInit, Output,
    ViewChild, computed, inject, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { QcService, apiError } from '../../services/qc.service';
import { QcInspection, QcMeta } from '../../models/qc.model';
import { buildQcReportHtml } from '../../utils/qc-print';

declare const Swal: any;

/** Modal showing one Final Inspection report exactly as it prints, with Print/PDF and approval actions. */
@Component({
    standalone: true,
    selector: 'qc-report-viewer',
    imports: [CommonModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
<div class="fixed inset-0 z-[1500] bg-slate-900/60 flex items-center justify-center p-2 sm:p-4" (click)="close()">
  <div class="bg-white rounded-xl shadow-2xl w-full max-w-5xl h-[94vh] flex flex-col overflow-hidden" (click)="$event.stopPropagation()">
    <div class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b bg-slate-50">
      <div class="min-w-0">
        <h3 class="font-bold text-slate-800 truncate">Final Inspection Report {{ record()?.reportNo || '' }}</h3>
        @if (record(); as r) {
          <p class="text-xs text-slate-500 truncate">{{ r.styleName }} · DC {{ r.dcNo }} · {{ r.supplierName }}</p>
        }
      </div>
      <div class="flex flex-wrap items-center gap-2">
        @if (canEditRecord()) {
          <button class="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-100" (click)="edit.emit(record()!.id)">Edit</button>
        }
        <button class="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50"
                [disabled]="!html()" (click)="print()" title="Print, or choose 'Save as PDF' in the print dialog">Print / PDF</button>
        <button class="px-3 py-1.5 rounded-lg text-slate-500 hover:bg-slate-200 text-sm" (click)="close()" aria-label="Close">&#x2715;</button>
      </div>
    </div>

    @if (canDecide()) {
      <div class="px-4 py-3 border-b bg-amber-50 flex flex-col sm:flex-row gap-2 sm:items-end">
        <div class="flex-1">
          <label class="block text-xs font-semibold text-amber-900 mb-1">Approval remarks <span class="font-normal">(required to reject)</span></label>
          <input class="w-full rounded-lg border border-amber-300 px-3 py-1.5 text-sm" maxlength="1000"
                 [value]="remarks()" (input)="remarks.set($any($event.target).value)" placeholder="e.g. Derogation accepted for this lot only" />
        </div>
        <div class="flex gap-2">
          <button class="px-4 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50"
                  [disabled]="busy()" (click)="decide('APPROVE')">Approve</button>
          <button class="px-4 py-1.5 rounded-lg bg-rose-600 text-white text-sm font-semibold hover:bg-rose-700 disabled:opacity-50"
                  [disabled]="busy()" (click)="decide('REJECT')">Reject</button>
        </div>
      </div>
    }

    <div class="flex-1 bg-slate-200 overflow-hidden">
      @if (error()) {
        <div class="m-6 p-4 rounded-lg bg-rose-50 text-rose-800 text-sm">{{ error() }}</div>
      } @else if (!html()) {
        <div class="h-full flex items-center justify-center text-slate-500 text-sm">Loading report…</div>
      } @else {
        <iframe #frame class="w-full h-full bg-white" [srcdoc]="html()" title="Final Inspection Report preview"></iframe>
      }
    </div>
  </div>
</div>`,
})
export class QcReportViewerComponent implements OnInit {
    @Input({ required: true }) inspectionId!: number;
    @Output() closed = new EventEmitter<void>();
    @Output() edit = new EventEmitter<number>();
    @Output() changed = new EventEmitter<QcInspection>();
    @ViewChild('frame') frame?: ElementRef<HTMLIFrameElement>;

    private qc = inject(QcService);
    private sanitizer = inject(DomSanitizer);

    record = signal<QcInspection | null>(null);
    meta = signal<QcMeta | null>(null);
    html = signal<SafeHtml | null>(null);
    error = signal('');
    remarks = signal('');
    busy = signal(false);
    private photos: any[] = [];

    canDecide = computed(() => !!this.meta()?.permissions.canApprove && this.record()?.status === 'SUBMITTED');
    canEditRecord = computed(() => !!this.meta()?.permissions.canEdit && ['DRAFT', 'REJECTED'].includes(this.record()?.status || ''));

    async ngOnInit(): Promise<void> {
        try {
            const [meta, record, photos] = await Promise.all([
                this.qc.getMeta(), this.qc.getDetail(this.inspectionId), this.qc.getPhotos(this.inspectionId),
            ]);
            this.meta.set(meta);
            this.photos = photos;
            this.render(record);
        } catch (err) {
            this.error.set(apiError(err, 'Failed to load the report.').message);
        }
    }

    private render(record: QcInspection): void {
        this.record.set(record);
        // Safe: buildQcReportHtml escapes every value it interpolates.
        this.html.set(this.sanitizer.bypassSecurityTrustHtml(buildQcReportHtml(record, this.meta()?.defectMaster || [], this.photos)));
    }

    print(): void {
        this.frame?.nativeElement.contentWindow?.print();
    }

    async decide(decision: 'APPROVE' | 'REJECT'): Promise<void> {
        const r = this.record();
        if (!r) return;
        if (decision === 'REJECT' && !this.remarks().trim()) {
            Swal.fire({ icon: 'warning', title: 'Remarks required', text: 'Enter the reason for rejecting this report.' });
            return;
        }
        const ok = await Swal.fire({
            icon: 'question', showCancelButton: true,
            title: decision === 'APPROVE' ? `Approve ${r.reportNo}?` : `Reject ${r.reportNo}?`,
            text: decision === 'APPROVE'
                ? `Final result: ${r.finalResult}. Approved reports are locked.`
                : 'The report goes back to the inspector for correction.',
            confirmButtonText: decision === 'APPROVE' ? 'Approve' : 'Reject',
        });
        if (!ok.isConfirmed) return;
        this.busy.set(true);
        try {
            const res = await this.qc.decide(r.id, decision, this.remarks().trim(), r.rowVersion);
            this.render(res.data);
            this.remarks.set('');
            this.changed.emit(res.data);
            Swal.fire({ icon: 'success', title: res.message, timer: 1800, showConfirmButton: false });
        } catch (err) {
            Swal.fire({ icon: 'error', title: 'Not updated', text: apiError(err).message });
        } finally {
            this.busy.set(false);
        }
    }

    close(): void {
        this.closed.emit();
    }
}
