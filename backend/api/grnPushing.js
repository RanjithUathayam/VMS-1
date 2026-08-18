const express = require('express');
const axios   = require('axios');
const { pool, sql }  = require('../db');        // existing pool → WMS_Uathayam (BBSAPSERVER)
const { getWmsPool } = require('../db-wms');     // second pool  → secondary WMS database
const { authenticate, authorize } = require('../middleware/auth');
const { sendServerError } = require('../utils/respond');

const router = express.Router();

const ERP_API_URL = process.env.ERP_API_URL || '';
const ERP_CLIENT_ID = process.env.ERP_CLIENT_ID;
const ERP_CLIENT_SECRET = process.env.ERP_CLIENT_SECRET;

router.use(authenticate, authorize('grnPushing'));

/* ------------------------------------------------------------------ */
/*  HELPERS                                                            */
/* ------------------------------------------------------------------ */

const fetchBearerToken = async () => {
    try {
        const response = await axios.get(
            `${ERP_API_URL}token`,
            { params: { clientId: ERP_CLIENT_ID, clientSecret: ERP_CLIENT_SECRET } }
        );
        return { TokenNo: response.data, status: 1 };
    } catch (error) {
        return { status: 0, message: 'Failed to fetch ERP token' };
    }
};

// Calls the ERP Pre-Binning API and returns a standardised result.
const processERPPreBinningData = async (payload, userName) => {
    try {
        const tokenResult = await fetchBearerToken();
        if (tokenResult.status !== 1) {
            return { status: 0, message: tokenResult.message || 'Failed to fetch ERP token' };
        }

        const response = await axios.post(
            `${ERP_API_URL}preBinning`,
            { items: payload, userName },
            {
                headers: {
                    'Authorization': `Bearer ${tokenResult.TokenNo}`,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            }
        );

        const data = response.data;
        return {
            status:  data.status  ?? (data.Status === 'Success' ? 1 : 0),
            Reason:  data.Reason  || data.reason  || data.message || 'Success',
            message: data.message || data.Reason  || '',
            data:    data.data    || []
        };
    } catch (error) {
        const errMsg = error.response?.data?.message || error.message || 'ERP API call failed';
        return { status: 0, message: errMsg };
    }
};

/* ------------------------------------------------------------------ */
/*  1. GET GRN PUSHING LIST                                            */
/*     POST /api/ERP/getGRNPushingList                                 */
/*     Body: { type? }                                                 */
/* ------------------------------------------------------------------ */
router.post('/getGRNPushingList', async (req, res) => {
    try {
        const type = req.body?.type || 'Binning';
        const pool2 = await getWmsPool();

        const result = await pool2.request()
            .input('type', sql.NVarChar, type)
            .query("EXEC [dbo].[@ASRS_Transaction] @type = @type");

        return res.status(200).json({
            status:  1,
            message: result.recordset.length
                ? 'GRN Pushing list fetched successfully'
                : 'No GRN Pushing data found',
            data: result.recordset
        });
    } catch (error) {
        console.error('[getGRNPushingList]', error);
        return res.status(202).json({ status: 0, message: 'Failed to fetch GRN Pushing list.' });
    }
});

/* ------------------------------------------------------------------ */
/*  2. GET GRN PUSHING DETAILS                                         */
/*     POST /api/ERP/getGRNPushingDetails                              */
/*     Body: { docEntry, type?, process?, status? }                    */
/* ------------------------------------------------------------------ */
router.post('/getGRNPushingDetails', async (req, res) => {
    try {
        const docEntry = req.body?.docEntry;

        if (docEntry === undefined || docEntry === null || docEntry === '') {
            return res.status(202).json({ status: 0, message: 'docEntry is required' });
        }

        const type     = req.body?.type    || 'Binning';
        const process  = req.body?.process || 'GRPO';
        const status   = req.body?.status  || 'Pending';
        // Pass docEntry as Int — stored proc expects a numeric DocEntry
        const docEntryInt = parseInt(docEntry, 10);

        // Try WMS pool (10.0.10.203) first; fall back to primary pool if empty
        const pool2 = await getWmsPool();
        let result = await pool2.request()
            .input('type',     sql.NVarChar, type)
            .input('process',  sql.NVarChar, process)
            .input('status',   sql.NVarChar, status)
            .input('docEntry', sql.Int,      docEntryInt)
            .query(`
                EXEC [dbo].[@ASRS_Transaction_Details]
                    @type     = @type,
                    @process  = @process,
                    @status   = @status,
                    @docEntry = @docEntry
            `);

        // If WMS returned nothing, try the primary DB (WMS_Uathayam)
        if (!result.recordset.length) {
            try {
                result = await pool.request()
                    .input('type',     sql.NVarChar, type)
                    .input('process',  sql.NVarChar, process)
                    .input('status',   sql.NVarChar, status)
                    .input('docEntry', sql.Int,      docEntryInt)
                    .query(`
                        EXEC [dbo].[@ASRS_Transaction_Details]
                            @type     = @type,
                            @process  = @process,
                            @status   = @status,
                            @docEntry = @docEntry
                    `);
            } catch (_) { /* ignore fallback error — return original empty result */ }
        }

        return res.status(200).json({
            status:  1,
            message: result.recordset.length
                ? 'GRN Pushing details fetched successfully'
                : 'No GRN Pushing detail found',
            data: result.recordset
        });
    } catch (error) {
        console.error('[getGRNPushingDetails]', error);
        return res.status(202).json({ status: 0, message: 'Failed to fetch GRN Pushing details.' });
    }
});

router.post('/createGRNPushingTransaction', async (req, res) => {
    const pool2      = await getWmsPool();
    const transaction = new sql.Transaction(pool2);

    try {
        const docEntry  = req.body?.docEntry;
        const type      = req.body?.type      || 'Binning';
        const process   = req.body?.process   || 'GRPO';
        const status    = req.body?.status    || 'Pending';
        // User identity comes from the authenticated session, never from client-supplied body fields.
        const reqUserId   = req.user?.id || 0;
        const reqUserName = req.user?.username || req.user?.name || 'system';

        if (docEntry === undefined || docEntry === null || docEntry === '') {
            return res.status(202).json({ status: 0, message: 'docEntry is required' });
        }

        await transaction.begin();

        // ── 1. Fetch GRN header list & find the selected row ──────────
        const headerResult = await new sql.Request(transaction)
            .input('type', sql.NVarChar, type)
            .query("EXEC [dbo].[@ASRS_Transaction] @type = @type");

        const headerRows     = headerResult.recordset;
        const selectedHeader = headerRows.find(row => String(row.DocEntry) === String(docEntry));

        if (!selectedHeader) {
            await transaction.rollback();
            return res.status(202).json({ status: 0, message: 'Selected GRN Pushing row not found' });
        }

        // ── 2. Fetch detail rows ───────────────────────────────────────
        const detailResult = await new sql.Request(transaction)
            .input('type',     sql.NVarChar, type)
            .input('process',  sql.NVarChar, process)
            .input('status',   sql.NVarChar, status)
            .input('docEntry', sql.NVarChar, String(docEntry))
            .query(`
                EXEC [dbo].[@ASRS_Transaction_Details]
                    @type     = @type,
                    @process  = @process,
                    @status   = @status,
                    @docEntry = @docEntry
            `);

        const detailRows = detailResult.recordset;

        if (!detailRows.length) {
            await transaction.rollback();
            return res.status(202).json({ status: 0, message: 'Selected GRN Pushing detail rows not found' });
        }

        // ── 3. Insert Tran_TransHeader ────────────────────────────────
        const headerInsertReq = new sql.Request(transaction);
        headerInsertReq.input('transType',        sql.NVarChar,  type);
        headerInsertReq.input('process',          sql.NVarChar,  process);
        headerInsertReq.input('docType',          sql.NVarChar,  selectedHeader.Type || process);
        headerInsertReq.input('docNum',           sql.NVarChar,  selectedHeader.DocNum || '');
        headerInsertReq.input('docEntry',         sql.NVarChar,  String(selectedHeader.DocEntry || docEntry));
        headerInsertReq.input('station',          sql.NVarChar,  selectedHeader.Station || '');
        headerInsertReq.input('floor',            sql.NVarChar,  selectedHeader.Floor || '');
        headerInsertReq.input('scheduleDateTime', sql.DateTime,  selectedHeader.ReqDate || null);
        headerInsertReq.input('sapDocType',       sql.NVarChar,  detailRows[0].DocType || process);
        headerInsertReq.input('sapDocEntry',      sql.Int,       Number(detailRows[0].DocEntry) || null);
        headerInsertReq.input('reqUserId',        sql.Int,       reqUserId);
        headerInsertReq.input('requestedDate',    sql.DateTime,  new Date());

        const insertedHeader = await headerInsertReq.query(`
            INSERT INTO Tran_TransHeader
            (
                TransType, Process, DocType, DocNum, DocEntry, Station, Floor,
                ScheduleDateTime, ShuffleDateTime, RetrievalTime, SapDocType,
                SapDocNum, SapDocEntry, SapStatus, CreatedDate, Status,
                LableRequired, ReqUserId, RequestedDate
            )
            OUTPUT INSERTED.Id
            VALUES
            (
                @transType, @process, @docType, @docNum, @docEntry, @station, @floor,
                @scheduleDateTime, NULL, NULL, @sapDocType,
                NULL, @sapDocEntry, 'Pending', GETDATE(), 'Initiated',
                0, @reqUserId, @requestedDate
            )
        `);

        const headerId = insertedHeader.recordset[0]?.Id;
        if (!headerId) {
            throw new Error('Failed to create transaction header');
        }

        // ── 4. Insert Tran_TransDetails (one row per detail) ─────────
        for (const detail of detailRows) {
            const detailInsertReq = new sql.Request(transaction);
            detailInsertReq.input('headerId',    sql.Int,       headerId);
            detailInsertReq.input('docType',     sql.NVarChar,  detail.DocType || process);
            detailInsertReq.input('docNum',      sql.NVarChar,  String(detail.DocNum || selectedHeader.DocNum || ''));
            detailInsertReq.input('docEntry',    sql.NVarChar,  String(detail.DocEntry || docEntry));
            detailInsertReq.input('productCode', sql.NVarChar,  detail.ItemCode || '');
            detailInsertReq.input('orderQty',    sql.Decimal,   Number(detail.Quantity  || 0));
            detailInsertReq.input('reqQty',      sql.Decimal,   Number(detail.Requested || detail.Quantity || 0));
            detailInsertReq.input('confQty',     sql.Decimal,   Number(detail.Binned    || 0));
            detailInsertReq.input('sapDocEntry', sql.Int,       Number(detail.DocEntry) || null);
            detailInsertReq.input('sapDocType',  sql.NVarChar,  detail.DocType || process);
            detailInsertReq.input('productName', sql.NVarChar,  detail.ItemName || '');
            detailInsertReq.input('lineNo',      sql.Int,       detail.LineNo   ?? null);

            await detailInsertReq.query(`
                INSERT INTO Tran_TransDetails
                (
                    HeaderId, DocType, DocNum, DocEntry, ProductCode, OrderQty,
                    ReqQty, ConfQty, SapDocEntry, SapDocNum, SapDocType, SapStatus,
                    ProductName, Trolley, [Sequence], [LineNo], PrintQty
                )
                VALUES
                (
                    @headerId, @docType, @docNum, @docEntry, @productCode, @orderQty,
                    @reqQty, @confQty, @sapDocEntry, NULL, @sapDocType, 'Pending',
                    @productName, NULL, NULL, @lineNo, NULL
                )
            `);
        }

        // ── 5. Build pre-binning payload & call ERP API ───────────────
        const preBinningPayload = detailRows.map(detail => ({
            TransactionType: type,
            GRNNo:           String(selectedHeader.DocEntry || docEntry),
            DocNo:           selectedHeader.DocNum || detail.DocNum || '',
            PartyName:       selectedHeader.PartyName || '',
            ItemCode:        detail.ItemCode,
            Quantity:        Number(detail.Requested || detail.Quantity || 0),
            Type:            selectedHeader.Type || ''
        }));

        const preBinningResult = await processERPPreBinningData(preBinningPayload, reqUserName);

        // ── 6. Update header status based on ERP result ───────────────
        await new sql.Request(transaction)
            .input('headerId',    sql.Int,      headerId)
            .input('finalStatus', sql.NVarChar, preBinningResult.status === 1 ? 'Success' : 'Failed')
            .input('sapStatus',   sql.NVarChar, preBinningResult.status === 1
                ? (preBinningResult.Reason || 'Success')
                : (preBinningResult.message || 'PreBinning failed'))
            .input('sapDocType',  sql.NVarChar, detailRows[0].DocType || process)
            .input('sapDocEntry', sql.Int,       Number(detailRows[0].DocEntry) || null)
            .query(`
                UPDATE Tran_TransHeader
                SET Status      = @finalStatus,
                    SapStatus   = @sapStatus,
                    SapDocType  = COALESCE(SapDocType,  @sapDocType),
                    SapDocEntry = COALESCE(SapDocEntry, @sapDocEntry)
                WHERE Id = @headerId
            `);

        await transaction.commit();

        const httpStatus = preBinningResult.status === 1 ? 200 : 202;
        return res.status(httpStatus).json({
            status:   preBinningResult.status,
            message:  preBinningResult.Reason || preBinningResult.message,
            headerId,
            data:     preBinningResult.data || []
        });

    } catch (error) {
        try { await transaction.rollback(); } catch (_) { /* already rolled back */ }
        console.error('[createGRNPushingTransaction]', error);
        return res.status(202).json({ status: 0, message: 'Failed to create GRN Pushing transaction.' });
    }
});

module.exports = router;
