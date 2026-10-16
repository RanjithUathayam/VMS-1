import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { QcService, apiError } from '../../services/qc.service';
import { QcInspection, QcListFilter, QcMeta, QcSummary } from '../../models/qc.model';
import { INSPECTION_TYPES } from '../../utils/qc-rules';
import { fmtDate, qcResultClass, qcStatusClass } from '../../utils/qc-print';
import { QcReportViewerComponent } from './qc-report-viewer.component';
import { QcNavigationService } from '../../services/qc-navigation.service';

declare const Swal: any;

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const defaultFilter = (): QcListFilter => {
    const now = new Date();
    return {
        fromDate: iso(new Date(now.getFullYear(), now.getMonth(), 1)), toDate: iso(now),
        supplier: '', brand: '', style: '', dcNo: '', docNum: '', inspector: '',
        inspectionType: '', finalResult: '', status: '', search: '',
    };
};
const EXPORT_LIMIT = 5000;

/** QC Report: search historical inspections, summary, CSV export, and printable individual reports. */
@Component({
    standalone: true,
    selector: 'qc-report',
    imports: [CommonModule, QcReportViewerComponent],
    templateUrl: './qc-report.component.html',
    styleUrls: ['../qc-inspection/qc-shared.css'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QcReportComponent implements OnInit {
    private qc = inject(QcService);
    private qcNav = inject(QcNavigationService);

    readonly inspectionTypes = INSPECTION_TYPES;
    readonly fmtDate = fmtDate;
    readonly statusClass = qcStatusClass;
    readonly resultClass = qcResultClass;
    readonly pageSize = 50;

    meta = signal<QcMeta | null>(null);
    filter = signal<QcListFilter>(defaultFilter());
    rows = signal<QcInspection[]>([]);
    total = signal(0);
    page = signal(1);
    summary = signal<QcSummary | null>(null);
    loading = signal(false);
    exporting = signal(false);
    error = signal('');
    viewerId = signal<number | null>(null);

    totalPages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize)));
    rates = computed(() => {
        const s = this.summary();
        const decided = s ? s.pass + s.fail + s.derogation : 0;
        const pct = (n: number) => (decided ? Math.round((n / decided) * 1000) / 10 : 0);
        return { decided, pass: pct(s?.pass || 0), fail: pct(s?.fail || 0), derogation: pct(s?.derogation || 0) };
    });

    async ngOnInit(): Promise<void> {
        try { this.meta.set(await this.qc.getMeta()); }
        catch (err) { this.error.set(apiError(err, 'Failed to load the QC module.').message); return; }
        await this.load(1);
    }

    setFilter(key: keyof QcListFilter, value: string): void {
        this.filter.update(f => ({ ...f, [key]: value }));
    }

    apply(): void {
        const f = this.filter();
        if (f.fromDate && f.toDate && f.fromDate > f.toDate) {
            Swal.fire({ icon: 'warning', title: 'Invalid date range', text: 'From date must be on or before To date.' });
            return;
        }
        this.load(1);
    }

    reset(): void {
        this.filter.set(defaultFilter());
        this.load(1);
    }

    /** Clicking a summary tile narrows the list to that result / status. */
    quickFilter(key: 'finalResult' | 'status', value: string): void {
        this.filter.update(f => ({ ...f, finalResult: '', status: '', [key]: value }));
        this.load(1);
    }

    async load(page: number): Promise<void> {
        this.loading.set(true);
        this.error.set('');
        try {
            const res = await this.qc.list({ ...this.filter(), page, pageSize: this.pageSize });
            this.rows.set(res.data || []);
            this.total.set(res.total || 0);
            this.summary.set(res.summary || null);
            this.page.set(page);
        } catch (err) {
            this.error.set(apiError(err, 'Failed to load QC reports.').message);
        } finally {
            this.loading.set(false);
        }
    }

    /** Exports every record matching the current filters (up to 5,000) as an Excel-compatible CSV. */
    async exportCsv(): Promise<void> {
        this.exporting.set(true);
        try {
            const res = await this.qc.list({ ...this.filter(), page: 1, pageSize: EXPORT_LIMIT });
            const data = res.data || [];
            if (!data.length) { Swal.fire({ icon: 'info', title: 'Nothing to export', text: 'No reports match the current filters.' }); return; }

            const cols: Array<[string, (r: QcInspection) => unknown]> = [
                ['Report No', r => r.reportNo], ['Inspection Date', r => fmtDate(r.inspectionDate)], ['Inspection Type', r => r.inspectionType],
                ['Doc Type', r => r.docType], ['Doc No', r => r.docNum], ['Supplier', r => r.supplierName], ['Brand', r => r.brandName], ['Style', r => r.styleName],
                ['Colours', r => r.colours], ['DC No', r => r.dcNo], ['Sizes', r => r.sizes],
                ['Order Qty', r => r.orderQty], ['Lot Qty', r => r.lotQty], ['Inspected Qty', r => r.inspectedQty], ['Unit', r => r.measurementUnit],
                ['Inspection Level', r => r.inspectionLevel], ['Code Letter', r => r.codeLetter], ['Sample Size', r => r.sampleSize],
                ['Major AQL', r => r.aqlMajor], ['Major Found', r => r.totalMajor], ['Major Ac', r => r.majorAc], ['Major Re', r => r.majorRe], ['Major Result', r => r.majorResult],
                ['Minor AQL', r => r.aqlMinor], ['Minor Found', r => r.totalMinor], ['Minor Ac', r => r.minorAc], ['Minor Re', r => r.minorRe], ['Minor Result', r => r.minorResult],
                ['Measurement Audit', r => r.measurementResult], ['Packing Audit', r => r.packingResult],
                ['System Result', r => r.systemResult], ['Final Result', r => r.finalResult],
                ['QC Inspector', r => r.inspectorName], ['Status', r => r.status], ['Approved/Reviewed By', r => r.approvedBy],
            ];
            const cell = (v: unknown) => {
                let s = v === null || v === undefined ? '' : String(v);
                if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;   // block spreadsheet formula injection
                return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            };
            const lines = [cols.map(c => cell(c[0])).join(','), ...data.map(r => cols.map(c => cell(c[1](r))).join(','))];
            const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            const f = this.filter();
            a.href = url;
            a.download = `QC_Report_${f.fromDate || 'all'}_to_${f.toDate || 'all'}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            if ((res.total || 0) > data.length) {
                Swal.fire({ icon: 'info', title: 'Export truncated', text: `Exported the first ${data.length} of ${res.total} reports. Narrow the filters to export the rest.` });
            }
        } catch (err) {
            Swal.fire({ icon: 'error', title: 'Export failed', text: apiError(err).message });
        } finally {
            this.exporting.set(false);
        }
    }

    openViewer(id: number): void { this.viewerId.set(id); }
    closeViewer(): void { this.viewerId.set(null); }

    onEditRequested(id: number): void {
        this.viewerId.set(null);
        this.qcNav.openForEdit(id);
    }
}
