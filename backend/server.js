require('dotenv').config();
const express = require('express');
const cors = require('cors');
const materialEntriesRouter = require('./api/material-entries');
const authRouter = require('./api/auth');
const partyBin = require('./api/partyBinMaster');
const grnPushing = require('./api/grnPushing');
const joStatus       = require('./api/joStatus');
const userManagement  = require('./api/userManagement');
const roleManagement  = require('./api/roleManagement');
const db = require('./db');
const { getWmsPool } = require('./db-wms');

const app = express();
const port = process.env.API_PORT || 3001;

app.use(cors({ origin: '*' }))
app.use(express.json());

app.use('/api/auth', authRouter);
app.use('/api/material-transactions', materialEntriesRouter);
app.use('/api/partyBin', partyBin);
app.use('/api/ERP',      grnPushing);
app.use('/api/joStatus',      joStatus);
app.use('/api/users',         userManagement);
app.use('/api/roles',         roleManagement);

// Start the server and then attempt to connect to both databases.
app.listen(port, () => {
    console.log(`Server running on port ${port}`);

    // Primary DB (WMS_Uathayam)
    db.connect().then(async () => {
        console.log('Database connection established successfully (WMS_Uathayam).');
        // Seed default roles if AppRoles table exists but has no rows
        try { await roleManagement.ensureDefaultRoles(); console.log('AppRoles seeded.'); }
        catch (e) { console.log('AppRoles seed skipped (table may not exist yet):', e.message); }
    }).catch(err => {
        console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
        console.log('!!! CRITICAL: FAILED TO CONNECT TO DATABASE !!!');
        console.log('!!! API endpoints will not work until the   !!!');
        console.log('!!! connection is restored. Check .env      !!!');
        console.log(`!!! Error: ${err.message}`);
        console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    });

    // Secondary DB (WMS @ 10.0.10.203) — used by GRN Pushing endpoints
    getWmsPool().catch(err => {
        console.log('!!! WARNING: WMS2 DB connection failed (10.0.10.203/WMS) !!!');
        console.log(`!!! Error: ${err.message}`);
        console.log('!!! GRN Pushing endpoints will not work until resolved  !!!');
    });
});
