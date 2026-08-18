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

// ── POST /createJo ─────────────────────────────────────────
router.post('/createJo', async (req, res) => {
    const {
        docType, docNum, vendorCode, vendorName, style,
        orderQty, entryDate,
        fabricPreparation, remarks
    } = req.body;
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
        const result = await p.request().query(`
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

    const qtyNum = Math.max(0, Number(qty) || 0);
    if (qtyNum <= 0) return res.status(400).json({ status: 0, message: 'Qty must be greater than 0' });

    try {
        await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
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
    const prevCol   = PREV_COL_MAP[stage];

    try {
        const p = await getPool();

        // Validate against previous stage's completed qty
        if (prevCol) {
            const statusRow = await p.request()
                .input('joId_v', sql.Int, joId)
                .query(`
                    SELECT ISNULL(${prevCol}, 0) AS PrevQty,
                           ISNULL(${col},     0) AS CurrentQty
                    FROM JO_StageStatus WHERE JO_Id = @joId_v
                `);
            if (statusRow.recordset.length > 0) {
                const prevQty     = statusRow.recordset[0].PrevQty    || 0;
                const currentQty  = statusRow.recordset[0].CurrentQty || 0;
                const combined    = currentQty + newTotal;
                if (prevQty > 0 && combined > prevQty) {
                    const allowed = prevQty - currentQty;
                    return res.status(400).json({
                        status:  0,
                        message: `Entry total (${newTotal} pcs) exceeds available capacity. ` +
                                 `Previous stage completed: ${prevQty} pcs, already saved this stage: ${currentQty} pcs, ` +
                                 `maximum allowed: ${allowed > 0 ? allowed : 0} pcs.`,
                    });
                }
            }
        }

        const transaction = new sql.Transaction(p);
        await transaction.begin();

        try {
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
