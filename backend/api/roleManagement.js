const express = require('express');
const { pool, sql } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { sendServerError } = require('../utils/respond');

const router = express.Router();

const ALL_SCREENS = [
    { key: 'dashBoard',       label: 'Dashboard' },
    { key: 'vendor',          label: 'Vendor Entry' },
    { key: 'warehouse',       label: 'Warehouse Approval' },
    { key: 'gate',            label: 'Gate Entry' },
    { key: 'partyBinMaster',  label: 'Party Bin Master' },
    { key: 'grnPushing',      label: 'GRN Pushing' },
    { key: 'joStatus',        label: 'JO Status' },
    { key: 'userManagement',  label: 'User Management' },
];

router.use(authenticate, authorize('userManagement'));

/* ──────────────────────────────────────────────────────────
   GET /api/roles/screens  –  list available app screens
────────────────────────────────────────────────────────── */
router.get('/screens', (_req, res) => {
    res.json({ status: 1, data: ALL_SCREENS });
});

/* ──────────────────────────────────────────────────────────
   GET /api/roles/list
────────────────────────────────────────────────────────── */
router.get('/list', async (_req, res) => {
    try {
        const result = await pool.request().query(`
            SELECT Id, RoleName, DisplayName, Description, Permissions, IsSystem, CreatedAt
            FROM AppRoles
            ORDER BY IsSystem DESC, CreatedAt ASC
        `);
        const roles = result.recordset.map(r => ({
            ...r,
            Permissions: parsePermissions(r.Permissions),
        }));
        res.json({ status: 1, data: roles });
    } catch (err) {
        sendServerError(res, err, 'roles/list', 'Failed to load roles.');
    }
});

/* ──────────────────────────────────────────────────────────
   POST /api/roles/create
   Body: { roleName, displayName, description?, permissions? }
────────────────────────────────────────────────────────── */
router.post('/create', async (req, res) => {
    const { roleName, displayName, description, permissions } = req.body;

    if (!roleName || !displayName) {
        return res.status(400).json({ status: 0, message: 'Role Name and Display Name are required.' });
    }

    const slug = roleName.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');

    try {
        const dup = await pool.request()
            .input('roleName', sql.NVarChar, slug)
            .query(`SELECT Id FROM AppRoles WHERE RoleName = @roleName`);

        if (dup.recordset.length > 0) {
            return res.status(409).json({ status: 0, message: 'Role name already exists.' });
        }

        await pool.request()
            .input('roleName',    sql.NVarChar, slug)
            .input('displayName', sql.NVarChar, displayName.trim())
            .input('description', sql.NVarChar, description ? description.trim() : '')
            .input('permissions', sql.NVarChar, JSON.stringify(permissions || []))
            .query(`
                INSERT INTO AppRoles (RoleName, DisplayName, Description, Permissions, IsSystem, CreatedAt)
                VALUES (@roleName, @displayName, @description, @permissions, 0, GETDATE())
            `);

        res.json({ status: 1, message: 'Role created successfully.' });
    } catch (err) {
        sendServerError(res, err, 'roles/create', 'Failed to create role.');
    }
});

/* ──────────────────────────────────────────────────────────
   PUT /api/roles/update/:id
   Body: { displayName, description?, permissions }
   RoleName is immutable.
────────────────────────────────────────────────────────── */
router.put('/update/:id', async (req, res) => {
    const { id } = req.params;
    const { displayName, description, permissions } = req.body;

    if (!displayName) {
        return res.status(400).json({ status: 0, message: 'Display Name is required.' });
    }

    try {
        const result = await pool.request()
            .input('id',          sql.Int,      parseInt(id, 10))
            .input('displayName', sql.NVarChar, displayName.trim())
            .input('description', sql.NVarChar, description ? description.trim() : '')
            .input('permissions', sql.NVarChar, JSON.stringify(permissions || []))
            .query(`
                UPDATE AppRoles
                SET DisplayName = @displayName,
                    Description = @description,
                    Permissions = @permissions
                WHERE Id = @id
            `);

        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({ status: 0, message: 'Role not found.' });
        }
        res.json({ status: 1, message: 'Role updated successfully.' });
    } catch (err) {
        sendServerError(res, err, 'roles/update', 'Failed to update role.');
    }
});

/* ──────────────────────────────────────────────────────────
   DELETE /api/roles/delete/:id
   System roles and roles in use cannot be deleted.
────────────────────────────────────────────────────────── */
router.delete('/delete/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const role = await pool.request()
            .input('id', sql.Int, parseInt(id, 10))
            .query(`SELECT RoleName, IsSystem FROM AppRoles WHERE Id = @id`);

        if (role.recordset.length === 0) {
            return res.status(404).json({ status: 0, message: 'Role not found.' });
        }
        if (role.recordset[0].IsSystem) {
            return res.status(403).json({ status: 0, message: 'System roles cannot be deleted.' });
        }

        const inUse = await pool.request()
            .input('roleName', sql.NVarChar, role.recordset[0].RoleName)
            .query(`SELECT COUNT(*) AS cnt FROM Users WHERE Role = @roleName`);

        if (inUse.recordset[0].cnt > 0) {
            return res.status(409).json({
                status: 0,
                message: `Cannot delete: ${inUse.recordset[0].cnt} user(s) are assigned to this role.`,
            });
        }

        await pool.request()
            .input('id', sql.Int, parseInt(id, 10))
            .query(`DELETE FROM AppRoles WHERE Id = @id AND IsSystem = 0`);

        res.json({ status: 1, message: 'Role deleted successfully.' });
    } catch (err) {
        sendServerError(res, err, 'roles/delete', 'Failed to delete role.');
    }
});

/* ──────────────────────────────────────────────────────────
   Helpers
────────────────────────────────────────────────────────── */
function parsePermissions(raw) {
    try { return JSON.parse(raw || '[]'); }
    catch { return []; }
}

/* Called by server.js on startup to ensure the AppRoles table is seeded */
async function ensureDefaultRoles() {
    const defaults = [
        { roleName: 'admin',     displayName: 'Administrator', description: 'Full system access — all screens and user management.',
          permissions: ['dashBoard','vendor','warehouse','gate','partyBinMaster','grnPushing','joStatus','userManagement'] },
        { roleName: 'manager',   displayName: 'Manager',       description: 'View JO Status overview, production details and warehouse approvals.',
          permissions: ['dashBoard','warehouse','joStatus'] },
        { roleName: 'vendor',    displayName: 'Vendor',        description: 'Access vendor entry process and JO Status.',
          permissions: ['vendor','joStatus'] },
        { roleName: 'watchman',  displayName: 'Watchman',      description: 'Access Dashboard and Gate Entry.',
          permissions: ['dashBoard','gate'] },
        { roleName: 'inventory', displayName: 'Inventory',     description: 'Access Vendor Entry, Party Bin Master and GRN Pushing.',
          permissions: ['vendor','partyBinMaster','grnPushing'] },
        { roleName: 'operator',  displayName: 'Operator',      description: 'Limited operational task access.',
          permissions: ['vendor'] },
    ];

    for (const r of defaults) {
        const exists = await pool.request()
            .input('roleName', sql.NVarChar, r.roleName)
            .query(`SELECT Id FROM AppRoles WHERE RoleName = @roleName`);
        if (exists.recordset.length === 0) {
            await pool.request()
                .input('roleName',    sql.NVarChar, r.roleName)
                .input('displayName', sql.NVarChar, r.displayName)
                .input('description', sql.NVarChar, r.description)
                .input('permissions', sql.NVarChar, JSON.stringify(r.permissions))
                .query(`
                    INSERT INTO AppRoles (RoleName, DisplayName, Description, Permissions, IsSystem, CreatedAt)
                    VALUES (@roleName, @displayName, @description, @permissions, 1, GETDATE())
                `);
        }
    }
}

module.exports = router;
module.exports.ensureDefaultRoles = ensureDefaultRoles;
