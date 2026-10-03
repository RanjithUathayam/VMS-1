import {
    ChangeDetectionStrategy, ChangeDetectorRef,
    Component, computed, inject, signal, OnInit
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { JoStatusService } from '../../services/jo-status.service';
import { AuthService } from '../../services/auth.service';
import { JoVendorNavigationService } from '../../services/jo-vendor-navigation.service';

declare const Swal: any;

// ── Types ──────────────────────────────────────────────────────
interface StageForm {
    fabricPreparation: number;
    remarks:           string;
}

interface LineGridRow { colour: string; displayColour: string; slive: string; sizes: Record<string, number>; total: number; }
interface LineGrid    { sizes: string[]; rows: LineGridRow[]; grandTotal: number; }

type StageKey = 'fabricPreparation' | 'fusingComponent' | 'sewingAssembly' |
                'finishingSewing' | 'qualityFinishing' | 'packingDispatch';

const STAGES: Array<{ key: StageKey; label: string; short: string; isLineEntry: boolean }> = [
    { key: 'fabricPreparation', label: 'Fabric Preparation',             short: 'Fabric',     isLineEntry: false },
    { key: 'fusingComponent',   label: 'Fusing & Component Preparation', short: 'Fusing',     isLineEntry: true  },
    { key: 'sewingAssembly',    label: 'Sewing Assembly',                 short: 'Sewing',     isLineEntry: true  },
    { key: 'finishingSewing',   label: 'Finishing Sewing',                short: 'Finishing',  isLineEntry: true  },
    { key: 'qualityFinishing',  label: 'Quality & Finishing',             short: 'Quality',    isLineEntry: true  },
    { key: 'packingDispatch',   label: 'Packing & Dispatch',              short: 'Packing',    isLineEntry: true  },
];

const LINE_STAGES = STAGES.filter(s => s.isLineEntry);

const STAGE_COLORS = ['#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#14B8A6', '#10B981'];

// Maps each stage key → the selectedJo() field that holds the PREVIOUS stage's completed qty
const PREV_STAGE_COL: Record<string, string> = {
    fusingComponent:  'FabricPreparation',
    sewingAssembly:   'FusingComponent',
    finishingSewing:  'SewingAssembly',
    qualityFinishing: 'FinishingSewing',
    packingDispatch:  'QualityFinishing',
};

const STAGE_LABELS: Record<string, string> = {
    fusingComponent:  'Fusing & Component',
    sewingAssembly:   'Sewing Assembly',
    finishingSewing:  'Finishing Sewing',
    qualityFinishing: 'Quality & Finishing',
    packingDispatch:  'Packing & Dispatch',
};

const DOC_TYPES = ['JO', 'PO', 'ST'];

const EMPTY_ENTRY: StageForm = { fabricPreparation: 0, remarks: '' };

@Component({
    standalone: true,
    imports: [CommonModule],
    selector: 'jo-status',
    templateUrl: './jo-status.component.html',
    styleUrls: ['./jo-status.component.css'],
    changeDetection: ChangeDetectionStrategy.OnPush
})
export class JoStatusComponent implements OnInit {

    private api          = inject(JoStatusService);
    private auth         = inject(AuthService);
    private cdr          = inject(ChangeDetectorRef);
    private joVendorNav  = inject(JoVendorNavigationService);

    currentUser   = this.auth.currentUser;
    joList        = this.api.joList;
    isListLoading = this.api.isListLoading;

    readonly stages      = STAGES;
    readonly lineStages  = LINE_STAGES;
    readonly stageColors = STAGE_COLORS;
    readonly docTypeList = DOC_TYPES;

    isVendor         = computed(() => this.currentUser()?.role === 'vendor');
    isAdminOrManager = computed(() => {
        const role = this.currentUser()?.role;
        return role === 'admin' || role === 'manager';
    });

    // ── Entry form ─────────────────────────────────────────
    showEntryForm   = signal(false);
    isCreating      = signal(false);
    createResult    = signal<{ status: number; message: string } | null>(null);
    entryVendorCode = signal('');
    entryVendorName = signal('');
    selectedDocType = signal('');
    docNumList      = signal<string[]>([]);
    docData         = signal<any[]>([]);
    selectedDocNum  = signal('');
    isFetchingDocs  = signal(false);
    fetchDocsError  = signal<string | null>(null);
    docNumSearch    = signal('');
    entryStageForm  = signal<StageForm>({ ...EMPTY_ENTRY });
    entryRemarks    = signal('');

    filteredDocNumList = computed(() => {
        const term = this.docNumSearch().toLowerCase().trim();
        const list = this.docNumList();
        return term ? list.filter(d => d.toLowerCase().includes(term)) : list;
    });

    groupSummary = computed(() => {
        const docNum = this.selectedDocNum();
        const data   = this.docData();
        if (!docNum || !data.length) return [];
        const filtered = data.filter(r => String(r.DocNum) === String(docNum));
        const map = new Map<string, number>();
        for (const r of filtered) {
            const grp = r.GroupName || 'General';
            map.set(grp, (map.get(grp) || 0) + (Number(r.PendingQty) || 0));
        }
        return Array.from(map.entries()).map(([name, qty]) => ({ name, qty }));
    });

    totalPendingQty = computed(() =>
        this.groupSummary().reduce((s, g) => s + g.qty, 0)
    );

    // Only fabric preparation qty is entered at creation time
    entryTotalStageQty = computed(() => this.entryStageForm().fabricPreparation || 0);

    entryIsOverQty = computed(() => {
        const pending = this.totalPendingQty();
        return pending > 0 && this.entryTotalStageQty() > pending;
    });

    entryProgressPct = computed(() => {
        const pending = this.totalPendingQty();
        if (!pending) return 0;
        return Math.min(100, Math.round((this.entryTotalStageQty() / pending) * 100));
    });

    entryCanSave = computed(() =>
        !!this.selectedDocNum() && !this.entryIsOverQty() && !this.isCreating()
    );

    // ── Stage update state (existing JO detail) ────────────
    selectedJo    = signal<any | null>(null);
    activeTab     = signal<'update' | 'history'>('update');
    historyRows   = signal<any[]>([]);
    isHistLoading = signal(false);

    // Stage 1 update
    stage1Qty       = signal(0);
    isSavingStage1  = signal(false);
    stage1Result    = signal<{ status: number; message: string } | null>(null);

    // Line entries for stages 2–6
    lineEntries          = signal<any[]>([]);
    isLoadingLineEntries = signal(false);

    // Line item reference grid
    joLineData          = signal<any[]>([]);
    isLoadingJoLineData = signal(false);
    showLineGrid        = signal(true);

    // Inline add-entry form (matrix)
    addEntryStage  = signal<string | null>(null);
    addLineNo      = signal('');
    addEntryTime   = signal('');
    addMatrixQty   = signal<Record<string, Record<string, number>>>({});
    isAddingEntry  = signal(false);
    addEntryResult = signal<{ status: number; message: string } | null>(null);
    isDeletingJoId = signal<number | null>(null);

    // ── Overview (admin/manager dashboard) ────────────────
    overviewStatusFilter = signal('');
    overviewCurrentPage  = signal(1);

    joStatus(row: any): 'Completed' | 'In Progress' | 'Pending' {
        const pd  = Number(row.PackingDispatch) || 0;
        const oq  = Number(row.OrderQty) || 0;
        if (pd > 0 && pd >= oq) return 'Completed';
        if ((Number(row.TotalStageQty) || 0) > 0) return 'In Progress';
        return 'Pending';
    }

    joCurrentStage(row: any): string {
        if (Number(row.PackingDispatch)   > 0) return 'Packing & Dispatch';
        if (Number(row.QualityFinishing)  > 0) return 'Quality & Finishing';
        if (Number(row.FinishingSewing)   > 0) return 'Finishing Sewing';
        if (Number(row.SewingAssembly)    > 0) return 'Sewing Assembly';
        if (Number(row.FusingComponent)   > 0) return 'Fusing & Component';
        if (Number(row.FabricPreparation) > 0) return 'Fabric Preparation';
        return 'Not Started';
    }

    joCompletedQty(row: any): number { return Number(row.PackingDispatch) || 0; }
    joPendingQty(row: any):   number {
        return Math.max(0, (Number(row.OrderQty) || 0) - (Number(row.PackingDispatch) || 0));
    }

    ovTotal      = computed(() => this.filteredList().length);
    ovInProgress = computed(() => this.filteredList().filter(r => this.joStatus(r) === 'In Progress').length);
    ovCompleted  = computed(() => this.filteredList().filter(r => this.joStatus(r) === 'Completed').length);
    ovPending    = computed(() => this.filteredList().filter(r => this.joStatus(r) === 'Pending').length);

    overviewFiltered = computed(() => {
        const filter = this.overviewStatusFilter();
        const list   = this.filteredList();
        return filter ? list.filter(r => this.joStatus(r) === filter) : list;
    });

    overviewTotalPages = computed(() =>
        Math.max(1, Math.ceil(this.overviewFiltered().length / this.pageSize))
    );

    overviewPaginatedList = computed(() => {
        const safePage = Math.min(this.overviewCurrentPage(), this.overviewTotalPages());
        const start    = (safePage - 1) * this.pageSize;
        return this.overviewFiltered().slice(start, start + this.pageSize);
    });

    overviewTotalPagesArray = computed(() =>
        Array.from({ length: this.overviewTotalPages() }, (_, i) => i + 1)
    );

    setOverviewStatusFilter(f: string): void {
        this.overviewStatusFilter.set(this.overviewStatusFilter() === f ? '' : f);
        this.overviewCurrentPage.set(1);
    }

    ovPreviousPage(): void { this.overviewCurrentPage.update(p => Math.max(1, p - 1)); }
    ovNextPage():     void { this.overviewCurrentPage.update(p => Math.min(this.overviewTotalPages(), p + 1)); }
    ovGoToPage(p: number): void { this.overviewCurrentPage.set(p); }

    // ── List / search ──────────────────────────────────────
    searchTerm  = signal('');
    currentPage = signal(1);
    readonly pageSize = 10;

    filteredList = computed(() => {
        const term = this.searchTerm().toLowerCase().trim();
        const list = this.joList();
        if (!term) return list;
        return list.filter(r =>
            String(r.JO_No      || '').toLowerCase().includes(term) ||
            String(r.VendorName || '').toLowerCase().includes(term) ||
            String(r.DocType    || '').toLowerCase().includes(term) ||
            String(r.DocNum     || '').toLowerCase().includes(term)
        );
    });

    totalPages = computed(() =>
        Math.max(1, Math.ceil(this.filteredList().length / this.pageSize))
    );

    paginatedList = computed(() => {
        const safePage = Math.min(this.currentPage(), this.totalPages());
        const start    = (safePage - 1) * this.pageSize;
        return this.filteredList().slice(start, start + this.pageSize);
    });

    totalPagesArray = computed(() =>
        Array.from({ length: this.totalPages() }, (_, i) => i + 1)
    );

    // ── Update form computed ───────────────────────────────
    // Total = stage 1 qty + sum of all line entries
    totalStageQty = computed(() => {
        const s1    = this.stage1Qty() || 0;
        const lines = this.lineEntries().reduce((sum: number, e: any) => sum + (e.Qty || 0), 0);
        return s1 + lines;
    });

    remaining = computed(() => {
        const jo = this.selectedJo();
        if (!jo) return 0;
        return Math.max(0, (jo.OrderQty || 0) - this.totalStageQty());
    });

    // Overall production progress is driven by Packing & Dispatch (final stage) qty
    progressPct = computed(() => {
        const jo = this.selectedJo();
        if (!jo || !jo.OrderQty) return 0;
        return Math.min(100, Math.round(((Number(jo.PackingDispatch) || 0) / jo.OrderQty) * 100));
    });

    isOverQty = computed(() => {
        const jo = this.selectedJo();
        if (!jo) return false;
        return this.totalStageQty() > (jo.OrderQty || 0);
    });

    // ── Vendor Entry ───────────────────────────────────────
    packingDispatchQty = computed(() => {
        const jo = this.selectedJo();
        return jo ? (Number(jo.PackingDispatch) || 0) : 0;
    });

    canCreateVendorEntry = computed(() => {
        const jo = this.selectedJo();
        if (!jo) return false;
        const pd = Number(jo.PackingDispatch) || 0;
        if (pd <= 0) return false;
        const prevQty = Number(jo.QualityFinishing) || 0;
        if (prevQty > 0 && pd > prevQty) return false;
        return true;
    });

    // ── Line item grids (colour × size matrix) ─────────────
    entryLineGrid = computed<LineGrid | null>(() => {
        const docNum = this.selectedDocNum();
        const data   = this.docData();
        if (!docNum || !data.length) return null;
        return this.buildLineGrid(data.filter((r: any) => String(r.DocNum) === String(docNum)));
    });

    updateLineGrid = computed<LineGrid | null>(() => {
        const data = this.joLineData();
        return data.length ? this.buildLineGrid(data) : null;
    });

    // Entries grouped by stage — computed so OnPush always re-renders on change
    readonly entriesByStage = computed<Record<string, any[]>>(() => {
        const all = this.lineEntries();
        return all.reduce((acc: Record<string, any[]>, e: any) => {
            const key = e.Stage || '';
            if (!acc[key]) acc[key] = [];
            acc[key].push(e);
            return acc;
        }, {});
    });

    stageEntries(stage: string): any[] {
        return this.entriesByStage()[stage] || [];
    }

    stageLineTotal(stage: string): number {
        return this.stageEntries(stage).reduce((s: number, e: any) => s + (e.Qty || 0), 0);
    }

    // Previous stage's completed qty (0 = previous stage has nothing completed yet)
    prevStageQty(stageKey: string): number {
        const jo  = this.selectedJo();
        const col = PREV_STAGE_COL[stageKey];
        return jo && col ? (Number(jo[col]) || 0) : 0;
    }

    prevStageLabel(stageKey: string): string {
        const idx = STAGES.findIndex(s => s.key === stageKey);
        return idx > 0 ? STAGES[idx - 1].label : '';
    }

    // Remaining capacity = prevStageQty − already-saved entries for this stage
    stageCapacityRemaining(stageKey: string): number {
        if (!PREV_STAGE_COL[stageKey]) return Infinity;
        return Math.max(0, this.prevStageQty(stageKey) - this.stageLineTotal(stageKey));
    }

    // ── Size-wise (colour × sleeve × size) limits ───────────
    // Apply from Sewing Assembly onward — Fusing's previous stage (Fabric) has no size breakdown.
    private cellKey(colour: any, slive: any, size: any): string {
        return [colour, slive, size].map(v => String(v ?? '').trim().toUpperCase()).join('|||');
    }

    // Saved qty per stage per colour/sleeve/size cell
    readonly stageCellTotals = computed<Record<string, Record<string, number>>>(() => {
        const out: Record<string, Record<string, number>> = {};
        for (const e of this.lineEntries()) {
            const m = out[e.Stage || ''] || (out[e.Stage || ''] = {});
            const k = this.cellKey(e.Colour, e.Slive, e.Size);
            m[k] = (m[k] || 0) + (Number(e.Qty) || 0);
        }
        return out;
    });

    isSizeWiseStage(stageKey: string): boolean {
        return STAGES.findIndex(s => s.key === stageKey) >= 2;
    }

    // Qty still available for this cell = previous stage's cell qty − this stage's saved cell qty
    cellAvailable(stageKey: string, row: LineGridRow, size: string): number {
        const idx = STAGES.findIndex(s => s.key === stageKey);
        if (idx < 2) return Infinity;
        const k      = this.cellKey(row.displayColour, row.slive, size);
        const totals = this.stageCellTotals();
        return Math.max(0, (totals[STAGES[idx - 1].key]?.[k] || 0) - (totals[stageKey]?.[k] || 0));
    }

    isCellOver(stageKey: string, row: LineGridRow, size: string): boolean {
        return this.getMatrixQty(row.colour, size) > this.cellAvailable(stageKey, row, size);
    }

    // Validation error for the current matrix input; null = OK
    matrixValidationError(stageKey: string, grid: LineGrid): string | null {
        const totalErr = this.matrixTotalError(stageKey, grid);
        if (totalErr) return totalErr;
        if (!this.isSizeWiseStage(stageKey)) return null;

        const over: string[] = [];
        for (const row of grid.rows) {
            for (const size of grid.sizes) {
                const qty = this.getMatrixQty(row.colour, size);
                if (!qty) continue;
                const avail = this.cellAvailable(stageKey, row, size);
                if (qty > avail) {
                    const label = [row.displayColour, row.slive, size].filter(Boolean).join(' / ');
                    over.push(`${label}: entered ${qty}, available ${avail}`);
                }
            }
        }
        if (!over.length) return null;
        return `Size-wise qty exceeds ${this.prevStageLabel(stageKey)} completed qty — ` +
               over.slice(0, 5).join('; ') + (over.length > 5 ? `; +${over.length - 5} more` : '') + '.';
    }

    private matrixTotalError(stageKey: string, grid: LineGrid): string | null {
        if (!PREV_STAGE_COL[stageKey]) return null;
        const prev = this.prevStageQty(stageKey);
        if (prev <= 0) {
            return `${this.prevStageLabel(stageKey)} has no completed qty yet. ` +
                   `Complete the previous stage before adding entries here.`;
        }
        const saved    = this.stageLineTotal(stageKey);
        const entering = this.matrixGrandTotal(grid);
        const total    = saved + entering;
        if (total > prev) {
            const allowed = Math.max(0, prev - saved);
            return `Entry total (${entering} pcs) exceeds available capacity. ` +
                   `${this.prevStageLabel(stageKey)} completed: ${prev} pcs, already saved: ${saved} pcs, ` +
                   `maximum you can add: ${allowed} pcs.`;
        }
        return null;
    }

    // Stage 1 must stay within Order Qty and not drop below Fusing's saved qty
    stage1ValidationError = computed<string | null>(() => {
        const jo = this.selectedJo();
        if (!jo) return null;
        const qty      = this.stage1Qty() || 0;
        const orderQty = Number(jo.OrderQty) || 0;
        const fusing   = Number(jo.FusingComponent) || 0;
        if (orderQty > 0 && qty > orderQty) {
            return `Fabric qty (${qty}) exceeds Order Qty (${orderQty}).`;
        }
        if (qty < fusing) {
            return `Fabric qty cannot be less than ${fusing} pcs — Fusing & Component Preparation already has ${fusing} pcs recorded.`;
        }
        return null;
    });

    // Deleting an entry must not leave its stage below the next stage's saved qty
    deleteValidationError(entryId: number, stageKey: string): string | null {
        const idx  = STAGES.findIndex(s => s.key === stageKey);
        const next = STAGES[idx + 1];
        if (!next) return null;
        const entry   = this.stageEntries(stageKey).find((e: any) => e.Id === entryId);
        const after   = this.stageLineTotal(stageKey) - (Number(entry?.Qty) || 0);
        const nextQty = this.stageLineTotal(next.key);
        if (after < nextQty) {
            return `${STAGES[idx].label} would drop to ${after} pcs, but ${next.label} already has ${nextQty} pcs recorded. ` +
                   `Delete ${next.label} entries first.`;
        }
        if (entry && this.isSizeWiseStage(next.key)) {
            const k         = this.cellKey(entry.Colour, entry.Slive, entry.Size);
            const totals    = this.stageCellTotals();
            const cellAfter = (totals[stageKey]?.[k] || 0) - (Number(entry.Qty) || 0);
            const cellNext  = totals[next.key]?.[k] || 0;
            if (cellAfter < cellNext) {
                const label = [entry.Colour, entry.Slive, entry.Size].filter(Boolean).join(' / ');
                return `${label}: ${STAGES[idx].label} would drop to ${cellAfter} pcs, but ${next.label} already has ` +
                       `${cellNext} pcs recorded for this colour/size. Delete ${next.label} entries first.`;
            }
        }
        return null;
    }

    // Stage label lookup (used in history tab)
    stageLabel(stage: string): string {
        return STAGE_LABELS[stage] || stage;
    }

    // Stage color by key (used in history tab)
    stageColorByKey(stage: string): string {
        const idx = STAGES.findIndex(s => s.key === stage);
        return idx >= 0 ? STAGE_COLORS[idx] : '#059669';
    }

    rowProgress(row: any): number {
        if (!row.OrderQty) return 0;
        return Math.min(100, Math.round(((row.TotalStageQty || 0) / row.OrderQty) * 100));
    }

    stageColorAt(idx: number): string { return STAGE_COLORS[idx] || '#059669'; }

    buildLineGrid(rows: any[]): LineGrid | null {
        if (!rows.length) return null;
        // colourMap key = composite "displayColour|||slive" to keep Full/Half Sleeve separate
        const colourMap  = new Map<string, Record<string, number>>();
        const metaMap    = new Map<string, { displayColour: string; slive: string }>();
        const sizeSet    = new Set<string>();
        for (const r of rows) {
            const displayColour = String(r.ItemColor || r.GroupName || '?').trim();
            const slive  = String(r.ItemSlive || '').trim();
            const colour = slive ? `${displayColour}|||${slive}` : displayColour;
            const size   = String(r.ItemSize  || '').trim();
            const qty    = Number(r.PendingQty ?? r.Quantity ?? 0);
            if (!metaMap.has(colour)) metaMap.set(colour, { displayColour, slive });
            if (!colourMap.has(colour)) colourMap.set(colour, {});
            if (size) {
                sizeSet.add(size);
                const m = colourMap.get(colour)!;
                m[size] = (m[size] || 0) + qty;
            }
        }
        const sizes = Array.from(sizeSet).sort((a, b) => {
            const na = +a, nb = +b;
            return !isNaN(na) && !isNaN(nb) ? na - nb : a.localeCompare(b);
        });
        const gridRows: LineGridRow[] = Array.from(colourMap.entries()).map(([colour, sMap]) => {
            const meta = metaMap.get(colour) || { displayColour: colour, slive: '' };
            return {
                colour,
                displayColour: meta.displayColour,
                slive:         meta.slive,
                sizes:         sMap,
                total:         Object.values(sMap).reduce((s: number, v: number) => s + v, 0),
            };
        });
        // Sort: colour ascending, then Full Sleeve before Half Sleeve
        const sliveRank = (s: string) => {
            const lower = s.toLowerCase();
            if (lower.includes('full')) return 0;
            if (lower.includes('half')) return 1;
            return 2;
        };
        gridRows.sort((a, b) => {
            const colCmp = a.displayColour.localeCompare(b.displayColour, undefined, { numeric: true, sensitivity: 'base' });
            return colCmp !== 0 ? colCmp : sliveRank(a.slive) - sliveRank(b.slive);
        });
        const grandTotal = gridRows.reduce((s, r) => s + r.total, 0);
        if (!sizes.length) return null;
        return { sizes, rows: gridRows, grandTotal };
    }

    colourSwatchBg(colour: string): string {
        // Extract numeric part of the colour code and spread hues using the golden angle
        // so sequential codes (20101, 20102, …) get maximally distinct colours
        const num = parseInt(colour.replace(/\D/g, ''), 10);
        if (isNaN(num)) {
            // fallback for non-numeric codes: djb2 hash
            let h = 5381;
            for (let i = 0; i < colour.length; i++) h = ((h << 5) + h) ^ colour.charCodeAt(i);
            return `hsl(${Math.abs(h) % 360},62%,42%)`;
        }
        const hue = Math.round((num * 137.508) % 360);
        return `hsl(${hue},62%,42%)`;
    }

    colSizeTotal(grid: LineGrid, size: string): number {
        return grid.rows.reduce((s, r) => s + (r.sizes[size] || 0), 0);
    }

    toggleLineGrid(): void { this.showLineGrid.set(!this.showLineGrid()); }

    getMatrixQty(colour: string, size: string): number {
        return this.addMatrixQty()[colour]?.[size] || 0;
    }

    setMatrixQty(colour: string, size: string, val: string): void {
        const qty = Math.max(0, parseInt(val, 10) || 0);
        const cur = this.addMatrixQty();
        this.addMatrixQty.set({
            ...cur,
            [colour]: { ...(cur[colour] || {}), [size]: qty }
        });
        this.cdr.markForCheck();
    }

    matrixRowTotal(colour: string): number {
        const row = this.addMatrixQty()[colour];
        if (!row) return 0;
        return Object.values(row).reduce((s, v) => s + v, 0);
    }

    matrixColTotal(grid: LineGrid, size: string): number {
        const m = this.addMatrixQty();
        return grid.rows.reduce((s, r) => s + (m[r.colour]?.[size] || 0), 0);
    }

    matrixGrandTotal(grid: LineGrid): number {
        const m = this.addMatrixQty();
        return grid.rows.reduce((total, r) => {
            const row = m[r.colour];
            return total + (row ? Object.values(row).reduce((s, v) => s + v, 0) : 0);
        }, 0);
    }

    // ── Lifecycle ──────────────────────────────────────────
    ngOnInit(): void { this.loadList(); }

    // ── List ───────────────────────────────────────────────
    async loadList(): Promise<void> {
        try { await this.api.fetchJoList(); }
        catch (err: any) {
            Swal.fire({ icon: 'error', title: 'Load Failed', text: err?.message || 'Could not fetch list' });
        }
        this.cdr.markForCheck();
    }

    async confirmDeleteJo(row: any, event: Event): Promise<void> {
        event.stopPropagation();
        const confirm = await Swal.fire({
            icon: 'warning',
            title: 'Delete JO?',
            html: `<b>${row.JO_No}</b> and all its stage entries will be permanently deleted.`,
            showCancelButton: true,
            confirmButtonColor: '#ef4444',
            confirmButtonText: 'Yes, Delete',
            cancelButtonText: 'Cancel',
        });
        if (!confirm.isConfirmed) return;

        this.isDeletingJoId.set(row.Id);
        this.cdr.markForCheck();
        try {
            const res: any = await this.api.deleteJo(row.Id);
            if (res?.status === 1) {
                if (this.selectedJo()?.Id === row.Id) this.clearSelection();
                await this.loadList();
            } else {
                Swal.fire({ icon: 'error', title: 'Delete Failed', text: res?.message || 'Could not delete JO' });
            }
        } catch (err: any) {
            Swal.fire({ icon: 'error', title: 'Error', text: err?.message || 'Delete failed' });
        } finally {
            this.isDeletingJoId.set(null);
            this.cdr.markForCheck();
        }
    }

    onSearch(term: string): void { this.searchTerm.set(term); this.currentPage.set(1); this.overviewCurrentPage.set(1); }
    previousPage(): void { this.currentPage.update(p => Math.max(1, p - 1)); }
    nextPage():     void { this.currentPage.update(p => Math.min(this.totalPages(), p + 1)); }
    goToPage(p: number): void { this.currentPage.set(p); }

    // ── Entry form ─────────────────────────────────────────
    toggleEntryForm(): void {
        const opening = !this.showEntryForm();
        this.showEntryForm.set(opening);
        this.createResult.set(null);
        if (opening) { this.resetEntryForm(); }
    }

    resetEntryForm(): void {
        const u = this.currentUser();
        this.entryVendorCode.set(this.isVendor() ? (u?.partyCode || '') : '');
        this.entryVendorName.set(this.isVendor() ? (u?.name      || '') : '');
        this.selectedDocType.set('');
        this.docNumList.set([]);
        this.docData.set([]);
        this.selectedDocNum.set('');
        this.fetchDocsError.set(null);
        this.isFetchingDocs.set(false);
        this.entryStageForm.set({ ...EMPTY_ENTRY });
        this.entryRemarks.set('');
        this.docNumSearch.set('');
    }

    selectDocType(dt: string): void {
        this.selectedDocType.set(dt);
        this.docNumList.set([]);
        this.docData.set([]);
        this.selectedDocNum.set('');
        this.fetchDocsError.set(null);
        this.entryStageForm.set({ ...EMPTY_ENTRY });
    }

    async loadDocuments(): Promise<void> {
        const docType   = this.selectedDocType();
        const partyCode = this.isVendor()
            ? (this.currentUser()?.partyCode || '')
            : this.entryVendorCode().trim();

        if (!docType) { this.fetchDocsError.set('Please select a document type first.'); return; }
        if (!partyCode) { this.fetchDocsError.set('Please enter a vendor code first.'); return; }

        this.isFetchingDocs.set(true);
        this.fetchDocsError.set(null);
        this.docNumList.set([]);
        this.docData.set([]);
        this.selectedDocNum.set('');
        this.docNumSearch.set('');
        this.cdr.markForCheck();

        try {
            const res: any = await this.api.fetchDocumentsByParty(docType, partyCode);
            if (res?.status) {
                this.docNumList.set(res.DocNumList || []);
                this.docData.set(res.data || []);
                if (!(res.DocNumList?.length)) {
                    this.fetchDocsError.set(`No ${docType} documents found for this vendor.`);
                }
            } else {
                this.fetchDocsError.set('Failed to load documents. Please try again.');
            }
        } catch (err: any) {
            this.fetchDocsError.set(err?.message || 'Error loading documents.');
        } finally {
            this.isFetchingDocs.set(false);
            this.cdr.markForCheck();
        }
    }

    selectDocNum(docNum: string): void {
        this.selectedDocNum.set(this.selectedDocNum() === docNum ? '' : docNum);
        this.entryStageForm.set({ ...EMPTY_ENTRY });
    }

    updateEntryFabricQty(value: string): void {
        const num = Math.max(0, parseInt(value, 10) || 0);
        this.entryStageForm.update(f => ({ ...f, fabricPreparation: num }));
    }

    stageBarPct(stage: string): number {
        const pending = this.totalPendingQty();
        if (!pending) return 0;
        const val = stage === 'fabricPreparation' ? (this.entryStageForm().fabricPreparation || 0) : 0;
        return Math.min(100, Math.round((val / pending) * 100));
    }

    async createJoEntry(): Promise<void> {
        if (!this.selectedDocType() || !this.selectedDocNum()) {
            Swal.fire({ icon: 'warning', title: 'Incomplete', text: 'Please select a document type and number.' });
            return;
        }

        if (this.entryIsOverQty()) {
            Swal.fire({ icon: 'warning', title: 'Over Quantity',
                text: `Fabric qty (${this.entryTotalStageQty()}) exceeds pending qty (${this.totalPendingQty()}).` });
            return;
        }

        const u         = this.currentUser();
        const partyCode = this.isVendor() ? (u?.partyCode || '') : this.entryVendorCode().trim();
        const partyName = this.isVendor() ? (u?.name      || '') : this.entryVendorName().trim();

        if (!partyCode) {
            Swal.fire({ icon: 'warning', title: 'Required', text: 'Vendor code is required.' });
            return;
        }

        const { isConfirmed } = await Swal.fire({
            icon: 'question',
            title: 'Save JO Status Entry?',
            html: `<b>Doc:</b> ${this.selectedDocType()} – ${this.selectedDocNum()}<br>
                   <b>Vendor:</b> ${partyName || partyCode}<br>
                   <b>Fabric Qty:</b> ${this.entryTotalStageQty()} / ${this.totalPendingQty()} pcs`,
            showCancelButton: true,
            confirmButtonText: 'Save',
            cancelButtonText:  'Cancel',
            confirmButtonColor: '#059669'
        });
        if (!isConfirmed) return;

        this.isCreating.set(true);
        this.createResult.set(null);

        try {
            const f   = this.entryStageForm();
            const res: any = await this.api.createJo({
                docType:           this.selectedDocType(),
                docNum:            this.selectedDocNum(),
                vendorCode:        partyCode,
                vendorName:        partyName,
                orderQty:          this.totalPendingQty() || this.entryTotalStageQty() || 1,
                entryDate:         new Date().toISOString().slice(0, 10),
                createdBy:         u?.name || 'System',
                fabricPreparation: f.fabricPreparation,
                remarks:           this.entryRemarks(),
            });

            const ok = res?.status === 1;
            this.createResult.set({
                status:  res?.status ?? 0,
                message: res?.message || (ok ? 'Entry saved successfully' : 'Save failed')
            });

            if (ok) {
                await this.loadList();
                setTimeout(() => {
                    if (this.createResult()?.status === 1) {
                        this.showEntryForm.set(false);
                        this.createResult.set(null);
                    }
                    this.cdr.markForCheck();
                }, 1800);
            }
        } catch (err: any) {
            this.createResult.set({ status: 0, message: err?.message || 'An unexpected error occurred' });
        } finally {
            this.isCreating.set(false);
            this.cdr.markForCheck();
        }
    }

    // ── JO selection ───────────────────────────────────────
    selectJo(row: any): void {
        this.selectedJo.set({ ...row });
        this.activeTab.set('update');
        this.historyRows.set([]);
        this.stage1Qty.set(row.FabricPreparation || 0);
        this.stage1Result.set(null);
        this.lineEntries.set([]);
        this.addEntryStage.set(null);
        this.addEntryResult.set(null);
        this.joLineData.set([]);
        this.showLineGrid.set(true);
        this.loadLineEntries(row.Id);
        this.loadJoLineData(row);
        this.cdr.markForCheck();
    }

    clearSelection(): void {
        this.selectedJo.set(null);
        this.historyRows.set([]);
        this.stage1Result.set(null);
        this.stage1Qty.set(0);
        this.lineEntries.set([]);
        this.addEntryStage.set(null);
        this.addEntryResult.set(null);
        this.addMatrixQty.set({});
        this.joLineData.set([]);
        this.showLineGrid.set(true);
    }

    setTab(tab: 'update' | 'history'): void {
        this.activeTab.set(tab);
        if (tab === 'history') this.loadHistory();
    }

    async loadJoLineData(jo: any): Promise<void> {
        const vendorCode = jo.VendorCode;
        const docType    = jo.DocType;
        if (!vendorCode || !docType) return;
        this.isLoadingJoLineData.set(true);
        this.cdr.markForCheck();
        try {
            const res: any = await this.api.fetchDocumentsByParty(docType, vendorCode);
            const joNo     = String(jo.JO_No);
            const filtered = (res?.data || []).filter((r: any) => String(r.DocNum) === joNo);
            this.joLineData.set(filtered);
        } catch {
            this.joLineData.set([]);
        } finally {
            this.isLoadingJoLineData.set(false);
            this.cdr.markForCheck();
        }
    }

    async loadHistory(): Promise<void> {
        const jo = this.selectedJo();
        if (!jo) return;
        this.isHistLoading.set(true);
        this.cdr.markForCheck();
        try {
            const res: any = await this.api.fetchHistory(jo.Id);
            this.historyRows.set(res?.data || []);
        } catch {
            this.historyRows.set([]);
        } finally {
            this.isHistLoading.set(false);
            this.cdr.markForCheck();
        }
    }

    // ── Stage 1 save ───────────────────────────────────────
    async saveStage1Qty(): Promise<void> {
        const jo = this.selectedJo();
        if (!jo) return;

        const s1Err = this.stage1ValidationError();
        if (s1Err) {
            Swal.fire({ icon: 'warning', title: 'Invalid Quantity', text: s1Err });
            return;
        }

        this.isSavingStage1.set(true);
        this.stage1Result.set(null);
        this.cdr.markForCheck();

        try {
            const res: any = await this.api.saveStage1({
                joId:      jo.Id,
                joNo:      jo.JO_No,
                qty:       this.stage1Qty(),
                updatedBy: this.currentUser()?.name || 'System',
            });

            this.stage1Result.set({
                status:  res?.status ?? 0,
                message: res?.message || (res?.status === 1 ? 'Saved' : 'Save failed'),
            });

            if (res?.status === 1) {
                await this.loadList();
                const updated = this.joList().find((j: any) => j.Id === jo.Id);
                if (updated) this.selectedJo.set({ ...updated });
            }
        } catch (err: any) {
            this.stage1Result.set({ status: 0, message: err?.error?.message || err?.message || 'Error saving' });
        } finally {
            this.isSavingStage1.set(false);
            this.cdr.markForCheck();
        }
    }

    // ── Line entries ───────────────────────────────────────
    async loadLineEntries(joId: number): Promise<void> {
        this.isLoadingLineEntries.set(true);
        this.cdr.markForCheck();
        try {
            const res: any = await this.api.getLineEntries(joId);
            this.lineEntries.set(res?.data || []);
        } catch {
            this.lineEntries.set([]);
        } finally {
            this.isLoadingLineEntries.set(false);
            this.cdr.markForCheck();
        }
    }

    startAddEntry(stage: string): void {
        this.addEntryStage.set(stage);
        this.addLineNo.set('');
        this.addEntryTime.set('');
        this.addMatrixQty.set({});
        this.addEntryResult.set(null);
        this.cdr.markForCheck();
    }

    cancelAddEntry(): void {
        this.addEntryStage.set(null);
        this.addEntryResult.set(null);
        this.addMatrixQty.set({});
        this.cdr.markForCheck();
    }

    async submitMatrixEntry(stage: string): Promise<void> {
        const jo   = this.selectedJo();
        const grid = this.updateLineGrid();
        if (!jo) return;

        if (!grid) {
            Swal.fire({ icon: 'warning', text: 'Order detail not loaded. Please wait and try again.' });
            return;
        }

        // Stage-to-previous validation
        const validationErr = this.matrixValidationError(stage, grid);
        if (validationErr) {
            Swal.fire({
                icon: 'error',
                title: 'Quantity Limit Exceeded',
                text: validationErr,
                confirmButtonColor: '#6366f1',
            });
            return;
        }

        const entries: Array<{ colour: string; slive: string; size: string; qty: number }> = [];
        const m = this.addMatrixQty();
        for (const row of grid.rows) {
            for (const size of grid.sizes) {
                const qty = m[row.colour]?.[size] || 0;
                if (qty > 0) entries.push({ colour: row.displayColour, slive: row.slive, size, qty });
            }
        }

        if (!entries.length) {
            Swal.fire({ icon: 'warning', text: 'Please enter at least one quantity.' });
            return;
        }

        this.isAddingEntry.set(true);
        this.addEntryResult.set(null);
        this.cdr.markForCheck();

        try {
            const res: any = await this.api.saveMatrixEntries({
                joId:      jo.Id,
                stage,
                lineNo:    this.addLineNo().trim(),
                entryTime: this.addEntryTime(),
                createdBy: this.currentUser()?.name || 'System',
                entries,
            });

            if (res?.status === 1) {
                await this.loadLineEntries(jo.Id);
                await this.loadList();
                const updated = this.joList().find((j: any) => j.Id === jo.Id);
                if (updated) this.selectedJo.set({ ...updated });

                this.addMatrixQty.set({});
                this.addLineNo.set('');
                this.addEntryTime.set('');
                this.addEntryResult.set({
                    status: 1,
                    message: `${entries.length} colour-size entries saved — Total: ${entries.reduce((s, e) => s + e.qty, 0)} pcs`
                });
            } else {
                this.addEntryResult.set({ status: 0, message: res?.message || 'Failed to save entries' });
            }
        } catch (err: any) {
            this.addEntryResult.set({ status: 0, message: err?.error?.message || err?.message || 'Error saving entries' });
        } finally {
            this.isAddingEntry.set(false);
            this.cdr.markForCheck();
        }
    }

    async removeLineEntry(entryId: number, stage: string): Promise<void> {
        const jo = this.selectedJo();
        if (!jo) return;

        const delErr = this.deleteValidationError(entryId, stage);
        if (delErr) {
            Swal.fire({ icon: 'warning', title: 'Cannot Delete Entry', text: delErr });
            return;
        }

        const { isConfirmed } = await Swal.fire({
            icon: 'warning',
            title: 'Delete this entry?',
            text: 'This action cannot be undone.',
            showCancelButton: true,
            confirmButtonText: 'Delete',
            cancelButtonText: 'Cancel',
            confirmButtonColor: '#dc2626',
        });
        if (!isConfirmed) return;

        try {
            const res: any = await this.api.deleteLineEntry(entryId, jo.Id, stage);
            if (res?.status === 1) {
                await this.loadLineEntries(jo.Id);
                await this.loadList();
                const updated = this.joList().find((j: any) => j.Id === jo.Id);
                if (updated) this.selectedJo.set({ ...updated });
            } else {
                Swal.fire({ icon: 'error', text: res?.message || 'Delete failed' });
            }
        } catch (err: any) {
            Swal.fire({ icon: 'error', text: err?.error?.message || err?.message || 'Error deleting entry' });
        }
        this.cdr.markForCheck();
    }

    // Returns the completed qty for a stage from the selected JO row
    stageCompletedQty(stageKey: string): number {
        const jo = this.selectedJo();
        if (!jo) return 0;
        const colMap: Record<string, string> = {
            fabricPreparation: 'FabricPreparation',
            fusingComponent:   'FusingComponent',
            sewingAssembly:    'SewingAssembly',
            finishingSewing:   'FinishingSewing',
            qualityFinishing:  'QualityFinishing',
            packingDispatch:   'PackingDispatch',
        };
        return Number(jo[colMap[stageKey]]) || 0;
    }

    navigateToVendorEntry(): void {
        const jo = this.selectedJo();
        if (!jo) return;
        const packingEntries = this.lineEntries()
            .filter((e: any) => e.Stage === 'packingDispatch')
            .map((e: any) => ({
                colour: e.Colour || '',
                slive:  e.Slive  || '',
                size:   e.Size   || '',
                qty:    e.Qty    || 0,
            }));
        this.joVendorNav.navigateToVendorEntry({
            docType:        jo.DocType    || 'JO',
            partyCode:      jo.VendorCode || '',
            partyName:      jo.VendorName || '',
            docNumber:      jo.JO_No      || '',
            packingEntries,
        });
    }

    refresh(): void {
        this.clearSelection();
        this.searchTerm.set('');
        this.currentPage.set(1);
        this.showEntryForm.set(false);
        this.loadList();
    }

    str(v: any): string { return v == null ? '' : String(v); }
}
