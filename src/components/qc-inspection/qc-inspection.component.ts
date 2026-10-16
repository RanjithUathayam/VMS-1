import {
    ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { QcService, apiError } from '../../services/qc.service';
import { AuthService } from '../../services/auth.service';
import { DefectCategory, QcDefectLine, QcForm, QcInspection, QcMeta, QcParty, QcPhoto, QcSourceDoc, QcStatus } from '../../models/qc.model';
import {
    AQL_VALUES, DEFAULTS, INSPECTION_LEVELS, INSPECTION_TYPES, MEASUREMENT_UNITS,
    allowedFinalResults, evaluateInspection, mergeDefects, validateInspection,
} from '../../utils/qc-rules';
import { fmtDate, qcResultClass, qcStatusClass } from '../../utils/qc-print';
import { QcReportViewerComponent } from '../qc-report/qc-report-viewer.component';
import { QcNavigationService } from '../../services/qc-navigation.service';

declare const Swal: any;

const todayIso = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const newToken = () => (crypto as any).randomUUID ? (crypto as any).randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const MAX_PHOTO_EDGE = 1600;
const MAX_PHOTO_BYTES = 1.4 * 1024 * 1024;

type TextKey = 'supplierCode' | 'supplierName' | 'brandName' | 'styleName' | 'colours' | 'dcNo' | 'sizes'
    | 'inspectionDate' | 'inspectionType' | 'measurementUnit' | 'inspectionLevel' | 'measurementResult'
    | 'measurementComments' | 'packingResult' | 'packingComments' | 'finalResult' | 'faultDescription'
    | 'defectComments' | 'finalRemarks' | 'inspectorName' | 'unitIncharge' | 'merchandiser' | 'amqc' | 'gm';
type NumKey = 'orderQty' | 'lotQty' | 'inspectedQty' | 'aqlMajor' | 'aqlMinor';

/** QC Checking screen: list of inspections + Final Inspection entry form (FI REPORT sheet). */
@Component({
    standalone: true,
    selector: 'qc-inspection',
    imports: [CommonModule, QcReportViewerComponent],
    templateUrl: './qc-inspection.component.html',
    styleUrls: ['./qc-shared.css'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QcInspectionComponent implements OnInit {
    private qc = inject(QcService);
    private auth = inject(AuthService);
    private qcNav = inject(QcNavigationService);

    readonly inspectionTypes = INSPECTION_TYPES;
    readonly units = MEASUREMENT_UNITS;
    readonly levels = INSPECTION_LEVELS;
    readonly aqlValues = AQL_VALUES;
    readonly categories: Array<{ key: DefectCategory; label: string }> = [
        { key: 'STITCHING', label: 'Stitching Defects' },
        { key: 'APPEARANCE', label: 'Appearance Defects' },
    ];
    readonly fmtDate = fmtDate;
    readonly statusClass = qcStatusClass;
    readonly resultClass = qcResultClass;

    meta = signal<QcMeta | null>(null);
    loadError = signal('');
    view = signal<'list' | 'form'>('list');
    viewerId = signal<number | null>(null);

    // ── List ───────────────────────────────────────────────
    rows = signal<QcInspection[]>([]);
    total = signal(0);
    page = signal(1);
    readonly pageSize = 25;
    listLoading = signal(false);
    search = signal('');
    statusFilter = signal('');
    totalPages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize)));

    // ── Form ───────────────────────────────────────────────
    form = signal<QcForm>(this.blankForm());
    record = signal<{ id: number; reportNo: string; status: QcStatus; rowVersion: string | null; approvalRemarks: string | null; approvedBy: string | null } | null>(null);
    clientToken = signal(newToken());
    saving = signal(false);
    errors = signal<string[]>([]);
    dirty = signal(false);
    lotTouched = signal(false);

    // Source document from [@ASRS_Transaction] @type = 'Binning' (Doc Type → Supplier → Doc No)
    readonly docTypes = ['JO', 'PO', 'ST'];
    parties = signal<QcParty[]>([]);
    partiesLoading = signal(false);
    documents = signal<QcSourceDoc[]>([]);
    docsLoading = signal(false);
    docsError = signal('');
    isVendor = computed(() => this.auth.currentUser()?.role === 'vendor');
    selectedDoc = computed(() => this.documents().find(d => d.docNum === this.form().docNum) || null);

    photos = signal<QcPhoto[]>([]);
    photoCaption = signal('');
    photoUploading = signal(false);

    evaluation = computed(() => evaluateInspection(this.form()));
    allowedFinal = computed(() => allowedFinalResults(this.evaluation().systemResult));
    readOnly = computed(() => {
        const r = this.record();
        return !this.meta()?.permissions.canEdit || (!!r && !['DRAFT', 'REJECTED'].includes(r.status));
    });
    sizeCount = computed(() => this.form().sizes.split(',').map(s => s.trim()).filter(Boolean).length);
    remarksRequired = computed(() => {
        const f = this.form(), sys = this.evaluation().systemResult;
        return f.finalResult === 'DEROGATION' || (f.finalResult === 'FAIL' && sys === 'PASS');
    });
    defectsBy = computed(() => {
        const out: Record<DefectCategory, Array<{ line: QcDefectLine; index: number }>> = { STITCHING: [], APPEARANCE: [] };
        this.form().defects.forEach((line, index) => out[line.category]?.push({ line, index }));
        return out;
    });

    constructor() {
        // Drop a final result that the (re)computed system result no longer allows.
        effect(() => {
            const fr = this.form().finalResult;
            const allowed = this.allowedFinal();
            if (fr && allowed.length && !allowed.includes(fr)) this.form.update(f => ({ ...f, finalResult: '' }));
        }, { allowSignalWrites: true });
    }

    async ngOnInit(): Promise<void> {
        try {
            this.meta.set(await this.qc.getMeta());
            const editId = this.qcNav.consumeEditId();
            if (editId !== null) await this.editInspection(editId);
            await this.loadList();
        } catch (err) {
            this.loadError.set(apiError(err, 'Failed to load the QC module.').message);
        }
    }

    // ── List ───────────────────────────────────────────────
    async loadList(page = this.page()): Promise<void> {
        this.listLoading.set(true);
        try {
            const res = await this.qc.list({ search: this.search().trim(), status: this.statusFilter(), page, pageSize: this.pageSize });
            this.rows.set(res.data || []);
            this.total.set(res.total || 0);
            this.page.set(page);
        } catch (err) {
            Swal.fire({ icon: 'error', title: 'Could not load inspections', text: apiError(err).message });
        } finally {
            this.listLoading.set(false);
        }
    }

    onSearch(value: string): void {
        this.search.set(value);
        this.loadList(1);
    }

    onStatusFilter(value: string): void {
        this.statusFilter.set(value);
        this.loadList(1);
    }

    isEditable(row: QcInspection): boolean {
        return !!this.meta()?.permissions.canEdit && (row.status === 'DRAFT' || row.status === 'REJECTED');
    }

    async deleteDraft(row: QcInspection): Promise<void> {
        const ok = await Swal.fire({ icon: 'warning', title: `Delete draft ${row.reportNo}?`, text: 'This cannot be undone.', showCancelButton: true, confirmButtonText: 'Delete', confirmButtonColor: '#dc2626' });
        if (!ok.isConfirmed) return;
        try {
            const res = await this.qc.deleteDraft(row.id);
            Swal.fire({ icon: 'success', title: res.message, timer: 1500, showConfirmButton: false });
            this.loadList();
        } catch (err) {
            Swal.fire({ icon: 'error', title: 'Not deleted', text: apiError(err).message });
        }
    }

    // ── Form lifecycle ─────────────────────────────────────
    private blankForm(): QcForm {
        const d = this.meta()?.defaults || DEFAULTS;
        return {
            docType: 'JO', docNum: '', docEntry: null, supplierCode: '', supplierName: '', brandName: '', styleName: '', colours: '',
            dcNo: '', sizes: '', orderQty: null, lotQty: null, inspectedQty: null,
            inspectionDate: todayIso(), inspectionType: 'FINAL', measurementUnit: 'INCH',
            inspectionLevel: d.inspectionLevel, aqlMajor: d.aqlMajor, aqlMinor: d.aqlMinor,
            measurementResult: '', measurementComments: '', packingResult: '', packingComments: '',
            finalResult: '', faultDescription: '', defectComments: '', finalRemarks: '',
            inspectorName: this.auth.currentUser()?.name || '', unitIncharge: '', merchandiser: '', amqc: '', gm: '',
            defects: mergeDefects(this.meta()?.defectMaster || [], []),
        };
    }

    newInspection(): void {
        this.form.set(this.blankForm());
        this.record.set(null);
        this.clientToken.set(newToken());
        this.photos.set([]);
        this.photoCaption.set('');
        this.errors.set([]);
        this.dirty.set(false);
        this.lotTouched.set(false);
        this.view.set('form');
        this.documents.set([]);
        this.docsError.set('');
        this.loadParties();
        if (this.isVendor()) {
            const u = this.auth.currentUser();
            this.form.update(f => ({ ...f, supplierCode: u?.partyCode || '', supplierName: u?.name || '' }));
            this.loadDocuments();
        }
    }

    async editInspection(id: number): Promise<void> {
        this.viewerId.set(null);
        try {
            const r = await this.qc.getDetail(id);
            this.applyRecord(r);
            this.errors.set([]);
            this.view.set('form');
            this.documents.set([]);
            this.docsError.set('');
            this.loadParties();
            if (r.docType && r.supplierCode && !this.readOnly()) this.loadDocuments();
            this.qc.getPhotos(id).then(p => this.photos.set(p)).catch(() => this.photos.set([]));
        } catch (err) {
            Swal.fire({ icon: 'error', title: 'Could not open the report', text: apiError(err).message });
        }
    }

    private applyRecord(r: QcInspection): void {
        const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
        this.form.set({
            docType: s(r.docType) || 'JO', docNum: s(r.docNum), docEntry: r.docEntry ?? null, supplierCode: s(r.supplierCode), supplierName: s(r.supplierName),
            brandName: s(r.brandName), styleName: s(r.styleName), colours: s(r.colours), dcNo: s(r.dcNo), sizes: s(r.sizes),
            orderQty: r.orderQty ?? null, lotQty: r.lotQty ?? null, inspectedQty: r.inspectedQty ?? null,
            inspectionDate: s(r.inspectionDate), inspectionType: s(r.inspectionType), measurementUnit: s(r.measurementUnit),
            inspectionLevel: s(r.inspectionLevel) || DEFAULTS.inspectionLevel,
            aqlMajor: r.aqlMajor ?? null, aqlMinor: r.aqlMinor ?? null,
            measurementResult: s(r.measurementResult), measurementComments: s(r.measurementComments),
            packingResult: s(r.packingResult), packingComments: s(r.packingComments),
            finalResult: s(r.finalResult), faultDescription: s(r.faultDescription), defectComments: s(r.defectComments),
            finalRemarks: s(r.finalRemarks), inspectorName: s(r.inspectorName), unitIncharge: s(r.unitIncharge),
            merchandiser: s(r.merchandiser), amqc: s(r.amqc), gm: s(r.gm),
            defects: mergeDefects(this.meta()?.defectMaster || [], r.defects || []),
        });
        this.record.set({ id: r.id, reportNo: r.reportNo, status: r.status, rowVersion: r.rowVersion, approvalRemarks: r.approvalRemarks, approvedBy: r.approvedBy });
        this.dirty.set(false);
        this.lotTouched.set(true);
    }

    async backToList(): Promise<void> {
        if (this.dirty() && !this.readOnly()) {
            const ok = await Swal.fire({ icon: 'warning', title: 'Discard unsaved changes?', showCancelButton: true, confirmButtonText: 'Discard' });
            if (!ok.isConfirmed) return;
        }
        this.view.set('list');
        this.loadList();
    }

    // ── Field setters ──────────────────────────────────────
    setText(key: TextKey, value: string): void {
        this.form.update(f => ({ ...f, [key]: value }));
        this.dirty.set(true);
    }

    setNum(key: NumKey, raw: string): void {
        const value = raw === '' ? null : Number(raw);
        this.form.update(f => {
            const next = { ...f, [key]: value };
            // Lot qty follows order qty until the user sets it explicitly.
            if (key === 'orderQty' && !this.lotTouched()) next.lotQty = value;
            return next;
        });
        if (key === 'lotQty') this.lotTouched.set(true);
        this.dirty.set(true);
    }

    setDefect(index: number, field: 'majorQty' | 'minorQty' | 'defectName', raw: string): void {
        this.form.update(f => {
            const defects = f.defects.slice();
            const line = { ...defects[index] };
            if (field === 'defectName') line.defectName = raw.toUpperCase();
            else line[field] = raw === '' ? null : Number(raw);
            defects[index] = line;
            return { ...f, defects };
        });
        this.dirty.set(true);
    }

    addCustomDefect(category: DefectCategory): void {
        this.form.update(f => ({ ...f, defects: [...f.defects, { category, defectName: '', majorQty: null, minorQty: null, isCustom: true }] }));
        this.dirty.set(true);
    }

    removeDefect(index: number): void {
        this.form.update(f => ({ ...f, defects: f.defects.filter((_, i) => i !== index) }));
        this.dirty.set(true);
    }

    // ── Source document: EXEC [@ASRS_Transaction] @type = 'Binning' ──
    private async loadParties(): Promise<void> {
        if (this.parties().length || this.partiesLoading()) return;
        this.partiesLoading.set(true);
        try { this.parties.set(await this.qc.getParties()); }
        catch { this.parties.set([]); }
        finally { this.partiesLoading.set(false); }
    }

    /** Loads the documents for the selected doc type + supplier. */
    async loadDocuments(): Promise<void> {
        const { docType, supplierCode } = this.form();
        this.documents.set([]);
        this.docsError.set('');
        if (!docType || !supplierCode) return;
        this.docsLoading.set(true);
        try {
            const docs = await this.qc.getDocuments(docType, supplierCode);
            this.documents.set(docs);
            if (!docs.length) this.docsError.set(`No ${docType} documents found for ${supplierCode}.`);
        } catch (err) {
            this.docsError.set(apiError(err, 'Failed to load documents.').message);
        } finally {
            this.docsLoading.set(false);
        }
    }

    selectDocType(docType: string): void {
        if (this.form().docType === docType) return;
        this.form.update(f => ({ ...f, docType, docNum: '', docEntry: null }));
        this.dirty.set(true);
        this.loadDocuments();
    }

    /** Accepts "CODE — NAME" (picked from the list) or a bare supplier code. */
    selectParty(raw: string): void {
        const text = raw.trim();
        const code = text.split(' — ')[0].trim();
        const party = this.parties().find(p => p.code.toUpperCase() === code.toUpperCase());
        this.form.update(f => ({
            ...f,
            supplierCode: party?.code || code,
            supplierName: party?.name || f.supplierName,
            docNum: '', docEntry: null,
        }));
        this.dirty.set(true);
        this.loadDocuments();
    }

    /** Prefills the report from the chosen document; every field stays editable. */
    selectDocument(docNum: string): void {
        const doc = this.documents().find(d => d.docNum === docNum);
        if (!doc) {
            this.form.update(f => ({ ...f, docNum: '', docEntry: null }));
            this.dirty.set(true);
            return;
        }
        this.form.update(f => ({
            ...f,
            docNum: doc.docNum,
            docEntry: doc.docEntry,
            supplierName: doc.partyName || f.supplierName,
            colours: doc.colours.length ? doc.colours.join(',') : f.colours,
            sizes: doc.sizes.length ? doc.sizes.join(',') : f.sizes,
            orderQty: doc.totalQty || f.orderQty,
            lotQty: this.lotTouched() ? f.lotQty : (doc.totalQty || f.lotQty),
        }));
        this.dirty.set(true);
    }

    // ── Save / submit ──────────────────────────────────────
    async save(action: 'draft' | 'submit'): Promise<void> {
        if (this.saving() || this.readOnly()) return;
        const f = this.form();
        const errors = validateInspection(f, action, this.evaluation());
        this.errors.set(errors);
        if (errors.length) {
            document.getElementById('qc-errors')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }
        if (action === 'submit') {
            const ev = this.evaluation();
            const warn = ev.warnings.length ? `<p style="color:#b45309;margin-top:8px">${ev.warnings.join('<br>')}</p>` : '';
            const ok = await Swal.fire({
                icon: 'question', showCancelButton: true, confirmButtonText: 'Submit',
                title: 'Submit for approval?',
                html: `Final result: <b>${f.finalResult}</b> (system: ${ev.systemResult ?? '—'}).<br>The report is locked once submitted.${warn}`,
            });
            if (!ok.isConfirmed) return;
        }

        this.saving.set(true);
        const rec = this.record();
        try {
            const payload = {
                ...f,
                defects: f.defects.filter(d => d.defectName.trim() && ((Number(d.majorQty) || 0) > 0 || (Number(d.minorQty) || 0) > 0)),
                action,
                id: rec?.id ?? null,
                rowVersion: rec?.rowVersion ?? null,
                clientToken: rec ? null : this.clientToken(),
            };
            const res = await this.qc.save(payload);
            this.applyRecord(res.data);
            this.errors.set([]);
            const warn = res.warnings?.length ? res.warnings.join(' ') : '';
            Swal.fire({ icon: res.duplicate ? 'info' : 'success', title: res.message, text: warn, timer: warn ? undefined : 2000, showConfirmButton: !!warn });
            if (action === 'submit') { this.view.set('list'); this.loadList(1); }
        } catch (err) {
            const e = apiError(err, 'Failed to save the inspection.');
            this.errors.set(e.errors.length ? e.errors : [e.message]);
            Swal.fire({ icon: 'error', title: 'Not saved', text: e.message });
        } finally {
            this.saving.set(false);
        }
    }

    // ── Defect photos (DEFECT PHOTO sheet) ─────────────────
    async onPhotoSelected(input: HTMLInputElement): Promise<void> {
        const file = input.files?.[0];
        input.value = '';
        const rec = this.record();
        if (!file || !rec) return;
        if (!this.photoCaption().trim()) {
            Swal.fire({ icon: 'warning', title: 'Caption required', text: 'Describe the defect (e.g. "OPEN SEAM AT BOTTOM HEM") before adding the photo.' });
            return;
        }
        if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
            Swal.fire({ icon: 'warning', title: 'Unsupported file', text: 'Choose a JPEG, PNG or WEBP image.' });
            return;
        }
        this.photoUploading.set(true);
        try {
            const dataUrl = await this.downscale(file);
            const res = await this.qc.addPhoto(rec.id, this.photoCaption().trim(), dataUrl);
            this.photos.update(p => [...p, { id: res.data.id, caption: res.data.caption, dataUrl }]);
            this.photoCaption.set('');
        } catch (err) {
            Swal.fire({ icon: 'error', title: 'Photo not added', text: apiError(err, (err as Error)?.message).message });
        } finally {
            this.photoUploading.set(false);
        }
    }

    async deletePhoto(photo: QcPhoto): Promise<void> {
        const ok = await Swal.fire({ icon: 'warning', title: 'Remove this photo?', text: photo.caption, showCancelButton: true, confirmButtonText: 'Remove' });
        if (!ok.isConfirmed) return;
        try {
            await this.qc.deletePhoto(photo.id);
            this.photos.update(p => p.filter(x => x.id !== photo.id));
        } catch (err) {
            Swal.fire({ icon: 'error', title: 'Not removed', text: apiError(err).message });
        }
    }

    /** Resizes to ≤1600px on the long edge and re-encodes as JPEG so uploads stay small. */
    private downscale(file: File): Promise<string> {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(img.width, img.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                const ctx = canvas.getContext('2d');
                if (!ctx) { reject(new Error('Could not process the image.')); return; }
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                for (const q of [0.82, 0.7, 0.55, 0.4]) {
                    const data = canvas.toDataURL('image/jpeg', q);
                    if ((data.length - data.indexOf(',') - 1) * 0.75 <= MAX_PHOTO_BYTES) { resolve(data); return; }
                }
                reject(new Error('The image is too large even after compression.'));
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The file could not be read as an image.')); };
            img.src = url;
        });
    }

    // ── Viewer ─────────────────────────────────────────────
    openViewer(id: number): void { this.viewerId.set(id); }
    closeViewer(): void { this.viewerId.set(null); }
    onViewerChanged(): void { this.loadList(); }
}
