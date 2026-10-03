require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const materialEntriesRouter = require('./api/material-entries');
const authRouter = require('./api/auth');
const partyBin = require('./api/partyBinMaster');
const joStatus       = require('./api/joStatus');
const userManagement  = require('./api/userManagement');
const roleManagement  = require('./api/roleManagement');
const db = require('./db');

const app = express();
const port = process.env.API_PORT || 3001;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

if (allowedOrigins.length === 0) {
    console.warn('!!! WARNING: ALLOWED_ORIGINS is not set — CORS will reject all cross-origin requests. Set it in backend/.env.');
}

app.use(helmet());
app.use(cors({
    origin: (origin, callback) => {
        // Allow same-origin / non-browser requests (no Origin header) and configured origins only.
        // Pass `false` (not an Error) so disallowed cross-origin browser calls simply omit CORS
        // headers instead of tripping Express's default HTML error page.
        callback(null, !origin || allowedOrigins.includes(origin));
    },
}));
app.use(express.json({ limit: '2mb' }));

// Baseline abuse protection across the whole API surface; individual auth routes apply tighter limits.
app.use('/api', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
}));

app.use('/api/auth', authRouter);
app.use('/api/material-transactions', materialEntriesRouter);
app.use('/api/partyBin', partyBin);
app.use('/api/joStatus',      joStatus);
app.use('/api/users',         userManagement);
app.use('/api/roles',         roleManagement);

app.use((req, res) => {
    res.status(404).json({ status: 0, message: 'Not found.' });
});

// Final safety net — never leak stack traces / internal error details to clients.
app.use((err, req, res, _next) => {
    console.error('[unhandled]', err);
    res.status(500).json({ status: 0, message: 'An unexpected error occurred.' });
});

// Start the server and then attempt to connect to the database.
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
});
