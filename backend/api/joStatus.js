const express = require('express');
const router  = express.Router();
const { pool, sql } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('joStatus'));

let tablesReady = false;

const STAGE_COL_MAP = {
    fusingComponent:  'FusingComponent',
    sewingAssembly:   'SewingAssembly',
    finishingSewing:  'FinishingSewing',
    qualityFinishing: 'QualityFinishing',
    packingDispatch:  'PackingDispatch',
};

// Maps each stage key → the JO_StageStatus column of the PREVIOUS stage
const PREV_COL_MAP = {
    fusingComponent:  'FabricPreparation',
    sewingAssembly:   'FusingComponent',
    finishingSewing:  'SewingAssembly',
    qualityFinishing: 'FinishingSewing',
    packingDispatch:  'QualityFinishing',
};

// Maps each JO_StageStatus column → the column of the NEXT stage
const NEXT_COL_MAP = {
    FabricPreparation: 'FusingComponent',
    FusingComponent:   'SewingAssembly',
    SewingAssembly:    'FinishingSewing',
    FinishingSewing:   'QualityFinishing',
    QualityFinishing:  'PackingDispatch',
};

const COL_LABELS = {
    FabricPreparation: 'Fabric Preparation',
    FusingComponent:   'Fusing & Component Preparation',
    SewingAssembly:    'Sewing Assembly',
    FinishingSewing:   'Finishing Sewing',
    QualityFinishing:  'Quality & Finishing',
    PackingDispatch:   'Packing & Dispatch',
};

// Reads the JO's stage quantities inside the given transaction, locking the row so
// concurrent saves for the same JO are validated one at a time.
async function readStageRow(transaction, joId) {
    const r = await transaction.request()
        .input('joId_lock', sql.Int, joId)
        .query(`
            SELECT TOP 1
                ISNULL(FabricPreparation, 0) AS FabricPreparation,
                ISNULL(FusingComponent,   0) AS FusingComponent,
                ISNULL(SewingAssembly,    0) AS SewingAssembly,
                ISNULL(FinishingSewing,   0) AS FinishingSewing,
                ISNULL(QualityFinishing,  0) AS QualityFinishing,
                ISNULL(PackingDispatch,   0) AS PackingDispatch
            FROM JO_StageStatus WITH (UPDLOCK, HOLDLOCK)
            WHERE JO_Id = @joId_lock
            ORDER BY UpdatedAt DESC
        `);
    return r.recordset[0] || {
        FabricPreparation: 0, FusingComponent: 0, SewingAssembly: 0,
        FinishingSewing: 0, QualityFinishing: 0, PackingDispatch: 0,
    };
}

// Returns an error message when adding `addQty` to `stage` would exceed the
// previous stage's completed qty; null when OK.
function stageCapacityError(row, stage, addQty) {
    const col     = STAGE_COL_MAP[stage];
    const prevCol = PREV_COL_MAP[stage];
    const prevQty    = Number(row[prevCol]) || 0;
    const currentQty = Number(row[col])     || 0;
    if (prevQty <= 0) {
        return `${COL_LABELS[prevCol]} has no completed qty yet. ` +
               `Complete the previous stage before adding ${COL_LABELS[col]} entries.`;
    }
    if (currentQty + addQty > prevQty) {
        const allowed = Math.max(0, prevQty - currentQty);
        return `Entry total (${addQty} pcs) exceeds available capacity. ` +
               `${COL_LABELS[prevCol]} completed: ${prevQty} pcs, already saved this stage: ${currentQty} pcs, ` +
               `maximum allowed: ${allowed} pcs.`;
    }
    return null;
}

// Returns an error message when reducing `col` to `newQty` would leave it below
// the next stage's saved qty; null when OK.
function downstreamError(row, col, newQty) {
    const nextCol = NEXT_COL_MAP[col];
    if (!nextCol) return null;
    const nextQty = Number(row[nextCol]) || 0;
    if (newQty < nextQty) {
        return `${COL_LABELS[col]} cannot go below ${nextQty} pcs — ` +
               `${COL_LABELS[nextCol]} already has ${nextQty} pcs recorded. ` +
               `Reduce ${COL_LABELS[nextCol]} first.`;
    }
    return null;
}

// ── Size-wise (colour × sleeve × size) validation ──────────
// Applies from Sewing Assembly onward — Fusing's previous stage (Fabric Preparation)
// is a single total with no size breakdown.
const STAGE_ORDER = [
    'fabricPreparation', 'fusingComponent', 'sewingAssembly',
    'finishingSewing', 'qualityFinishing', 'packingDispatch',
];
const isSizeWiseStage = stage => STAGE_ORDER.indexOf(stage) >= 2;
const prevStageKey    = stage => STAGE_ORDER[STAGE_ORDER.indexOf(stage) - 1];
const nextStageKey    = stage => STAGE_ORDER[STAGE_ORDER.indexOf(stage) + 1];
const stageLabel      = stage => COL_LABELS[STAGE_COL_MAP[stage]] || stage;

const cellKey   = (colour, slive, size) =>
    [colour, slive, size].map(v => String(v ?? '').trim().toUpperCase()).join('|||');
const cellLabel = (colour, slive, size) =>
    [colour, slive, size].map(v => String(v ?? '').trim()).filter(Boolean).join(' / ') || '(no colour/size)';

// Returns { [stage]: { [cellKey]: qty } } for every stage of the JO
async function readCellTotals(transaction, joId) {
    const r = await transaction.request()
        .input('joId_cells', sql.Int, joId)
        .query(`
            SELECT Stage, Colour, Slive, Size, SUM(Qty) AS Qty
            FROM JO_LineEntries
            WHERE JO_Id = @joId_cells
            GROUP BY Stage, Colour, Slive, Size
        `);
    const out = {};
    for (const row of r.recordset) {
        const m = out[row.Stage] || (out[row.Stage] = {});
        const k = cellKey(row.Colour, row.Slive, row.Size);
        m[k] = (m[k] || 0) + (Number(row.Qty) || 0);
    }
    return out;
}

// Returns an error message when any colour/size cell being added exceeds what the
// previous stage completed for that same cell; null when OK.
function sizeWiseCapacityError(cells, stage, entries) {
    const prev     = prevStageKey(stage);
    const incoming = {};
    const labels   = {};
    for (const e of entries) {
        const k = cellKey(e.colour, e.slive, e.size);
        incoming[k] = (incoming[k] || 0) + Number(e.qty);
        labels[k]   = cellLabel(e.colour, e.slive, e.size);
    }
    const over = [];
    for (const [k, qty] of Object.entries(incoming)) {
        const avail = Math.max(0, (cells[prev]?.[k] || 0) - (cells[stage]?.[k] || 0));
        if (qty > avail) over.push(`${labels[k]}: entered ${qty}, available ${avail}`);
    }
    if (!over.length) return null;
    return `Size-wise qty exceeds ${stageLabel(prev)} completed qty — ` +
           over.slice(0, 5).join('; ') +
           (over.length > 5 ? `; +${over.length - 5} more` : '') + '.';
}

class ValidationError extends Error {}

async function ensureTables() {
    // JO_Master
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='JO_Master' AND xtype='U')
        CREATE TABLE JO_Master (
            Id          INT IDENTITY(1,1) PRIMARY KEY,
            JO_No       NVARCHAR(100) NOT NULL,
            DocType     NVARCHAR(50),
            DocNum      NVARCHAR(100),
            VendorCode  NVARCHAR(50),
            VendorName  NVARCHAR(200),
            Style       NVARCHAR(200),
            OrderQty    INT           NOT NULL DEFAULT 0,
            EntryDate   DATE,
            Status      NVARCHAR(50)  DEFAULT 'Active',
            CreatedAt   DATETIME      DEFAULT GETDATE(),
            CreatedBy   NVARCHAR(100)
        )
    `);

    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='JO_Master' AND COLUMN_NAME='DocType')
        ALTER TABLE JO_Master ADD DocType NVARCHAR(50)
    `);
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='JO_Master' AND COLUMN_NAME='DocNum')
        ALTER TABLE JO_Master ADD DocNum NVARCHAR(100)
    `);

    // JO_StageStatus — one row per JO_Id, maintained by UPSERT
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='JO_StageStatus' AND xtype='U')
        CREATE TABLE JO_StageStatus (
            Id                  INT IDENTITY(1,1) PRIMARY KEY,
            JO_Id               INT           NOT NULL,
            FabricPreparation   INT           DEFAULT 0,
            FusingComponent     INT           DEFAULT 0,
            SewingAssembly      INT           DEFAULT 0,
            FinishingSewing     INT           DEFAULT 0,
            QualityFinishing    INT           DEFAULT 0,
            PackingDispatch     INT           DEFAULT 0,
            TotalStageQty       INT           DEFAULT 0,
            UpdatedAt           DATETIME      DEFAULT GETDATE(),
            UpdatedBy           NVARCHAR(100)
        )
    `);

    // JO_StatusHistory — stage 1 audit log
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='JO_StatusHistory' AND xtype='U')
        CREATE TABLE JO_StatusHistory (
            Id                  INT IDENTITY(1,1) PRIMARY KEY,
            JO_Id               INT           NOT NULL,
            JO_No               NVARCHAR(100),
            FabricPreparation   INT           DEFAULT 0,
            TotalStageQty       INT           DEFAULT 0,
            Remarks             NVARCHAR(500),
            UpdatedAt           DATETIME      DEFAULT GETDATE(),
            UpdatedBy           NVARCHAR(100)
        )
    `);

    // JO_VendorEntry — final vendor entry created from packing dispatch qty
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='JO_VendorEntry' AND xtype='U')
        CREATE TABLE JO_VendorEntry (
            Id                  INT IDENTITY(1,1) PRIMARY KEY,
            JO_Id               INT           NOT NULL,
            JO_No               NVARCHAR(100),
            VendorCode          NVARCHAR(50),
            VendorName          NVARCHAR(200),
            OrderQty            INT           DEFAULT 0,
            FabricPreparation   INT           DEFAULT 0,
            FusingComponent     INT           DEFAULT 0,
            SewingAssembly      INT           DEFAULT 0,
            FinishingSewing     INT           DEFAULT 0,
            QualityFinishing    INT           DEFAULT 0,
            PackingDispatch     INT           DEFAULT 0,
            FinalQty            INT           DEFAULT 0,
            EntryDate           DATE,
            CreatedAt           DATETIME      DEFAULT GETDATE(),
            CreatedBy           NVARCHAR(100)
        )
    `);

    // JO_LineEntries — line-wise / time-wise entries for stages 2–6
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM sysobjects WHERE name='JO_LineEntries' AND xtype='U')
        CREATE TABLE JO_LineEntries (
            Id          INT IDENTITY(1,1) PRIMARY KEY,
            JO_Id       INT           NOT NULL,
            Stage       NVARCHAR(50)  NOT NULL,
            [LineNo]    NVARCHAR(50),
            EntryTime   NVARCHAR(10),
            EntryDate   DATE          DEFAULT CAST(GETDATE() AS DATE),
            Colour      NVARCHAR(100),
            Slive       NVARCHAR(50),
            Size        NVARCHAR(50),
            Qty         INT           DEFAULT 0,
            CreatedAt   DATETIME      DEFAULT GETDATE(),
            CreatedBy   NVARCHAR(100)
        )
    `);
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='JO_LineEntries' AND COLUMN_NAME='Colour')
        ALTER TABLE JO_LineEntries ADD Colour NVARCHAR(100)
    `);
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='JO_LineEntries' AND COLUMN_NAME='Size')
        ALTER TABLE JO_LineEntries ADD Size NVARCHAR(50)
    `);
    await pool.request().query(`
        IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME='JO_LineEntries' AND COLUMN_NAME='Slive')
        ALTER TABLE JO_LineEntries ADD Slive NVARCHAR(50)
    `);
}

async function getPool() {
    if (!tablesReady) { await ensureTables(); tablesReady = true; }
    return pool;
}

// ── Vendor data scoping ────────────────────────────────────
// Vendors only see/touch JOs raised against their own party code (CardCode).
// Admin, manager and inventory users see all JOs.
const isVendor = user => user?.role === 'vendor';

// Rejects any request carrying a joId that belongs to another vendor.
router.use(async (req, res, next) => {
    if (!isVendor(req.user)) return next();

    const partyCode = String(req.user.partyCode || '').trim();
    if (!partyCode) return res.status(403).json({ status: 0, message: 'Vendor account has no party code.' });

    const joId = req.body?.joId;
    if (!joId) return next();

    try {
        const p = await getPool();
        const r = await p.request()
            .input('joId_own', sql.Int, joId)
            .query('SELECT VendorCode FROM JO_Master WHERE Id = @joId_own');
        const owner = String(r.recordset[0]?.VendorCode || '').trim();
        if (owner !== partyCode) {
            return res.status(403).json({ status: 0, message: 'You do not have access to this JO.' });
        }
        return next();
    } catch (err) {
        console.error('JO vendor access check error:', err);
        res.status(500).json({ status: 0, message: "An unexpected error occurred. Please try again later." });
    }
});

// ── POST /createJo ─────────────────────────────────────────
router.post('/createJo', async (req, res) => {
    const {
        docType, docNum, style,
        orderQty, entryDate,
        fabricPreparation, remarks
    } = req.body;
    let { vendorCode, vendorName } = req.body;
    // Vendors can only raise JOs against themselves
    if (isVendor(req.user)) {
        vendorCode = req.user.partyCode;
        vendorName = req.user.name || vendorName;
    }
    const createdBy = req.user?.name || req.user?.username || 'System';

    if (!docNum || !orderQty) {
        return res.status(400).json({ status: 0, message: 'Document number and order quantity are required' });
    }
    if (Number(orderQty) <= 0) {
        return res.status(400).json({ status: 0, message: 'Order quantity must be greater than 0' });
    }

    const fp = Math.max(0, Number(fabricPreparation) || 0);

    if (fp > Number(orderQty)) {
        return res.status(400).json({ status: 0, message: `Fabric qty (${fp}) exceeds order quantity (${orderQty})` });
    }

    try {
        const p = await getPool();

        const dup = await p.request()
            .input('docNum',  sql.NVarChar, docNum.trim())
            .input('docType', sql.NVarChar, docType || '')
            .query(`SELECT 1 FROM JO_Master WHERE JO_No = @docNum AND (DocType = @docType OR DocType IS NULL OR DocType = '')`);

        if (dup.recordset.length > 0) {
            return res.status(400).json({ status: 0, message: `Entry for ${docType} "${docNum}" already exists` });
        }

        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            const insertRes = await transaction.request()
                .input('joNo',       sql.NVarChar, docNum.trim())
                .input('docType',    sql.NVarChar, docType    || '')
                .input('docNum',     sql.NVarChar, docNum.trim())
                .input('vendorCode', sql.NVarChar, vendorCode || '')
                .input('vendorName', sql.NVarChar, vendorName || '')
                .input('style',      sql.NVarChar, style      || '')
                .input('orderQty',   sql.Int,      Number(orderQty))
                .input('entryDate',  sql.Date,     entryDate ? new Date(entryDate) : new Date())
                .input('createdBy',  sql.NVarChar, createdBy || 'System')
                .query(`
                    INSERT INTO JO_Master
                        (JO_No, DocType, DocNum, VendorCode, VendorName, Style, OrderQty, EntryDate, CreatedBy)
                    OUTPUT INSERTED.Id
                    VALUES
                        (@joNo, @docType, @docNum, @vendorCode, @vendorName, @style, @orderQty, @entryDate, @createdBy)
                `);

            const newId = insertRes.recordset[0].Id;

            await transaction.request()
                .input('joId', sql.Int,      newId)
                .input('fp',   sql.Int,      fp)
                .input('upBy', sql.NVarChar, createdBy || 'System')
                .query(`INSERT INTO JO_StageStatus (JO_Id, FabricPreparation, TotalStageQty, UpdatedBy)
                        VALUES (@joId, @fp, @fp, @upBy)`);

            if (fp > 0) {
                await transaction.request()
                    .input('joId', sql.Int,      newId)
                    .input('joNo', sql.NVarChar, docNum.trim())
                    .input('fp',   sql.Int,      fp)
                    .input('rmk',  sql.NVarChar, remarks || '')
                    .input('upBy', sql.NVarChar, createdBy || 'System')
                    .query(`INSERT INTO JO_StatusHistory (JO_Id, JO_No, FabricPreparation, TotalStageQty, Remarks, UpdatedBy)
                            VALUES (@joId, @joNo, @fp, @fp, @rmk, @upBy)`);
            }

            await transaction.commit();
            res.json({ status: 1, message: `Entry for "${docNum}" saved successfully`, joId: newId });
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) {
        console.error('JO createJo error:', err);
        res.status(500).json({ status: 0, message: "An unexpected error occurred. Please try again later." });
    }
});

// ── POST /list ─────────────────────────────────────────────
router.post('/list', async (req, res) => {
    try {
        const p = await getPool();
        const vendorOnly = isVendor(req.user);
        const request = p.request();
        if (vendorOnly) request.input('partyCode', sql.NVarChar, String(req.user.partyCode || '').trim());
        const result = await request.query(`
            SELECT
                m.Id, m.JO_No, m.DocType, m.DocNum,
                m.VendorCode, m.VendorName, m.Style,
                m.OrderQty, m.EntryDate, m.Status, m.CreatedBy,
                ISNULL(s.FabricPreparation, 0) AS FabricPreparation,
                ISNULL(s.FusingComponent,   0) AS FusingComponent,
                ISNULL(s.SewingAssembly,    0) AS SewingAssembly,
                ISNULL(s.FinishingSewing,   0) AS FinishingSewing,
                ISNULL(s.QualityFinishing,  0) AS QualityFinishing,
                ISNULL(s.PackingDispatch,   0) AS PackingDispatch,
                ISNULL(s.TotalStageQty,     0) AS TotalStageQty,
                s.UpdatedAt, s.UpdatedBy,
                (SELECT TOP 1 Id FROM JO_VendorEntry WHERE JO_Id = m.Id) AS VendorEntryId
            FROM JO_Master m
            LEFT JOIN (
                SELECT JO_Id,
                       FabricPreparation, FusingComponent, SewingAssembly,
                       FinishingSewing,   QualityFinishing, PackingDispatch,
                       TotalStageQty, UpdatedAt, UpdatedBy,
                       ROW_NUMBER() OVER (PARTITION BY JO_Id ORDER BY UpdatedAt DESC) AS rn
                FROM JO_StageStatus
            ) s ON s.JO_Id = m.Id AND s.rn = 1
            WHERE m.Status = 'Active'
              ${vendorOnly ? 'AND LTRIM(RTRIM(m.VendorCode)) = @partyCode' : ''}
            ORDER BY m.CreatedAt DESC
        `);
        res.json({ status: 1, data: result.recordset });
    } catch (err) {
        console.error('JO list error:', err);
        res.status(500).json({ status: 0, message: "An unexpected error occurred. Please try again later." });
    }
});

// ── POST /saveStage1 ───────────────────────────────────────
// Stage 1 (Fabric Preparation) — total qty entry only
router.post('/saveStage1', async (req, res) => {
    const { joId, joNo, qty } = req.body;
    const updatedBy = req.user?.name || req.user?.username || 'System';
    if (!joId) return res.status(400).json({ status: 0, message: 'joId is required' });

    const qtyNum = Math.max(0, Number(qty) || 0);

    try {
        await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            // Fabric qty must stay within Order Qty and not drop below Fusing's saved qty
            const orderRes = await transaction.request()
                .input('joId_o', sql.Int, joId)
                .query('SELECT OrderQty FROM JO_Master WHERE Id = @joId_o');
            const orderQty = Number(orderRes.recordset[0]?.OrderQty) || 0;
            if (orderQty > 0 && qtyNum > orderQty) {
                throw new ValidationError(`Fabric qty (${qtyNum}) exceeds order quantity (${orderQty})`);
            }
            const stageRow = await readStageRow(transaction, joId);
            const downErr  = downstreamError(stageRow, 'FabricPreparation', qtyNum);
            if (downErr) throw new ValidationError(downErr);

            // UPSERT JO_StageStatus — update FabricPreparation in-place, preserve other columns
            await transaction.request()
                .input('joId', sql.Int,      joId)
                .input('fp',   sql.Int,      qtyNum)
                .input('upBy', sql.NVarChar, updatedBy || 'System')
                .query(`
                    IF EXISTS (SELECT 1 FROM JO_StageStatus WHERE JO_Id = @joId)
                        UPDATE JO_StageStatus SET
                            FabricPreparation = @fp,
                            TotalStageQty = @fp + FusingComponent + SewingAssembly +
                                            FinishingSewing + QualityFinishing + PackingDispatch,
                            UpdatedAt = GETDATE(), UpdatedBy = @upBy
                        WHERE JO_Id = @joId
                    ELSE
                        INSERT INTO JO_StageStatus (JO_Id, FabricPreparation, TotalStageQty, UpdatedBy)
                        VALUES (@joId, @fp, @fp, @upBy)
                `);

            // Audit log
            await transaction.request()
                .input('joId', sql.Int,      joId)
                .input('joNo', sql.NVarChar, joNo || '')
                .input('fp',   sql.Int,      qtyNum)
                .input('upBy', sql.NVarChar, updatedBy || 'System')
                .query(`INSERT INTO JO_StatusHistory (JO_Id, JO_No, FabricPreparation, TotalStageQty, UpdatedBy)
                        VALUES (@joId, @joNo, @fp, @fp, @upBy)`);

            await transaction.commit();
            res.json({ status: 1, message: 'Fabric Preparation qty saved', qty: qtyNum });
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) {
        if (err instanceof ValidationError) return res.status(400).json({ status: 0, message: err.message });
        console.error('saveStage1 error:', err);
        res.status(500).json({ status: 0, message: "An unexpected error occurred. Please try again later." });
    }
});

// ── POST /saveLineEntry ────────────────────────────────────
// Stages 2–6: add a line-wise / time-wise production entry
router.post('/saveLineEntry', async (req, res) => {
    const { joId, stage, lineNo, entryTime, qty } = req.body;
    const createdBy = req.user?.name || req.user?.username || 'System';

    if (!joId || !stage) {
        return res.status(400).json({ status: 0, message: 'joId and stage are required' });
    }

    const col = STAGE_COL_MAP[stage];
    if (!col) return res.status(400).json({ status: 0, message: `Invalid stage: ${stage}` });

    // Total-only entries can't be checked size-wise
    if (isSizeWiseStage(stage)) {
        return res.status(400).json({ status: 0, message: `${stageLabel(stage)} requires colour/size-wise entry` });
    }

    const qtyNum = Math.max(0, Number(qty) || 0);
    if (qtyNum <= 0) return res.status(400).json({ status: 0, message: 'Qty must be greater than 0' });

    try {
        await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            const capErr = stageCapacityError(await readStageRow(transaction, joId), stage, qtyNum);
            if (capErr) throw new ValidationError(capErr);

            const insRes = await transaction.request()
                .input('joId',      sql.Int,      joId)
                .input('stage',     sql.NVarChar, stage)
                .input('lineNo',    sql.NVarChar, lineNo    || '')
                .input('entryTime', sql.NVarChar, entryTime || '')
                .input('qty',       sql.Int,      qtyNum)
                .input('createdBy', sql.NVarChar, createdBy || 'System')
                .query(`
                    INSERT INTO JO_LineEntries (JO_Id, Stage, [LineNo], EntryTime, Qty, CreatedBy)
                    OUTPUT INSERTED.Id
                    VALUES (@joId, @stage, @lineNo, @entryTime, @qty, @createdBy)
                `);

            const newEntryId = insRes.recordset[0].Id;

            // Ensure JO_StageStatus row exists
            await transaction.request()
                .input('joId2', sql.Int,      joId)
                .input('upBy2', sql.NVarChar, createdBy || 'System')
                .query(`
                    IF NOT EXISTS (SELECT 1 FROM JO_StageStatus WHERE JO_Id = @joId2)
                        INSERT INTO JO_StageStatus (JO_Id, UpdatedBy) VALUES (@joId2, @upBy2)
                `);

            // Recompute this stage's total from all its line entries
            await transaction.request()
                .input('joId3',  sql.Int,      joId)
                .input('stage3', sql.NVarChar, stage)
                .input('upBy3',  sql.NVarChar, createdBy || 'System')
                .query(`
                    UPDATE JO_StageStatus SET
                        [${col}] = (SELECT COALESCE(SUM(Qty), 0) FROM JO_LineEntries
                                    WHERE JO_Id = @joId3 AND Stage = @stage3),
                        UpdatedAt = GETDATE(), UpdatedBy = @upBy3
                    WHERE JO_Id = @joId3
                `);

            // Recalculate overall total
            await transaction.request()
                .input('joId4', sql.Int, joId)
                .query(`
                    UPDATE JO_StageStatus SET
                        TotalStageQty = FabricPreparation + FusingComponent + SewingAssembly +
                                        FinishingSewing + QualityFinishing + PackingDispatch
                    WHERE JO_Id = @joId4
                `);

            await transaction.commit();
            res.json({ status: 1, message: 'Line entry saved', entryId: newEntryId });
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) {
        if (err instanceof ValidationError) return res.status(400).json({ status: 0, message: err.message });
        console.error('saveLineEntry error:', err);
        res.status(500).json({ status: 0, message: "An unexpected error occurred. Please try again later." });
    }
});

// ── POST /getLineEntries ───────────────────────────────────
router.post('/getLineEntries', async (req, res) => {
    const { joId } = req.body;
    if (!joId) return res.status(400).json({ status: 0, message: 'joId is required' });

    try {
        const p = await getPool();
        const result = await p.request()
            .input('joId', sql.Int, joId)
            .query(`
                SELECT Id, Stage, [LineNo] AS [LineNo], EntryTime, EntryDate, Colour, Slive, Size, Qty, CreatedAt, CreatedBy
                FROM JO_LineEntries
                WHERE JO_Id = @joId
                ORDER BY Stage, CreatedAt
            `);
        res.json({ status: 1, data: result.recordset });
    } catch (err) {
        console.error('getLineEntries error:', err);
        res.status(500).json({ status: 0, message: "An unexpected error occurred. Please try again later." });
    }
});

// ── POST /deleteLineEntry ──────────────────────────────────
router.post('/deleteLineEntry', async (req, res) => {
    const { entryId, joId, stage } = req.body;

    if (!entryId || !joId || !stage) {
        return res.status(400).json({ status: 0, message: 'entryId, joId, and stage are required' });
    }

    const col = STAGE_COL_MAP[stage];
    if (!col) return res.status(400).json({ status: 0, message: `Invalid stage: ${stage}` });

    try {
        await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            const entryRes = await transaction.request()
                .input('entryId_c', sql.Int,      entryId)
                .input('joId_c',    sql.Int,      joId)
                .input('stage_c',   sql.NVarChar, stage)
                .query('SELECT Qty, Colour, Slive, Size FROM JO_LineEntries WHERE Id = @entryId_c AND JO_Id = @joId_c AND Stage = @stage_c');
            if (!entryRes.recordset.length) throw new ValidationError('Entry not found for this JO / stage');
            const entry = entryRes.recordset[0];

            // Deleting must not leave this stage below what the next stage has already recorded
            const stageRow = await readStageRow(transaction, joId);
            const newQty   = (Number(stageRow[col]) || 0) - (Number(entry.Qty) || 0);
            const downErr  = downstreamError(stageRow, col, newQty);
            if (downErr) throw new ValidationError(downErr);

            // ...and the same per colour/size when the next stage is size-wise limited
            const next = nextStageKey(stage);
            if (next && isSizeWiseStage(next)) {
                const cells   = await readCellTotals(transaction, joId);
                const k       = cellKey(entry.Colour, entry.Slive, entry.Size);
                const after   = (cells[stage]?.[k] || 0) - (Number(entry.Qty) || 0);
                const nextQty = cells[next]?.[k] || 0;
                if (after < nextQty) {
                    throw new ValidationError(
                        `${cellLabel(entry.Colour, entry.Slive, entry.Size)}: ${stageLabel(stage)} would drop to ${after} pcs, ` +
                        `but ${stageLabel(next)} already has ${nextQty} pcs recorded. Delete ${stageLabel(next)} entries first.`
                    );
                }
            }

            await transaction.request()
                .input('entryId', sql.Int, entryId)
                .query('DELETE FROM JO_LineEntries WHERE Id = @entryId');

            // Recompute stage total (entry already deleted, so SUM excludes it)
            await transaction.request()
                .input('joId5',  sql.Int,      joId)
                .input('stage5', sql.NVarChar, stage)
                .input('upBy5',  sql.NVarChar, 'System')
                .query(`
                    UPDATE JO_StageStatus SET
                        [${col}] = (SELECT COALESCE(SUM(Qty), 0) FROM JO_LineEntries
                                    WHERE JO_Id = @joId5 AND Stage = @stage5),
                        UpdatedAt = GETDATE(), UpdatedBy = @upBy5
                    WHERE JO_Id = @joId5
                `);

            // Recalculate overall total
            await transaction.request()
                .input('joId6', sql.Int, joId)
                .query(`
                    UPDATE JO_StageStatus SET
                        TotalStageQty = FabricPreparation + FusingComponent + SewingAssembly +
                                        FinishingSewing + QualityFinishing + PackingDispatch
                    WHERE JO_Id = @joId6
                `);

            await transaction.commit();
            res.json({ status: 1, message: 'Entry deleted' });
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) {
        if (err instanceof ValidationError) return res.status(400).json({ status: 0, message: err.message });
        console.error('deleteLineEntry error:', err);
        res.status(500).json({ status: 0, message: "An unexpected error occurred. Please try again later." });
    }
});

// ── POST /saveMatrixEntries ────────────────────────────────
// Batch insert colour × size entries for stages 2–6
router.post('/saveMatrixEntries', async (req, res) => {
    const { joId, stage, lineNo, entryTime, entries } = req.body;
    const createdBy = req.user?.name || req.user?.username || 'System';

    if (!joId || !stage || !Array.isArray(entries) || !entries.length) {
        return res.status(400).json({ status: 0, message: 'joId, stage, and entries[] are required' });
    }

    const col = STAGE_COL_MAP[stage];
    if (!col) return res.status(400).json({ status: 0, message: `Invalid stage: ${stage}` });

    const validEntries = entries.filter(e => Number(e.qty) > 0);
    if (!validEntries.length) {
        return res.status(400).json({ status: 0, message: 'All quantities are zero' });
    }

    const newTotal  = validEntries.reduce((s, e) => s + Number(e.qty), 0);

    try {
        const p = await getPool();

        const transaction = new sql.Transaction(p);
        await transaction.begin();

        try {
            // Validate against previous stage's completed qty (row locked for the whole save)
            const capErr = stageCapacityError(await readStageRow(transaction, joId), stage, newTotal);
            if (capErr) throw new ValidationError(capErr);

            if (isSizeWiseStage(stage)) {
                const sizeErr = sizeWiseCapacityError(await readCellTotals(transaction, joId), stage, validEntries);
                if (sizeErr) throw new ValidationError(sizeErr);
            }

            for (const entry of validEntries) {
                await transaction.request()
                    .input('joId',      sql.Int,      joId)
                    .input('stage',     sql.NVarChar, stage)
                    .input('lineNo',    sql.NVarChar, lineNo     || '')
                    .input('entryTime', sql.NVarChar, entryTime  || '')
                    .input('colour',    sql.NVarChar, entry.colour || '')
                    .input('slive',     sql.NVarChar, entry.slive  || '')
                    .input('size',      sql.NVarChar, entry.size   || '')
                    .input('qty',       sql.Int,      Number(entry.qty))
                    .input('createdBy', sql.NVarChar, createdBy || 'System')
                    .query(`
                        INSERT INTO JO_LineEntries (JO_Id, Stage, [LineNo], EntryTime, Colour, Slive, Size, Qty, CreatedBy)
                        VALUES (@joId, @stage, @lineNo, @entryTime, @colour, @slive, @size, @qty, @createdBy)
                    `);
            }

            // Ensure JO_StageStatus row exists
            await transaction.request()
                .input('joId2', sql.Int,      joId)
                .input('upBy2', sql.NVarChar, createdBy || 'System')
                .query(`
                    IF NOT EXISTS (SELECT 1 FROM JO_StageStatus WHERE JO_Id = @joId2)
                        INSERT INTO JO_StageStatus (JO_Id, UpdatedBy) VALUES (@joId2, @upBy2)
                `);

            // Recompute stage total
            await transaction.request()
                .input('joId3',  sql.Int,      joId)
                .input('stage3', sql.NVarChar, stage)
                .input('upBy3',  sql.NVarChar, createdBy || 'System')
                .query(`
                    UPDATE JO_StageStatus SET
                        [${col}] = (SELECT COALESCE(SUM(Qty), 0) FROM JO_LineEntries
                                    WHERE JO_Id = @joId3 AND Stage = @stage3),
                        UpdatedAt = GETDATE(), UpdatedBy = @upBy3
                    WHERE JO_Id = @joId3
                `);

            // Recalculate overall total
            await transaction.request()
                .input('joId4', sql.Int, joId)
                .query(`
                    UPDATE JO_StageStatus SET
                        TotalStageQty = FabricPreparation + FusingComponent + SewingAssembly +
                                        FinishingSewing + QualityFinishing + PackingDispatch
                    WHERE JO_Id = @joId4
                `);

            await transaction.commit();
            res.json({ status: 1, message: `${validEntries.length} entries saved`, totalAdded: validEntries.length });
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) {
        if (err instanceof ValidationError) return res.status(400).json({ status: 0, message: err.message });
        console.error('saveMatrixEntries error:', err);
        res.status(500).json({ status: 0, message: "An unexpected error occurred. Please try again later." });
    }
});

// ── POST /saveStatus (legacy, kept for compatibility) ──────
router.post('/saveStatus', async (req, res) => {
    const { joId, joNo, fabricPreparation, remarks } = req.body;
    const updatedBy = req.user?.name || req.user?.username || 'System';
    if (!joId) return res.status(400).json({ status: 0, message: 'joId is required' });

    const fp = Math.max(0, Number(fabricPreparation) || 0);

    try {
        await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            const downErr = downstreamError(await readStageRow(transaction, joId), 'FabricPreparation', fp);
            if (downErr) throw new ValidationError(downErr);

            await transaction.request()
                .input('joId', sql.Int,      joId)
                .input('fp',   sql.Int,      fp)
                .input('upBy', sql.NVarChar, updatedBy || 'System')
                .query(`
                    IF EXISTS (SELECT 1 FROM JO_StageStatus WHERE JO_Id = @joId)
                        UPDATE JO_StageStatus SET
                            FabricPreparation = @fp,
                            TotalStageQty = @fp + FusingComponent + SewingAssembly +
                                            FinishingSewing + QualityFinishing + PackingDispatch,
                            UpdatedAt = GETDATE(), UpdatedBy = @upBy
                        WHERE JO_Id = @joId
                    ELSE
                        INSERT INTO JO_StageStatus (JO_Id, FabricPreparation, TotalStageQty, UpdatedBy)
                        VALUES (@joId, @fp, @fp, @upBy)
                `);

            await transaction.request()
                .input('joId', sql.Int,      joId)
                .input('joNo', sql.NVarChar, joNo || '')
                .input('fp',   sql.Int,      fp)
                .input('rmk',  sql.NVarChar, remarks || '')
                .input('upBy', sql.NVarChar, updatedBy || 'System')
                .query(`INSERT INTO JO_StatusHistory (JO_Id, JO_No, FabricPreparation, TotalStageQty, Remarks, UpdatedBy)
                        VALUES (@joId, @joNo, @fp, @fp, @rmk, @upBy)`);

            await transaction.commit();
            res.json({ status: 1, message: 'Stage status saved', totalQty: fp });
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) {
        if (err instanceof ValidationError) return res.status(400).json({ status: 0, message: err.message });
        console.error('JO saveStatus error:', err);
        res.status(500).json({ status: 0, message: "An unexpected error occurred. Please try again later." });
    }
});

// ── POST /deleteJo ────────────────────────────────────────
// Hard-delete a JO and all its related records
router.post('/deleteJo', async (req, res) => {
    const { joId } = req.body;
    if (!joId) return res.status(400).json({ status: 0, message: 'joId is required' });

    try {
        const p = await getPool();
        const transaction = new sql.Transaction(p);
        await transaction.begin();
        try {
            await transaction.request().input('joId', sql.Int, joId)
                .query('DELETE FROM JO_LineEntries    WHERE JO_Id = @joId');
            await transaction.request().input('joId', sql.Int, joId)
                .query('DELETE FROM JO_StageStatus    WHERE JO_Id = @joId');
            await transaction.request().input('joId', sql.Int, joId)
                .query('DELETE FROM JO_StatusHistory  WHERE JO_Id = @joId');
            await transaction.request().input('joId', sql.Int, joId)
                .query('DELETE FROM JO_Master         WHERE Id    = @joId');
            await transaction.commit();
            res.json({ status: 1, message: 'JO deleted' });
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) {
        console.error('JO deleteJo error:', err);
        res.status(500).json({ status: 0, message: "An unexpected error occurred. Please try again later." });
    }
});

// ── POST /history ──────────────────────────────────────────
// Returns line-wise production history (JO_LineEntries)
router.post('/history', async (req, res) => {
    const { joId } = req.body;
    if (!joId) return res.status(400).json({ status: 0, message: 'joId is required' });

    try {
        const p = await getPool();
        const result = await p.request()
            .input('joId', sql.Int, joId)
            .query(`
                SELECT Id, Stage, [LineNo] AS [LineNo], EntryTime, EntryDate, Colour, Slive, Size, Qty, CreatedAt, CreatedBy
                FROM JO_LineEntries
                WHERE JO_Id = @joId
                ORDER BY CreatedAt DESC
            `);
        res.json({ status: 1, data: result.recordset });
    } catch (err) {
        console.error('JO history error:', err);
        res.status(500).json({ status: 0, message: "An unexpected error occurred. Please try again later." });
    }
});

// ── POST /createVendorEntry ───────────────────────────────────
router.post('/createVendorEntry', async (req, res) => {
    const { joId } = req.body;
    const createdBy = req.user?.name || req.user?.username || 'System';
    if (!joId) return res.status(400).json({ status: 0, message: 'joId is required' });

    try {
        const p = await getPool();

        // Prevent duplicate vendor entries
        const existing = await p.request()
            .input('joId', sql.Int, joId)
            .query('SELECT Id FROM JO_VendorEntry WHERE JO_Id = @joId');
        if (existing.recordset.length > 0) {
            return res.status(400).json({ status: 0, message: 'Vendor entry already created for this JO' });
        }

        // Fetch JO + stage data
        const joRes = await p.request()
            .input('joId', sql.Int, joId)
            .query(`
                SELECT m.Id, m.JO_No, m.VendorCode, m.VendorName, m.OrderQty,
                       ISNULL(s.FabricPreparation, 0) AS FabricPreparation,
                       ISNULL(s.FusingComponent,   0) AS FusingComponent,
                       ISNULL(s.SewingAssembly,    0) AS SewingAssembly,
                       ISNULL(s.FinishingSewing,   0) AS FinishingSewing,
                       ISNULL(s.QualityFinishing,  0) AS QualityFinishing,
                       ISNULL(s.PackingDispatch,   0) AS PackingDispatch
                FROM JO_Master m
                LEFT JOIN JO_StageStatus s ON s.JO_Id = m.Id
                WHERE m.Id = @joId
            `);

        if (!joRes.recordset.length) {
            return res.status(404).json({ status: 0, message: 'JO not found' });
        }

        const jo  = joRes.recordset[0];
        const pd  = jo.PackingDispatch || 0;
        const pq  = jo.QualityFinishing || 0;

        if (pd <= 0) {
            return res.status(400).json({ status: 0, message: 'Packing & Dispatch stage has no completed quantity' });
        }
        if (pq > 0 && pd > pq) {
            return res.status(400).json({
                status:  0,
                message: `Packing qty (${pd}) exceeds Quality Finishing qty (${pq}). Please correct before creating vendor entry.`,
            });
        }

        const transaction = new sql.Transaction(p);
        await transaction.begin();
        try {
            const insRes = await transaction.request()
                .input('joId',       sql.Int,      joId)
                .input('joNo',       sql.NVarChar, jo.JO_No       || '')
                .input('vCode',      sql.NVarChar, jo.VendorCode  || '')
                .input('vName',      sql.NVarChar, jo.VendorName  || '')
                .input('orderQty',   sql.Int,      jo.OrderQty    || 0)
                .input('fp',         sql.Int,      jo.FabricPreparation)
                .input('fc',         sql.Int,      jo.FusingComponent)
                .input('sa',         sql.Int,      jo.SewingAssembly)
                .input('fs',         sql.Int,      jo.FinishingSewing)
                .input('qf',         sql.Int,      jo.QualityFinishing)
                .input('pd',         sql.Int,      pd)
                .input('entryDate',  sql.Date,     new Date())
                .input('createdBy',  sql.NVarChar, createdBy || 'System')
                .query(`
                    INSERT INTO JO_VendorEntry (
                        JO_Id, JO_No, VendorCode, VendorName, OrderQty,
                        FabricPreparation, FusingComponent, SewingAssembly,
                        FinishingSewing, QualityFinishing, PackingDispatch,
                        FinalQty, EntryDate, CreatedBy
                    )
                    OUTPUT INSERTED.Id
                    VALUES (
                        @joId, @joNo, @vCode, @vName, @orderQty,
                        @fp, @fc, @sa, @fs, @qf, @pd,
                        @pd, @entryDate, @createdBy
                    )
                `);

            const newId = insRes.recordset[0].Id;
            await transaction.commit();
            res.json({ status: 1, message: 'Vendor entry created successfully', vendorEntryId: newId });
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) {
        console.error('createVendorEntry error:', err);
        res.status(500).json({ status: 0, message: "An unexpected error occurred. Please try again later." });
    }
});

module.exports = router;
