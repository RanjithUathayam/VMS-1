const sql = require('mssql');

// Second database connection — WMS (used exclusively by grnPushing routes for
// Tran_TransHeader / Tran_TransDetails and the @ASRS_Transaction stored procedures).
// All connection details MUST come from environment variables — no credentials
// are hardcoded here, and the pool refuses to connect if configuration is missing.
const wmsConfig = {
    user:     process.env.WMS2_DB_USER,
    password: process.env.WMS2_DB_PASSWORD,
    server:   process.env.WMS2_DB_SERVER,
    database: process.env.WMS2_DB_DATABASE,
    port:     parseInt(process.env.WMS2_DB_PORT, 10) || 1433,
    options: {
        encrypt: process.env.WMS2_DB_ENCRYPT === 'true',
        trustServerCertificate: true,
        requestTimeout: 40000
    },
    pool: {
        max:                      40,
        min:                       0,
        acquireTimeoutMillis:  40000,
        idleTimeoutMillis:     10000
    }
};

let pool2;

async function getWmsPool() {
    if (!wmsConfig.user || !wmsConfig.password || !wmsConfig.server || !wmsConfig.database) {
        throw new Error('WMS2 database configuration is incomplete. Ensure WMS2_DB_USER, WMS2_DB_PASSWORD, WMS2_DB_SERVER, and WMS2_DB_DATABASE are set in backend/.env.');
    }
    if (!pool2) {
        pool2 = new sql.ConnectionPool(wmsConfig);
        await pool2.connect();
        console.log('WMS2 database connection established.');
    }
    return pool2;
}

module.exports = { getWmsPool, sql };
