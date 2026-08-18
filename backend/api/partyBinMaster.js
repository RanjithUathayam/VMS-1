const express = require('express');
const { pool, sql } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { sendServerError } = require('../utils/respond');

const router = express.Router();
const MAX_BIN_RANGE = 5000; // guards against accidental/malicious unbounded ranges hammering the DB

router.use(authenticate, authorize('partyBinMaster'));

router.get('/BinList', async (req, res) => {
  try {
    const result = await pool.request().query(`
        select
            [Id]
            ,[BinID]
            ,[PartyName]
            ,[PartyCode]
            ,[CreatedDate]
            ,[PartyBinDispatchDate]
            ,[UpdatedDate]
            ,[Status]
        FROM PartyBinMaster
    `);
    res.status(200).json({ status: true, data: result.recordset });

  } catch (err) {
    sendServerError(res, err, 'partyBin:BinList', 'Failed to load bin list.');
  }
});

router.get('/PartyList', async (req, res) => {
  try {
    const result = await pool.request().query(`
        SELECT CardCode, CardFName, CardName
        FROM OCRD
        WHERE validFor = 'Y' and CardType = 'S'
    `);
    res.status(200).json({ status: true, data: result.recordset });

  } catch (err) {
    sendServerError(res, err, 'partyBin:PartyList', 'Failed to load party list.');
  }
});

router.post('/create', async (req, res) => {
    const fromBin = Number(req.body?.fromBin);
    const toBin   = Number(req.body?.toBin);

    if (!Number.isInteger(fromBin) || !Number.isInteger(toBin) || fromBin <= 0 || toBin <= 0) {
        return res.status(400).json({ message: 'fromBin and toBin must be positive integers.' });
    }
    if (toBin < fromBin) {
        return res.status(400).json({ message: 'toBin must be greater than or equal to fromBin.' });
    }
    if (toBin - fromBin + 1 > MAX_BIN_RANGE) {
        return res.status(400).json({ message: `Range too large — maximum ${MAX_BIN_RANGE} bins per request.` });
    }

    try {
        let inserted = 0;
        let skipped = 0;

        for (let i = fromBin; i <= toBin; i++) {
            const binId = i.toString();

            const result = await pool.request()
                .input('BinID', sql.NVarChar, binId)
                .query(`
                    IF NOT EXISTS (
                        SELECT 1 FROM PartyBinMaster WHERE BinID = @BinID
                    )
                    BEGIN
                        INSERT INTO PartyBinMaster (BinID)
                        VALUES (@BinID)
                        SELECT 'INSERTED' AS Result
                    END
                    ELSE
                    BEGIN
                        SELECT 'EXISTS' AS Result
                    END
                `);

            if (result.recordset[0].Result === 'INSERTED') {
                inserted++;
            } else {
                skipped++;
            }
        }

        res.status(200).json({
            message: 'Process completed',
            inserted,
            skipped
        });

    } catch (err) {
        sendServerError(res, err, 'partyBin:create', 'Failed to create bins.');
    }
});

router.post('/dispatch', async (req, res) => {
    const {
        PartyName,
        PartyCode,
        scannedBins
    } = req.body;

    if (!PartyCode || !Array.isArray(scannedBins) || !scannedBins.length) {
        return res.status(400).json({ status: false, message: 'PartyCode and scannedBins[] are required.' });
    }

    try
    {
        for (let binId of scannedBins) {
            await pool.request()
                .input('BinID', sql.NVarChar, String(binId))
                .input('PartyName', sql.NVarChar, PartyName)
                .input('PartyCode', sql.NVarChar, PartyCode)
                .query(`
                    UPDATE PartyBinMaster
                    SET
                        PartyName = @PartyName,
                        PartyCode = @PartyCode,
                        PartyBinDispatchDate = GETDATE(),
                        UpdatedDate = GETDATE(),
                        Status = 'Dispatched'
                    WHERE BinID = @BinID and Status = 'AVAILABLE'
                `);
        }
        res.status(200).json({
            status: true,
            message: 'Bins dispatched successfully',
        })
    } catch (err) {
        sendServerError(res, err, 'partyBin:dispatch', 'Failed to dispatch bins.');
    }
});

module.exports = router;
