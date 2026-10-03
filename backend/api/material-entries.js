const express = require('express');
const { pool, sql } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { sendServerError } = require('../utils/respond');

const router = express.Router();

const INTERAKT_API_TOKEN = process.env.INTERAKT_API_TOKEN;
const WHATSAPP_NOTIFY_PHONE = process.env.WHATSAPP_NOTIFY_PHONE;

async function sendWhatsAppMessage(phoneNumber, templateName, values) {
    if (!INTERAKT_API_TOKEN) {
        console.error('[whatsapp] INTERAKT_API_TOKEN is not configured — message not sent.');
        return { ok: false };
    }
    try {
        const response = await fetch('https://api.interakt.ai/v1/public/message/', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${INTERAKT_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                countryCode: '+91',
                phoneNumber: `${phoneNumber}`,
                callbackData: 'some text here',
                type: 'Template',
                template: {
                    name: templateName,
                    languageCode: 'en',
                    bodyValues: values,
                    buttonValues: { '0': values }
                }
            })
        });
        return { ok: response.ok };
    } catch (error) {
        console.error('[whatsapp] send failed:', error);
        return { ok: false };
    }
}

/* All routes below require a valid session; per-route permission checks follow the
   same screen-based model the frontend uses (vendor / warehouse / gate / dashBoard). */
router.use(authenticate);

/* ============================================================
   1. GET ALL ENTRIES (GROUPED BY DOCNUM)
   ============================================================ */
router.get('/', async (req, res) => {
    try {
        const result = await pool.request().query(`
            SELECT * FROM MaterialTransactions ORDER BY EntryId ASC;
        `);

        // Group by DocNum for frontend listing
        const grouped = {};
        result.recordset.forEach(r => {
            if (!grouped[r.EntryId]) {
                grouped[r.EntryId] = {
                    ...r,
                    lineItems: []
                };
            }

            grouped[r.EntryId].lineItems.push({
                ItemCode: r.ItemCode,
                ItemName: r.ItemName,
                Quantity: r.Quantity,
                ItemSize: r.ItemSize,
                ItemColor: r.ItemColor,
                ItemGroup: r.ItemGroup,
                ItemSlive: r.ItemSlive,
                JoNumber:r.JoNumber,
                JOLineNumber: r.JOLineNumber,
                PONumber: r.PONumber,
                POLineNumber: r.POLineNumber
            });
        });
        res.json(Object.values(grouped));

    } catch (err) {
        sendServerError(res, err, 'material-entries:list', 'Failed to load entries.');
    }
});

/* ============================================================
   2. GET DOCUMENTS BY PARTY (JO, ST, PO)
   ============================================================ */
router.get('/documents-by-party', async (req, res) => {
    const { docType, partyCode, fromWarehouse, toWarehouse } = req.query;

    if (!docType || !partyCode) {
        return res.status(400).send("docType and partyCode are required");
    }

    try {
        const result = await pool.request()
            .input('partyCode', sql.NVarChar, partyCode)
            .input('docType', sql.NVarChar, docType)
            .input('fromWarehouse', sql.NVarChar, fromWarehouse ?? "")
            .input('toWarehouse', sql.NVarChar, toWarehouse ?? "")
            .query(`
                EXEC [@ASRS_Transaction]
                    @type = 'Binning',
                    @FilterPartyCode = @partyCode,
                    @FilterType = @docType,
                    @fromWarehouse = @fromWarehouse,
                    @toWarehouse = @toWarehouse
            `);

        const docs = result.recordset;
        const docList = [...new Set(docs.map(x => x.DocNum))];

        res.json({ status: true, data: docs, DocNumList: docList });

    } catch (err) {
        sendServerError(res, err, 'material-entries:documents-by-party', 'Failed to load documents.');
    }
});

/* ============================================================
   3. POST NEW VENDOR ENTRY
   ============================================================ */
router.post('/', authorize('vendor'), async (req, res) => {
    const { docType, docEntry, docNumber, docDate, partyCode, partyName, totalQuantity, lineItems, NoOfBox, SupplierDcNo } = req.body;

    if (!docNumber || !partyCode || !Array.isArray(lineItems) || !lineItems.length) {
        return res.status(400).json({ status: false, message: 'docNumber, partyCode, and lineItems[] are required.' });
    }

    try {
        const entryDate = new Date();
        const entryId = Date.now();

        for (const item of lineItems) {
            await pool.request()
                .input("EntryId", sql.BigInt, entryId)
                .input("Type", sql.NVarChar, docType)
                .input("DocEntry", sql.Int, docEntry)
                .input("DocNum", sql.NVarChar, docNumber)
                .input("DocDate", sql.Date, docDate)
                .input("PartyCode", sql.NVarChar, partyCode)
                .input("PartyName", sql.NVarChar, partyName)

                .input("ItemCode", sql.NVarChar, item.itemCode)
                .input("ItemName", sql.NVarChar, item.itemName)
                .input("Quantity", sql.Int, item.dispatchQty)
                .input("ItemSize", sql.NVarChar, item.ItemSize || '')
                .input("ItemColor", sql.NVarChar, item.ItemColor || '')
                .input("ItemGroup", sql.NVarChar, item.ItemGroup || '')
                .input("ItemSlive", sql.NVarChar, item.ItemSlive || '')
                .input("Status", sql.NVarChar, 'Pending')
                .input("TotalQuantity", sql.Int, totalQuantity)

                .input("SAPDocType", sql.NVarChar, '')
                .input("SAPDocEntry", sql.Int, null)
                .input("SAPDocNum", sql.NVarChar, '')
                .input("SAPStatus", sql.NVarChar, 'W')

                .input("JoNumber", sql.NVarChar, item.JobOrderNo || item.JoNumber || '')
                .input("JOLineNumber", sql.Int, item.JOLineNumber || null)
                .input("PONumber", sql.NVarChar, item.PONumber || '')
                .input("POLineNumber", sql.Int, item.POLineNumber || null)
                .input("SupplierDcNo", sql.NChar, SupplierDcNo || '')
                .input("JobOrderDate", sql.Date, item.JobOrderDate || null)

                .input("CreatedBy", sql.NVarChar, partyName)
                .input("CreatedAt", sql.DateTime, entryDate)
                .input("NoOfBox", sql.Int, NoOfBox || null)

                .query(`
                    INSERT INTO MaterialTransactions (
                        EntryId,Type, DocEntry, DocNum, DocDate,
                        PartyCode, PartyName,
                        ItemCode, ItemName, Quantity, ItemSize, ItemColor, ItemGroup, ItemSlive,
                        Status, TotalQuantity,
                        SAPDocType, SAPDocEntry, SAPDocNum, SAPStatus,
                        JoNumber, JOLineNumber, PONumber, POLineNumber,SupplierDcNo, JobOrderDate,
                        CreatedBy, CreatedAt, NoOfBox
                    )
                    VALUES (
                        @EntryId, @Type, @DocEntry, @DocNum, @DocDate,
                        @PartyCode, @PartyName,
                        @ItemCode, @ItemName, @Quantity, @ItemSize, @ItemColor, @ItemGroup, @ItemSlive,
                        @Status, @TotalQuantity,
                        @SAPDocType, @SAPDocEntry, @SAPDocNum, @SAPStatus,
                        @JoNumber, @JOLineNumber, @PONumber, @POLineNumber,
                        @SupplierDcNo,@JobOrderDate,
                        @CreatedBy, @CreatedAt, @NoOfBox
                    );
                `);
        }

        const { ok } = await sendWhatsAppMessage(WHATSAPP_NOTIFY_PHONE, 'dc_arrival_notification', [
            `${docNumber}`, `${partyName}`, `${totalQuantity}`, 'https://vms.uathayam.in:4300/WEB/'
        ]);

        if (!ok) {
            return res.status(202).send({ status: false, message: 'Entry saved, but failed to send notification message.' });
        }

        res.status(200).json({ status: true, message: "Entry saved" });

    }
    catch (err) {
        sendServerError(res, err, 'material-entries:create', 'Failed to save entry.');
    }
});

/* ============================================================
   4. PUT – WAREHOUSE APPROVAL
   ============================================================ */
router.put('/:EntryId/approve', authorize('warehouse'), async (req, res) => {
    const { expectedReceiveDate, warehouseAddress, partyCode, docNum } = req.body;
    const { EntryId } = req.params;
    const approvedBy = req.user?.name || req.user?.username || 'System';

    try {
        await pool.request()
            .input("EntryId", sql.NVarChar, EntryId)
            .input("ExpectedReceiveDate", sql.Date, expectedReceiveDate)
            .input("WarehouseAddress", sql.NVarChar, warehouseAddress)
            .input("ApprovedBy", sql.NVarChar, approvedBy)
            .input("ApprovedAt", sql.DateTime, new Date())
            .query(`
                UPDATE MaterialTransactions
                SET
                    Status='Approved',
                    ExpectedReceiveDate=@ExpectedReceiveDate,
                    WarehouseAddress=@WarehouseAddress,
                    ApprovedBy=@ApprovedBy,
                    ApprovedAt=@ApprovedAt
                WHERE EntryId=@EntryId;
            `);

        const resultVendor = await pool.request()
            .input('partyCode', sql.NVarChar, partyCode)
            .query(`
                SELECT TOP 1 Phone1, Phone2, CardName FROM OCRD
                WHERE CardCode = @partyCode AND validFor = 'Y' AND CardType = 'S'
            `);

        if (resultVendor.recordset.length === 0)
        {
            return res.status(404).send({ message: 'Vendor not found or not valid.' });
        }

        const { Phone1, Phone2, CardName } = resultVendor.recordset[0];

        const mobileNumber = Phone1 || Phone2;

        if (!mobileNumber)
        {
            return res.status(400).send({ message: 'Vendor phone number missing.' });
        }

        const { ok } = await sendWhatsAppMessage(mobileNumber, 'dc_vendor_confirmation', [
            `${CardName}`, `${docNum}`, `${expectedReceiveDate}`, `${warehouseAddress}`, 'https://vms.uathayam.in:4300/WEB/'
        ]);

        if (!ok) {
            return res.status(500).send({ message: 'Approved, but failed to send confirmation message to vendor.' });
        }

        res.json({ status: true });

    } catch (err) {
        sendServerError(res, err, 'material-entries:approve', 'Failed to approve entry.');
    }
});

/* ============================================================
   5. PUT – DISPATCH
   ============================================================ */
router.put('/dispatch/:EntryId', authorize('vendor'), async (req, res) => {
    const { EntryId } = req.params;

    try {
        await pool.request()
            .input("EntryId", sql.NVarChar, EntryId)
            .input("DispatchedAt", sql.DateTime, new Date())
            .query(`
                UPDATE MaterialTransactions
                SET Status='Dispatched', DispatchedAt=@DispatchedAt
                WHERE EntryId=@EntryId;
            `);

        res.json({ status: true });

    } catch (err) {
        sendServerError(res, err, 'material-entries:dispatch', 'Failed to dispatch entry.');
    }
});

/* ============================================================
   6. PUT – GATE INWARD
   ============================================================ */
router.put('/gate-inward/:EntryId', authorize('gate'), async (req, res) => {
    const { EntryId } = req.params;
    const authorizedBy = req.user?.name || req.user?.username || 'System';

    try {
        await pool.request()
            .input("EntryId", sql.BigInt, EntryId)
            .input("GateInwardDate", sql.DateTime, new Date())
            .input("AuthorizedBy", sql.NVarChar, authorizedBy)
            .query(`
                UPDATE MaterialTransactions
                SET
                    Status='Received',
                    GateInwardDate=@GateInwardDate,
                    AuthorizedBy=@AuthorizedBy,
                    SAPStatus='N'
                WHERE EntryId =@EntryId;
            `);

        res.json({ status: true });

    } catch (err) {
        sendServerError(res, err, 'material-entries:gate-inward', 'Failed to confirm gate receipt.');
    }
});

router.get('/warehouses', async (req, res) => {
  try {
    const result = await pool.request().query(`
        select
            t0.WhsCode,
            t0.WhsName,
            t0.AddrType,
            t0.Street,
            t0.StreetNo,
            t0.[Block],
            t0.Building,
            t0.City,
            t0.ZipCode,
            t0.[State]
        FROM [BBLive].[dbo].owhs as t0
        where t0.Inactive='N'
    `);
    res.json({ status: true, data: result.recordset });

  } catch (err) {
    sendServerError(res, err, 'material-entries:warehouses', 'Failed to load warehouses.');
  }
});

router.get('/schedule-count', async (req, res) => {
    const { date } = req.query;

    try {
        const result = await pool.request()
            .input("ExpectedReceiveDate", sql.Date, date)
            .query(`
                SELECT SUM(TotalQuantity) AS TotalScheduled
                FROM (
                    SELECT EntryId, TotalQuantity
                    FROM MaterialTransactions
                    WHERE ExpectedReceiveDate = @ExpectedReceiveDate
                    GROUP BY EntryId, TotalQuantity
                ) AS x;
            `);

        res.json({
            status: true,
            total: result.recordset[0].TotalScheduled || 0
        });
    }
    catch (err)
    {
        sendServerError(res, err, 'material-entries:schedule-count', 'Failed to load schedule count.');
    }
});

router.get('/getDashboardData', authorize('dashBoard'), async (req, res) => {
    const { fromDate, toDate, docType, status } = req.query;

    if (!fromDate || !toDate) {
        return res.status(400).json({ status: false, message: 'fromDate and toDate are required.' });
    }

    try {
        let query = `
            SELECT *
            FROM (
                SELECT *,
                       ROW_NUMBER() OVER (
                           PARTITION BY EntryId
                           ORDER BY CreatedAt DESC
                       ) AS rn
                FROM MaterialTransactions
                WHERE CreatedAt >= @fromDate
                AND CreatedAt <= DATEADD(DAY, 1, @toDate)
        `;

        const request = pool.request();
        request.input('fromDate', sql.Date, fromDate);
        request.input('toDate', sql.Date, toDate);

        // DocType filter
        if (docType && docType !== 'All') {
            query += ` AND Type = @docType`;
            request.input('docType', sql.NVarChar, docType);
        }

        // Status filter
        if (status && status !== 'All') {
            query += ` AND Status = @status`;
            request.input('status', sql.NVarChar, status);
        }

        query += `
            ) AS X
            WHERE rn = 1
            ORDER BY EntryId DESC
        `;

        const result = await request.query(query);

        res.status(200).json({
            status: true,
            data: result.recordset
        });

    } catch (err) {
        sendServerError(res, err, 'material-entries:dashboard', 'Failed to load dashboard data.');
    }
});

router.post("/deleteVendorEntry", authorize('vendor'), async (req, res) => {
    const { EntryId } = req.body;

    if (!EntryId) {
        return res.status(400).json({ status: false, message: 'EntryId is required.' });
    }

    try {
        const result = await pool.request()
        .input('EntryId', sql.BigInt, EntryId)
        .query(`
            DELETE FROM MaterialTransactions
            WHERE EntryId = @EntryId
            AND Status = 'Pending'
        `);

        // rowsAffected is the ONLY correct check
        if (result.rowsAffected[0] === 0) {
        return res.status(404).json({
            status: false,
            message: 'Entry not found or status is not Pending'
        });
        }

        res.status(200).json({
            status: true,
            message: 'Vendor entry deleted successfully'
        });

    } catch (err) {
        sendServerError(res, err, 'material-entries:delete', 'Failed to delete entry.');
    }
});

module.exports = router;
