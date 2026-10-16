/**
 * QC — Final Inspection (FI) Report API.
 * Modelled on docs/QC_Checking_Sample.xlsx: "FI REPORT" (header, audits, defect checklist, AQL, sign-off)
 * and "DEFECT PHOTO" (captioned defect photos).
 *
 * Permissions:  qcInspection → create / edit / submit / delete drafts
 *               qcReport     → search and view reports
 *               qcApprove    → approve / reject submitted reports
 * Workflow:     DRAFT → SUBMITTED → APPROVED | REJECTED;  a REJECTED report is edited and resubmitted.
 */
const express = require('express');
const crypto  = require('crypto');
const { pool, sql } = require('../db');
const { authenticate } = require('../middleware/auth');
const { sendServerError } = require('../utils/respond');
const { AQL_VALUES, INSPECTION_LEVELS } = require('../utils/aql');
const rules = require('../utils/qcRules');

const router = express.Router();
router.use(authenticate);

// ── Permissions ───────────────────────────────────────────
const hasPerm = (user, perm) =>
    user?.role === 'admin' || (Array.isArray(user?.permissions) && user.permissions.includes(perm));

function authorizeAny(...perms) {
    return (req, res, next) => perms.some(p => hasPerm(req.user, p))
        ? next()
        : res.status(403).json({ status: 0, message: 'You do not have permission to perform this action.' });
}
const canView = authorizeAny('qcInspection', 'qcReport', 'qcApprove');

const isVendor = user => user?.role === 'vendor';
const userName = user => user?.name || user?.username || 'System';

class ValidationError extends Error {
    constructor(message, status = 400, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

// ── Defect checklist from the sample sheet (spelling corrected) ──
// The sheet has two "STITCHING DEFECTS" columns (A and E); both are stitching, kept in sheet order.
const DEFAULT_DEFECTS = {
    STITCHING: [
        'SKIP STITCH', 'PUCKERING', 'OPEN CHAIN STITCH', 'OPEN SEAM', 'HOLE & DAMAGE', 'ASYMMETRIC STITCH',
        'SHAPE OFF', 'YELLOW STAIN', 'SPI VARIATION', 'LOOSE STITCH', 'BROKEN STITCH',
        'UNTRIMMED THREAD', 'PLEAT',
    ],
    APPEARANCE: [
        'DYE STAIN', 'HIKING', 'CREASE MARK', 'ROPY HEM', 'BLEEDING', 'OIL STAIN OR WAX',
        'WAVE STITCH', 'COLOUR FLY', 'WEAVING DEFECT', 'SHADE VARIATION', 'BARTACK MISSING',
    ],
};

// Document types accepted by [@ASRS_Transaction] @type = 'Binning' (same as JO Status / Vendor Entry).
const DOC_TYPES = ['JO', 'PO', 'ST'];
const MAX_PHOTOS = 20;
const MAX_PHOTO_BYTES = 1.5 * 1024 * 1024;

// ── Schema ────────────────────────────────────────────────
let tablesReady = false;

async function ensureTables() {
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='QC_DefectMaster' AND xtype='U')
        CREATE TABLE QC_DefectMaster (
            Id          INT IDENTITY(1,1) PRIMARY KEY,
            Category    NVARCHAR(20)  NOT NULL,
            DefectName  NVARCHAR(100) NOT NULL,
            SortOrder   INT           NOT NULL DEFAULT 0,
            IsActive    BIT           NOT NULL DEFAULT 1,
            CONSTRAINT UQ_QC_DefectMaster UNIQUE (Category, DefectName)
        )
    `);

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='QC_Inspection' AND xtype='U')
        CREATE TABLE QC_Inspection (
            Id                  INT IDENTITY(1,1) PRIMARY KEY,
            ReportNo            NVARCHAR(30)   NOT NULL,
            ClientToken         NVARCHAR(64)   NULL,
            DocType             NVARCHAR(10)   NULL,
            DocNum              NVARCHAR(100)  NULL,
            DocEntry            INT            NULL,
            SupplierCode        NVARCHAR(50)   NULL,
            SupplierName        NVARCHAR(200)  NULL,
            BrandName           NVARCHAR(100)  NULL,
            StyleName           NVARCHAR(200)  NULL,
            Colours             NVARCHAR(500)  NULL,
            DcNo                NVARCHAR(100)  NULL,
            Sizes               NVARCHAR(300)  NULL,
            OrderQty            INT            NULL,
            LotQty              INT            NULL,
            InspectedQty        INT            NULL,
            InspectionDate      DATE           NULL,
            InspectionType      NVARCHAR(20)   NULL,
            MeasurementUnit     NVARCHAR(10)   NULL,
            InspectionLevel     NVARCHAR(5)    NULL,
            AqlMajor            DECIMAL(6,3)   NULL,
            AqlMinor            DECIMAL(6,3)   NULL,
            CodeLetter          NVARCHAR(2)    NULL,
            SampleSize          INT            NULL,
            MajorAc             INT            NULL,
            MajorRe             INT            NULL,
            MinorAc             INT            NULL,
            MinorRe             INT            NULL,
            MeasurementResult   NVARCHAR(10)   NULL,
            MeasurementComments NVARCHAR(1000) NULL,
            PackingResult       NVARCHAR(10)   NULL,
            PackingComments     NVARCHAR(1000) NULL,
            TotalMajor          INT            NOT NULL DEFAULT 0,
            TotalMinor          INT            NOT NULL DEFAULT 0,
            MajorResult         NVARCHAR(10)   NULL,
            MinorResult         NVARCHAR(10)   NULL,
            SystemResult        NVARCHAR(10)   NULL,
            FinalResult         NVARCHAR(20)   NULL,
            FaultDescription    NVARCHAR(2000) NULL,
            DefectComments      NVARCHAR(1000) NULL,
            FinalRemarks        NVARCHAR(1000) NULL,
            InspectorName       NVARCHAR(100)  NULL,
            UnitIncharge        NVARCHAR(100)  NULL,
            Merchandiser        NVARCHAR(100)  NULL,
            Amqc                NVARCHAR(100)  NULL,
            Gm                  NVARCHAR(100)  NULL,
            Status              NVARCHAR(20)   NOT NULL DEFAULT 'DRAFT',
            SubmittedAt         DATETIME       NULL,
            SubmittedBy         NVARCHAR(100)  NULL,
            ApprovedAt          DATETIME       NULL,
            ApprovedBy          NVARCHAR(100)  NULL,
            ApprovalRemarks     NVARCHAR(1000) NULL,
            CreatedAt           DATETIME       NOT NULL DEFAULT GETDATE(),
            CreatedBy           NVARCHAR(100)  NULL,
            UpdatedAt           DATETIME       NULL,
            UpdatedBy           NVARCHAR(100)  NULL,
            RowVer              ROWVERSION,
            CONSTRAINT UQ_QC_Inspection_ReportNo UNIQUE (ReportNo)
        )
    `);
    // Upgrade a QC_Inspection created by an earlier build (which linked JO_Master via JO_Id / JO_No).
    for (const [col, type] of [['DocType', 'NVARCHAR(10)'], ['DocNum', 'NVARCHAR(100)'], ['DocEntry', 'INT']]) {
        await pool.request().query(`
            IF COL_LENGTH('QC_Inspection', '${col}') IS NULL
                ALTER TABLE QC_Inspection ADD ${col} ${type} NULL`);
    }
    await pool.request().query(`
        IF COL_LENGTH('QC_Inspection', 'JO_No') IS NOT NULL
            EXEC sp_executesql N'UPDATE QC_Inspection SET DocNum = JO_No WHERE DocNum IS NULL AND JO_No IS NOT NULL'
    `);
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='UX_QC_Inspection_ClientToken')
        CREATE UNIQUE INDEX UX_QC_Inspection_ClientToken ON QC_Inspection (ClientToken) WHERE ClientToken IS NOT NULL
    `);
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_QC_Inspection_Date')
        CREATE INDEX IX_QC_Inspection_Date ON QC_Inspection (InspectionDate, Status)
    `);

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='QC_InspectionDefects' AND xtype='U')
        CREATE TABLE QC_InspectionDefects (
            Id           INT IDENTITY(1,1) PRIMARY KEY,
            InspectionId INT           NOT NULL
                CONSTRAINT FK_QC_InspectionDefects_Inspection REFERENCES QC_Inspection(Id) ON DELETE CASCADE,
            Category     NVARCHAR(20)  NOT NULL,
            DefectName   NVARCHAR(100) NOT NULL,
            MajorQty     INT           NOT NULL DEFAULT 0,
            MinorQty     INT           NOT NULL DEFAULT 0,
            IsCustom     BIT           NOT NULL DEFAULT 0,
            SortOrder    INT           NOT NULL DEFAULT 0
        )
    `);
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name='IX_QC_InspectionDefects_Inspection')
        CREATE INDEX IX_QC_InspectionDefects_Inspection ON QC_InspectionDefects (InspectionId)
    `);

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='QC_DefectPhotos' AND xtype='U')
        CREATE TABLE QC_DefectPhotos (
            Id           INT IDENTITY(1,1) PRIMARY KEY,
            InspectionId INT            NOT NULL
                CONSTRAINT FK_QC_DefectPhotos_Inspection REFERENCES QC_Inspection(Id) ON DELETE CASCADE,
            Caption      NVARCHAR(200)  NOT NULL,
            MimeType     NVARCHAR(30)   NOT NULL,
            ImageData    VARBINARY(MAX) NOT NULL,
            CreatedAt    DATETIME       NOT NULL DEFAULT GETDATE(),
            CreatedBy    NVARCHAR(100)  NULL
        )
    `);

    // Seed the defect checklist once (only inserts names that are missing).
    let order = 0;
    for (const [category, names] of Object.entries(DEFAULT_DEFECTS)) {
        for (const name of names) {
            order += 1;
            await pool.request()
                .input('cat', sql.NVarChar, category)
                .input('name', sql.NVarChar, name)
                .input('ord', sql.Int, order)
                .query(`IF NOT EXISTS (SELECT 1 FROM QC_DefectMaster WHERE Category=@cat AND DefectName=@name)
                        INSERT INTO QC_DefectMaster (Category, DefectName, SortOrder) VALUES (@cat, @name, @ord)`);
        }
    }
}

async function getPool() {
    if (!tablesReady) { await ensureTables(); tablesReady = true; }
    return pool;
}

// ── Helpers ───────────────────────────────────────────────
const str = (v, max) => {
    const t = String(v ?? '').trim();
    return t ? t.slice(0, max) : null;
};
const upper = (v, max) => { const t = str(v, max); return t ? t.toUpperCase() : null; };
const intOrNull = v => (v === null || v === undefined || v === '' ? null : Number(v));
const decOrNull = v => (v === null || v === undefined || v === '' ? null : Number(v));

/** Normalises the request body into the shape the rules module and the DB expect. */
function normalise(body) {
    const defects = Array.isArray(body.defects) ? body.defects : [];
    return {
        docType:           DOC_TYPES.includes(upper(body.docType, 10)) ? upper(body.docType, 10) : null,
        docNum:            str(body.docNum, 100),
        docEntry:          intOrNull(body.docEntry),
        supplierCode:      str(body.supplierCode, 50),
        supplierName:      str(body.supplierName, 200),
        brandName:         str(body.brandName, 100),
        styleName:         str(body.styleName, 200),
        colours:           str(body.colours, 500),
        dcNo:              str(body.dcNo, 100),
        sizes:             str(body.sizes, 300),
        orderQty:          intOrNull(body.orderQty),
        lotQty:            intOrNull(body.lotQty),
        inspectedQty:      intOrNull(body.inspectedQty),
        inspectionDate:    str(body.inspectionDate, 10),
        inspectionType:    upper(body.inspectionType, 20),
        measurementUnit:   upper(body.measurementUnit, 10),
        inspectionLevel:   upper(body.inspectionLevel, 5),
        aqlMajor:          decOrNull(body.aqlMajor),
        aqlMinor:          decOrNull(body.aqlMinor),
        measurementResult: upper(body.measurementResult, 10),
        measurementComments: str(body.measurementComments, 1000),
        packingResult:     upper(body.packingResult, 10),
        packingComments:   str(body.packingComments, 1000),
        finalResult:       upper(body.finalResult, 20),
        faultDescription:  str(body.faultDescription, 2000),
        defectComments:    str(body.defectComments, 1000),
        finalRemarks:      str(body.finalRemarks, 1000),
        inspectorName:     str(body.inspectorName, 100),
        unitIncharge:      str(body.unitIncharge, 100),
        merchandiser:      str(body.merchandiser, 100),
        amqc:              str(body.amqc, 100),
        gm:                str(body.gm, 100),
        defects: defects.slice(0, 200).map((d, i) => ({
            category:   upper(d?.category, 20),
            defectName: upper(d?.defectName, 100),
            majorQty:   d?.majorQty === '' || d?.majorQty == null ? 0 : Number(d.majorQty),
            minorQty:   d?.minorQty === '' || d?.minorQty == null ? 0 : Number(d.minorQty),
            isCustom:   !!d?.isCustom,
            sortOrder:  i,
        })),
    };
}

/** Accepts only rows with counts or a custom name worth keeping. */
const defectsToStore = defects => defects.filter(d => d.defectName && (d.majorQty > 0 || d.minorQty > 0));

const rowVerHex = buf => (buf ? Buffer.from(buf).toString('hex') : null);

function mapHeader(r) {
    return {
        id: r.Id, reportNo: r.ReportNo, docType: r.DocType, docNum: r.DocNum, docEntry: r.DocEntry,
        supplierCode: r.SupplierCode, supplierName: r.SupplierName, brandName: r.BrandName,
        styleName: r.StyleName, colours: r.Colours, dcNo: r.DcNo, sizes: r.Sizes,
        orderQty: r.OrderQty, lotQty: r.LotQty, inspectedQty: r.InspectedQty,
        inspectionDate: r.InspectionDate ? new Date(r.InspectionDate).toISOString().slice(0, 10) : null,
        inspectionType: r.InspectionType, measurementUnit: r.MeasurementUnit, inspectionLevel: r.InspectionLevel,
        aqlMajor: r.AqlMajor !== null && r.AqlMajor !== undefined ? Number(r.AqlMajor) : null,
        aqlMinor: r.AqlMinor !== null && r.AqlMinor !== undefined ? Number(r.AqlMinor) : null,
        codeLetter: r.CodeLetter, sampleSize: r.SampleSize,
        majorAc: r.MajorAc, majorRe: r.MajorRe, minorAc: r.MinorAc, minorRe: r.MinorRe,
        measurementResult: r.MeasurementResult, measurementComments: r.MeasurementComments,
        packingResult: r.PackingResult, packingComments: r.PackingComments,
        totalMajor: r.TotalMajor, totalMinor: r.TotalMinor,
        majorResult: r.MajorResult, minorResult: r.MinorResult,
        systemResult: r.SystemResult, finalResult: r.FinalResult,
        faultDescription: r.FaultDescription, defectComments: r.DefectComments, finalRemarks: r.FinalRemarks,
        inspectorName: r.InspectorName, unitIncharge: r.UnitIncharge, merchandiser: r.Merchandiser,
        amqc: r.Amqc, gm: r.Gm,
        status: r.Status, submittedAt: r.SubmittedAt, submittedBy: r.SubmittedBy,
        approvedAt: r.ApprovedAt, approvedBy: r.ApprovedBy, approvalRemarks: r.ApprovalRemarks,
        createdAt: r.CreatedAt, createdBy: r.CreatedBy, updatedAt: r.UpdatedAt, updatedBy: r.UpdatedBy,
        rowVersion: rowVerHex(r.RowVer),
    };
}

/** Adds the vendor scope filter (vendors only ever see their own supplier code). */
function vendorScope(req, request, alias = '') {
    if (!isVendor(req.user)) return '';
    request.input('vendorCode', sql.NVarChar, String(req.user.partyCode || '').trim());
    return ` AND LTRIM(RTRIM(${alias}SupplierCode)) = @vendorCode`;
}

async function loadInspection(req, id) {
    const p = await getPool();
    const request = p.request().input('id', sql.Int, id);
    const scope = vendorScope(req, request);
    const head = await request.query(`SELECT * FROM QC_Inspection WHERE Id = @id${scope}`);
    if (!head.recordset.length) return null;
    const defects = await p.request().input('id', sql.Int, id).query(`
        SELECT Category, DefectName, MajorQty, MinorQty, IsCustom, SortOrder
        FROM QC_InspectionDefects WHERE InspectionId = @id ORDER BY SortOrder, Id`);
    const photos = await p.request().input('id', sql.Int, id).query(`
        SELECT Id, Caption, MimeType, CreatedAt, CreatedBy
        FROM QC_DefectPhotos WHERE InspectionId = @id ORDER BY Id`);
    return {
        ...mapHeader(head.recordset[0]),
        defects: defects.recordset.map(d => ({
            category: d.Category, defectName: d.DefectName,
            majorQty: d.MajorQty, minorQty: d.MinorQty, isCustom: !!d.IsCustom,
        })),
        photos: photos.recordset.map(ph => ({
            id: ph.Id, caption: ph.Caption, mimeType: ph.MimeType, createdAt: ph.CreatedAt, createdBy: ph.CreatedBy,
        })),
    };
}

/** Next report number for the current month: QC/YYMM/0001. Caller must hold a transaction. */
async function nextReportNo(transaction) {
    const now = new Date();
    const prefix = `QC/${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}/`;
    const r = await transaction.request()
        .input('prefix', sql.NVarChar, prefix + '%')
        // Order by length first so 5-digit sequences sort after 4-digit ones.
        .query(`SELECT TOP 1 ReportNo AS LastNo FROM QC_Inspection WITH (UPDLOCK, HOLDLOCK)
                WHERE ReportNo LIKE @prefix ORDER BY LEN(ReportNo) DESC, ReportNo DESC`);
    const last = r.recordset[0]?.LastNo;
    const seq = last ? (parseInt(String(last).slice(prefix.length), 10) || 0) + 1 : 1;
    return prefix + String(seq).padStart(4, '0');
}

// ── GET /meta — dropdowns, defect checklist, AQL options ──
router.get('/meta', canView, async (req, res) => {
    try {
        const p = await getPool();
        const r = await p.request().query(`
            SELECT Category, DefectName FROM QC_DefectMaster WHERE IsActive = 1 ORDER BY SortOrder, Id`);
        res.json({
            status: 1,
            data: {
                defectMaster: r.recordset.map(d => ({ category: d.Category, defectName: d.DefectName })),
                inspectionTypes: rules.INSPECTION_TYPES,
                measurementUnits: rules.MEASUREMENT_UNITS,
                auditResults: rules.AUDIT_RESULTS,
                finalResults: rules.FINAL_RESULTS,
                inspectionLevels: INSPECTION_LEVELS,
                aqlValues: AQL_VALUES,
                defaults: rules.DEFAULTS,
                permissions: {
                    canEdit: hasPerm(req.user, 'qcInspection'),
                    canApprove: hasPerm(req.user, 'qcApprove'),
                },
            },
        });
    } catch (err) {
        sendServerError(res, err, 'qc/meta', 'Failed to load QC setup data.');
    }
});

// ── GET /parties — suppliers (same source as Party Bin Master: OCRD, CardType 'S') ──
router.get('/parties', authorizeAny('qcInspection'), async (req, res) => {
    try {
        const p = await getPool();
        const request = p.request();
        let scope = '';
        if (isVendor(req.user)) {
            request.input('vendorCode', sql.NVarChar, String(req.user.partyCode || '').trim());
            scope = ' AND CardCode = @vendorCode';
        }
        const r = await request.query(`
            SELECT CardCode, CardName FROM OCRD
            WHERE validFor = 'Y' AND CardType = 'S'${scope}
            ORDER BY CardName`);
        res.json({ status: 1, data: r.recordset.map(x => ({ code: x.CardCode, name: x.CardName })) });
    } catch (err) {
        sendServerError(res, err, 'qc/parties', 'Failed to load the supplier list.');
    }
});

const distinct = values => [...new Set(values.map(v => String(v ?? '').trim()).filter(Boolean))];
const sizeSort = (a, b) => {
    const na = Number(a), nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.localeCompare(b, undefined, { numeric: true });
};

/** Groups [@ASRS_Transaction] 'Binning' line rows into one summary per document number. */
function groupBinningDocs(rows) {
    const byDoc = new Map();
    for (const row of rows || []) {
        const key = String(row.DocNum ?? '').trim();
        if (!key) continue;
        if (!byDoc.has(key)) byDoc.set(key, []);
        byDoc.get(key).push(row);
    }
    return [...byDoc.entries()].map(([docNum, lines]) => {
        const first = lines[0];
        const sum = f => lines.reduce((a, l) => a + (Number(l[f]) || 0), 0);
        return {
            docNum,
            docEntry: first.DocEntry ?? null,
            docDate: first.DocDate ?? null,
            partyName: first.PartyName || '',
            colours: distinct(lines.map(l => l.ItemColor)),
            sizes: distinct(lines.map(l => l.ItemSize)).sort(sizeSort),
            sleeves: distinct(lines.map(l => l.ItemSlive)),
            groups: distinct(lines.map(l => l.ItemGroup || l.GroupName)),
            lineCount: lines.length,
            totalQty: sum('Quantity'),
            pendingQty: lines.reduce((a, l) => a + (Number(l.PendingQty ?? l.Quantity) || 0), 0),
        };
    });
}

// ── GET /documents?docType=JO|PO|ST&partyCode= — documents from EXEC [@ASRS_Transaction] @type='Binning' ──
router.get('/documents', authorizeAny('qcInspection'), async (req, res) => {
    const docType = upper(req.query.docType, 10);
    const partyCode = isVendor(req.user) ? String(req.user.partyCode || '').trim() : str(req.query.partyCode, 50);
    if (!DOC_TYPES.includes(docType)) return res.status(400).json({ status: 0, message: `Document type must be one of: ${DOC_TYPES.join(', ')}.` });
    if (!partyCode) return res.status(400).json({ status: 0, message: 'Select a supplier first.' });
    try {
        const p = await getPool();
        const r = await p.request()
            .input('partyCode', sql.NVarChar, partyCode)
            .input('docType', sql.NVarChar, docType)
            .input('fromWarehouse', sql.NVarChar, '')
            .input('toWarehouse', sql.NVarChar, '')
            .query(`
                EXEC [@ASRS_Transaction]
                    @type = 'Binning',
                    @FilterPartyCode = @partyCode,
                    @FilterType = @docType,
                    @fromWarehouse = @fromWarehouse,
                    @toWarehouse = @toWarehouse`);
        res.json({ status: 1, data: groupBinningDocs(r.recordset) });
    } catch (err) {
        sendServerError(res, err, 'qc/documents', 'Failed to load documents.');
    }
});

// ── POST /evaluate — server-side preview of AQL + results (same rules as save) ──
router.post('/evaluate', canView, (req, res) => {
    const input = normalise(req.body || {});
    const evaluation = rules.evaluateInspection(input);
    res.json({ status: 1, data: { ...evaluation, allowedFinalResults: rules.allowedFinalResults(evaluation.systemResult) } });
});

// ── POST /list — search / report ──────────────────────────
// Body: { fromDate, toDate, supplier, brand, style, dcNo, docNum, inspectionType, finalResult,
//         status, inspector, search, page, pageSize }
router.post('/list', canView, async (req, res) => {
    const f = req.body || {};
    const page = Math.max(1, parseInt(f.page, 10) || 1);
    const pageSize = Math.min(5000, Math.max(1, parseInt(f.pageSize, 10) || 50));

    try {
        const p = await getPool();
        const request = p.request();
        const where = ['1=1'];

        const dateRe = /^\d{4}-\d{2}-\d{2}$/;
        if (f.fromDate && dateRe.test(f.fromDate)) { request.input('fromDate', sql.Date, f.fromDate); where.push('InspectionDate >= @fromDate'); }
        if (f.toDate && dateRe.test(f.toDate))     { request.input('toDate', sql.Date, f.toDate);     where.push('InspectionDate <= @toDate'); }

        const like = (key, col) => {
            const v = str(f[key], 200);
            if (v) { request.input(key, sql.NVarChar, `%${v.replace(/[[%_]/g, '[$&]')}%`); where.push(`${col} LIKE @${key}`); }
        };
        like('supplier', 'SupplierName');
        like('brand', 'BrandName');
        like('style', 'StyleName');
        like('dcNo', 'DcNo');
        like('docNum', 'DocNum');
        like('inspector', 'InspectorName');
        const search = str(f.search, 200);
        if (search) {
            request.input('search', sql.NVarChar, `%${search.replace(/[[%_]/g, '[$&]')}%`);
            where.push('(ReportNo LIKE @search OR StyleName LIKE @search OR DcNo LIKE @search OR SupplierName LIKE @search OR BrandName LIKE @search OR Colours LIKE @search OR DocNum LIKE @search)');
        }

        const exact = (key, col, allowed) => {
            const v = upper(f[key], 20);
            if (v && allowed.includes(v)) { request.input(key, sql.NVarChar, v); where.push(`${col} = @${key}`); }
        };
        exact('inspectionType', 'InspectionType', rules.INSPECTION_TYPES);
        exact('finalResult', 'FinalResult', rules.FINAL_RESULTS);
        exact('status', 'Status', ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED']);

        const whereSql = where.join(' AND ') + vendorScope(req, request);
        request.input('offset', sql.Int, (page - 1) * pageSize);
        request.input('pageSize', sql.Int, pageSize);

        const r = await request.query(`
            SELECT COUNT(*) AS Total,
                   SUM(CASE WHEN FinalResult = 'PASS'       THEN 1 ELSE 0 END) AS PassCount,
                   SUM(CASE WHEN FinalResult = 'FAIL'       THEN 1 ELSE 0 END) AS FailCount,
                   SUM(CASE WHEN FinalResult = 'DEROGATION' THEN 1 ELSE 0 END) AS DerogationCount,
                   SUM(CASE WHEN Status = 'DRAFT'     THEN 1 ELSE 0 END) AS DraftCount,
                   SUM(CASE WHEN Status = 'SUBMITTED' THEN 1 ELSE 0 END) AS SubmittedCount,
                   SUM(CASE WHEN Status = 'APPROVED'  THEN 1 ELSE 0 END) AS ApprovedCount,
                   SUM(CASE WHEN Status = 'REJECTED'  THEN 1 ELSE 0 END) AS RejectedCount,
                   SUM(ISNULL(InspectedQty, 0)) AS InspectedQty,
                   SUM(TotalMajor) AS TotalMajor,
                   SUM(TotalMinor) AS TotalMinor
            FROM QC_Inspection WHERE ${whereSql};

            SELECT Id, ReportNo, DocType, DocNum, SupplierName, BrandName, StyleName, Colours, DcNo, Sizes,
                   OrderQty, LotQty, InspectedQty, InspectionDate, InspectionType, MeasurementUnit,
                   InspectionLevel, AqlMajor, AqlMinor, CodeLetter, SampleSize, MajorAc, MajorRe, MinorAc, MinorRe,
                   MeasurementResult, PackingResult, TotalMajor, TotalMinor, MajorResult, MinorResult,
                   SystemResult, FinalResult, InspectorName, Status, ApprovedBy, ApprovedAt, CreatedAt, UpdatedAt
            FROM QC_Inspection WHERE ${whereSql}
            ORDER BY InspectionDate DESC, Id DESC
            OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
        `);
        const s = r.recordsets[0][0] || {};
        res.json({
            status: 1,
            data: r.recordsets[1].map(mapHeader),
            total: s.Total || 0,
            page, pageSize,
            summary: {
                total: s.Total || 0,
                pass: s.PassCount || 0, fail: s.FailCount || 0, derogation: s.DerogationCount || 0,
                draft: s.DraftCount || 0, submitted: s.SubmittedCount || 0,
                approved: s.ApprovedCount || 0, rejected: s.RejectedCount || 0,
                inspectedQty: s.InspectedQty || 0, totalMajor: s.TotalMajor || 0, totalMinor: s.TotalMinor || 0,
            },
        });
    } catch (err) {
        sendServerError(res, err, 'qc/list', 'Failed to load QC inspections.');
    }
});

// ── GET /detail/:id ───────────────────────────────────────
router.get('/detail/:id', canView, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ status: 0, message: 'Invalid inspection id.' });
    try {
        const data = await loadInspection(req, id);
        if (!data) return res.status(404).json({ status: 0, message: 'Inspection not found.' });
        res.json({ status: 1, data });
    } catch (err) {
        sendServerError(res, err, 'qc/detail', 'Failed to load the inspection.');
    }
});

// ── POST /save — create or update; action 'draft' | 'submit' ──
// Body: { id?, rowVersion?, clientToken?, action, ...fields, defects: [{category, defectName, majorQty, minorQty, isCustom}] }
router.post('/save', authorizeAny('qcInspection'), async (req, res) => {
    const body = req.body || {};
    const action = body.action === 'submit' ? 'submit' : 'draft';
    const id = body.id ? parseInt(body.id, 10) : null;
    const clientToken = str(body.clientToken, 64);
    const by = userName(req.user);
    const input = normalise(body);

    // Vendors can only inspect against their own supplier code.
    if (isVendor(req.user)) input.supplierCode = String(req.user.partyCode || '').trim() || null;

    const evaluation = rules.evaluateInspection(input);
    const errors = rules.validateInspection(input, action, evaluation);
    if (errors.length) return res.status(400).json({ status: 0, message: errors[0], errors });

    const defects = defectsToStore(input.defects);

    try {
        await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        try {
            let inspectionId = id;
            let reportNo;

            if (id) {
                const cur = await transaction.request().input('id', sql.Int, id)
                    .query(`SELECT Status, RowVer, SupplierCode, ReportNo FROM QC_Inspection WITH (UPDLOCK) WHERE Id = @id`);
                const row = cur.recordset[0];
                if (!row) throw new ValidationError('Inspection not found.', 404);
                if (isVendor(req.user) && String(row.SupplierCode || '').trim() !== input.supplierCode) {
                    throw new ValidationError('Inspection not found.', 404);
                }
                if (!['DRAFT', 'REJECTED'].includes(row.Status)) {
                    throw new ValidationError(`This report is ${row.Status} and can no longer be edited.`, 409);
                }
                if (body.rowVersion && rowVerHex(row.RowVer) !== String(body.rowVersion)) {
                    throw new ValidationError('This report was changed by someone else. Reload it and apply your changes again.', 409);
                }
                reportNo = row.ReportNo;
            } else if (clientToken) {
                // Idempotent create: a retried / double-clicked submission returns the record already created.
                const prior = await transaction.request().input('tok', sql.NVarChar, clientToken)
                    .query(`SELECT Id, ReportNo FROM QC_Inspection WITH (UPDLOCK, HOLDLOCK) WHERE ClientToken = @tok`);
                if (prior.recordset.length) {
                    await transaction.rollback();
                    const data = await loadInspection(req, prior.recordset[0].Id);
                    return res.json({ status: 1, message: `Report ${prior.recordset[0].ReportNo} was already saved.`, data, duplicate: true });
                }
            }

            // Business duplicate: same DC No + Style + Inspection Type + Colour + Date is the same inspection.
            if (input.dcNo && input.styleName && input.inspectionType && input.inspectionDate) {
                const dup = await transaction.request()
                    .input('dcNo', sql.NVarChar, input.dcNo)
                    .input('style', sql.NVarChar, input.styleName)
                    .input('type', sql.NVarChar, input.inspectionType)
                    .input('colours', sql.NVarChar, input.colours || '')
                    .input('date', sql.Date, input.inspectionDate)
                    .input('selfId', sql.Int, id || 0)
                    .query(`SELECT TOP 1 ReportNo FROM QC_Inspection WITH (UPDLOCK, HOLDLOCK)
                            WHERE DcNo = @dcNo AND StyleName = @style AND InspectionType = @type
                              AND ISNULL(Colours, '') = @colours AND InspectionDate = @date AND Id <> @selfId`);
                if (dup.recordset.length) {
                    throw new ValidationError(
                        `An inspection for DC ${input.dcNo} / ${input.styleName} (${input.inspectionType}, same colour and date) already exists: ${dup.recordset[0].ReportNo}.`,
                        409, { existingReportNo: dup.recordset[0].ReportNo });
                }
            }

            const mp = evaluation.majorPlan, np = evaluation.minorPlan;
            const status = action === 'submit' ? 'SUBMITTED' : 'DRAFT';
            const r = transaction.request()
                .input('docType', sql.NVarChar, input.docType)
                .input('docNum', sql.NVarChar, input.docNum)
                .input('docEntry', sql.Int, input.docEntry)
                .input('supplierCode', sql.NVarChar, input.supplierCode)
                .input('supplierName', sql.NVarChar, input.supplierName)
                .input('brandName', sql.NVarChar, input.brandName)
                .input('styleName', sql.NVarChar, input.styleName)
                .input('colours', sql.NVarChar, input.colours)
                .input('dcNo', sql.NVarChar, input.dcNo)
                .input('sizes', sql.NVarChar, input.sizes)
                .input('orderQty', sql.Int, input.orderQty)
                .input('lotQty', sql.Int, input.lotQty)
                .input('inspectedQty', sql.Int, input.inspectedQty)
                .input('inspectionDate', sql.Date, input.inspectionDate)
                .input('inspectionType', sql.NVarChar, input.inspectionType)
                .input('measurementUnit', sql.NVarChar, input.measurementUnit)
                .input('inspectionLevel', sql.NVarChar, input.inspectionLevel)
                .input('aqlMajor', sql.Decimal(6, 3), input.aqlMajor)
                .input('aqlMinor', sql.Decimal(6, 3), input.aqlMinor)
                .input('codeLetter', sql.NVarChar, mp?.codeLetter || null)
                .input('sampleSize', sql.Int, evaluation.requiredSample)
                .input('majorAc', sql.Int, mp ? mp.ac : null)
                .input('majorRe', sql.Int, mp ? mp.re : null)
                .input('minorAc', sql.Int, np ? np.ac : null)
                .input('minorRe', sql.Int, np ? np.re : null)
                .input('measurementResult', sql.NVarChar, input.measurementResult)
                .input('measurementComments', sql.NVarChar, input.measurementComments)
                .input('packingResult', sql.NVarChar, input.packingResult)
                .input('packingComments', sql.NVarChar, input.packingComments)
                .input('totalMajor', sql.Int, evaluation.totalMajor)
                .input('totalMinor', sql.Int, evaluation.totalMinor)
                .input('majorResult', sql.NVarChar, evaluation.majorResult)
                .input('minorResult', sql.NVarChar, evaluation.minorResult)
                .input('systemResult', sql.NVarChar, evaluation.systemResult)
                .input('finalResult', sql.NVarChar, input.finalResult)
                .input('faultDescription', sql.NVarChar, input.faultDescription)
                .input('defectComments', sql.NVarChar, input.defectComments)
                .input('finalRemarks', sql.NVarChar, input.finalRemarks)
                .input('inspectorName', sql.NVarChar, input.inspectorName)
                .input('unitIncharge', sql.NVarChar, input.unitIncharge)
                .input('merchandiser', sql.NVarChar, input.merchandiser)
                .input('amqc', sql.NVarChar, input.amqc)
                .input('gm', sql.NVarChar, input.gm)
                .input('status', sql.NVarChar, status)
                .input('by', sql.NVarChar, by);

            const cols = `
                DocType=@docType, DocNum=@docNum, DocEntry=@docEntry, SupplierCode=@supplierCode, SupplierName=@supplierName, BrandName=@brandName,
                StyleName=@styleName, Colours=@colours, DcNo=@dcNo, Sizes=@sizes, OrderQty=@orderQty, LotQty=@lotQty,
                InspectedQty=@inspectedQty, InspectionDate=@inspectionDate, InspectionType=@inspectionType,
                MeasurementUnit=@measurementUnit, InspectionLevel=@inspectionLevel, AqlMajor=@aqlMajor, AqlMinor=@aqlMinor,
                CodeLetter=@codeLetter, SampleSize=@sampleSize, MajorAc=@majorAc, MajorRe=@majorRe, MinorAc=@minorAc, MinorRe=@minorRe,
                MeasurementResult=@measurementResult, MeasurementComments=@measurementComments,
                PackingResult=@packingResult, PackingComments=@packingComments,
                TotalMajor=@totalMajor, TotalMinor=@totalMinor, MajorResult=@majorResult, MinorResult=@minorResult,
                SystemResult=@systemResult, FinalResult=@finalResult, FaultDescription=@faultDescription,
                DefectComments=@defectComments, FinalRemarks=@finalRemarks, InspectorName=@inspectorName,
                UnitIncharge=@unitIncharge, Merchandiser=@merchandiser, Amqc=@amqc, Gm=@gm, Status=@status`;

            if (id) {
                r.input('id', sql.Int, id);
                await r.query(`
                    UPDATE QC_Inspection SET ${cols},
                        SubmittedAt = CASE WHEN @status = 'SUBMITTED' THEN GETDATE() ELSE SubmittedAt END,
                        SubmittedBy = CASE WHEN @status = 'SUBMITTED' THEN @by ELSE SubmittedBy END,
                        ApprovedAt = NULL, ApprovedBy = NULL,
                        UpdatedAt = GETDATE(), UpdatedBy = @by
                    WHERE Id = @id`);
                await transaction.request().input('id', sql.Int, id)
                    .query('DELETE FROM QC_InspectionDefects WHERE InspectionId = @id');
            } else {
                reportNo = await nextReportNo(transaction);
                r.input('reportNo', sql.NVarChar, reportNo).input('clientToken', sql.NVarChar, clientToken);
                const ins = await r.query(`
                    INSERT INTO QC_Inspection (ReportNo, ClientToken, CreatedBy, CreatedAt) OUTPUT INSERTED.Id
                    VALUES (@reportNo, @clientToken, @by, GETDATE());
                    UPDATE QC_Inspection SET ${cols},
                        SubmittedAt = CASE WHEN @status = 'SUBMITTED' THEN GETDATE() ELSE NULL END,
                        SubmittedBy = CASE WHEN @status = 'SUBMITTED' THEN @by ELSE NULL END
                    WHERE Id = SCOPE_IDENTITY();`);
                inspectionId = ins.recordset[0].Id;
            }

            for (const d of defects) {
                await transaction.request()
                    .input('id', sql.Int, inspectionId)
                    .input('cat', sql.NVarChar, d.category)
                    .input('name', sql.NVarChar, d.defectName)
                    .input('maj', sql.Int, d.majorQty)
                    .input('min', sql.Int, d.minorQty)
                    .input('custom', sql.Bit, d.isCustom ? 1 : 0)
                    .input('ord', sql.Int, d.sortOrder)
                    .query(`INSERT INTO QC_InspectionDefects (InspectionId, Category, DefectName, MajorQty, MinorQty, IsCustom, SortOrder)
                            VALUES (@id, @cat, @name, @maj, @min, @custom, @ord)`);
            }

            await transaction.commit();
            const data = await loadInspection(req, inspectionId);
            res.json({
                status: 1,
                message: action === 'submit' ? `Report ${reportNo} submitted for approval.` : `Report ${reportNo} saved as draft.`,
                data,
                warnings: evaluation.warnings,
            });
        } catch (err) {
            try { await transaction.rollback(); } catch { /* already rolled back by SQL Server */ }
            throw err;
        }
    } catch (err) {
        if (err instanceof ValidationError) return res.status(err.status).json({ status: 0, message: err.message, ...err.extra });
        if (err && (err.number === 2627 || err.number === 2601)) {
            return res.status(409).json({ status: 0, message: 'This report was just saved by another request. Refresh and try again.' });
        }
        sendServerError(res, err, 'qc/save', 'Failed to save the inspection.');
    }
});

// ── POST /approve/:id — { decision: 'APPROVE' | 'REJECT', remarks, rowVersion } ──
router.post('/approve/:id', authorizeAny('qcApprove'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const decision = upper(req.body?.decision, 10);
    const remarks = str(req.body?.remarks, 1000);
    if (!id) return res.status(400).json({ status: 0, message: 'Invalid inspection id.' });
    if (!['APPROVE', 'REJECT'].includes(decision)) return res.status(400).json({ status: 0, message: 'Decision must be APPROVE or REJECT.' });
    if (decision === 'REJECT' && !remarks) return res.status(400).json({ status: 0, message: 'Remarks are required to reject a report.' });

    try {
        const p = await getPool();
        const request = p.request()
            .input('id', sql.Int, id)
            .input('status', sql.NVarChar, decision === 'APPROVE' ? 'APPROVED' : 'REJECTED')
            .input('remarks', sql.NVarChar, remarks)
            .input('by', sql.NVarChar, userName(req.user));
        let rvCheck = '';
        if (req.body?.rowVersion) {
            request.input('rv', sql.VarBinary, Buffer.from(String(req.body.rowVersion), 'hex'));
            rvCheck = ' AND RowVer = @rv';
        }
        const scope = vendorScope(req, request);
        const r = await request.query(`
            UPDATE QC_Inspection
            SET Status = @status, ApprovalRemarks = @remarks, ApprovedBy = @by, ApprovedAt = GETDATE(),
                UpdatedAt = GETDATE(), UpdatedBy = @by
            WHERE Id = @id AND Status = 'SUBMITTED'${rvCheck}${scope}`);
        if (r.rowsAffected[0] === 0) {
            return res.status(409).json({ status: 0, message: 'Only submitted reports can be approved or rejected. Reload the report — it may have changed.' });
        }
        const data = await loadInspection(req, id);
        res.json({ status: 1, message: decision === 'APPROVE' ? `Report ${data.reportNo} approved.` : `Report ${data.reportNo} rejected and returned to the inspector.`, data });
    } catch (err) {
        sendServerError(res, err, 'qc/approve', 'Failed to update the approval status.');
    }
});

// ── POST /delete/:id — drafts only ────────────────────────
router.post('/delete/:id', authorizeAny('qcInspection'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ status: 0, message: 'Invalid inspection id.' });
    try {
        const p = await getPool();
        const request = p.request().input('id', sql.Int, id);
        const scope = vendorScope(req, request);
        const r = await request.query(`DELETE FROM QC_Inspection WHERE Id = @id AND Status = 'DRAFT'${scope}`);
        if (r.rowsAffected[0] === 0) return res.status(409).json({ status: 0, message: 'Only draft reports can be deleted.' });
        res.json({ status: 1, message: 'Draft deleted.' });
    } catch (err) {
        sendServerError(res, err, 'qc/delete', 'Failed to delete the draft.');
    }
});

// ── Defect photos (sheet "DEFECT PHOTO") ──────────────────
async function assertEditable(req, id) {
    const p = await getPool();
    const request = p.request().input('id', sql.Int, id);
    const scope = vendorScope(req, request);
    const r = await request.query(`SELECT Status FROM QC_Inspection WHERE Id = @id${scope}`);
    if (!r.recordset.length) throw new ValidationError('Inspection not found.', 404);
    if (!['DRAFT', 'REJECTED'].includes(r.recordset[0].Status)) {
        throw new ValidationError(`This report is ${r.recordset[0].Status}; photos can no longer be changed.`, 409);
    }
}

// GET /photos/:id — all photos with image data (for viewing / printing)
router.get('/photos/:id', canView, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ status: 0, message: 'Invalid inspection id.' });
    try {
        const p = await getPool();
        const request = p.request().input('id', sql.Int, id);
        const scope = vendorScope(req, request, 'i.');
        const r = await request.query(`
            SELECT ph.Id, ph.Caption, ph.MimeType, ph.ImageData
            FROM QC_DefectPhotos ph JOIN QC_Inspection i ON i.Id = ph.InspectionId
            WHERE ph.InspectionId = @id${scope} ORDER BY ph.Id`);
        res.json({
            status: 1,
            data: r.recordset.map(ph => ({
                id: ph.Id, caption: ph.Caption,
                dataUrl: `data:${ph.MimeType};base64,${Buffer.from(ph.ImageData).toString('base64')}`,
            })),
        });
    } catch (err) {
        sendServerError(res, err, 'qc/photos', 'Failed to load defect photos.');
    }
});

// POST /photos/:id — { caption, dataUrl } (one photo per request; the client downsizes before upload)
router.post('/photos/:id', authorizeAny('qcInspection'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const caption = upper(req.body?.caption, 200);
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.dataUrl || ''));
    if (!id) return res.status(400).json({ status: 0, message: 'Invalid inspection id.' });
    if (!caption) return res.status(400).json({ status: 0, message: 'A caption describing the defect is required.' });
    if (!m) return res.status(400).json({ status: 0, message: 'Photo must be a JPEG, PNG or WEBP image.' });
    const bytes = Buffer.from(m[2], 'base64');
    if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) {
        return res.status(400).json({ status: 0, message: 'Photo is empty or larger than 1.5 MB.' });
    }
    try {
        await assertEditable(req, id);
        const r = await pool.request()
            .input('id', sql.Int, id)
            .input('caption', sql.NVarChar, caption)
            .input('mime', sql.NVarChar, m[1])
            .input('data', sql.VarBinary(sql.MAX), bytes)
            .input('by', sql.NVarChar, userName(req.user))
            .input('max', sql.Int, MAX_PHOTOS)
            .query(`
                IF (SELECT COUNT(*) FROM QC_DefectPhotos WHERE InspectionId = @id) >= @max
                    SELECT CAST(NULL AS INT) AS Id
                ELSE
                    INSERT INTO QC_DefectPhotos (InspectionId, Caption, MimeType, ImageData, CreatedBy)
                    OUTPUT INSERTED.Id VALUES (@id, @caption, @mime, @data, @by)`);
        const newId = r.recordset[0]?.Id;
        if (!newId) return res.status(400).json({ status: 0, message: `A report can hold at most ${MAX_PHOTOS} photos.` });
        res.json({ status: 1, message: 'Photo added.', data: { id: newId, caption } });
    } catch (err) {
        if (err instanceof ValidationError) return res.status(err.status).json({ status: 0, message: err.message });
        sendServerError(res, err, 'qc/photos/add', 'Failed to save the photo.');
    }
});

// POST /photos/delete/:photoId
router.post('/photos/delete/:photoId', authorizeAny('qcInspection'), async (req, res) => {
    const photoId = parseInt(req.params.photoId, 10);
    if (!photoId) return res.status(400).json({ status: 0, message: 'Invalid photo id.' });
    try {
        const p = await getPool();
        const r = await p.request().input('pid', sql.Int, photoId)
            .query('SELECT InspectionId FROM QC_DefectPhotos WHERE Id = @pid');
        if (!r.recordset.length) return res.status(404).json({ status: 0, message: 'Photo not found.' });
        await assertEditable(req, r.recordset[0].InspectionId);
        await p.request().input('pid', sql.Int, photoId).query('DELETE FROM QC_DefectPhotos WHERE Id = @pid');
        res.json({ status: 1, message: 'Photo removed.' });
    } catch (err) {
        if (err instanceof ValidationError) return res.status(err.status).json({ status: 0, message: err.message });
        sendServerError(res, err, 'qc/photos/delete', 'Failed to remove the photo.');
    }
});

// Exposed for tests.
router._internals = { normalise, groupBinningDocs, defectsToStore, mapHeader, DEFAULT_DEFECTS, newClientToken: () => crypto.randomUUID() };

module.exports = router;
