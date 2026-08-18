const express = require('express');
const bcrypt  = require('bcryptjs');
const { pool, sql } = require('../db');
const { authenticate, authorize } = require('../middleware/auth');
const { sendServerError } = require('../utils/respond');

const router = express.Router();
const BCRYPT_ROUNDS = 12;

async function hashPassword(plain) {
    return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

router.use(authenticate, authorize('userManagement'));

/* ──────────────────────────────────────────────────────────
   GET /api/users/list
   Returns all users (password hash excluded)
────────────────────────────────────────────────────────── */
router.get('/list', async (req, res) => {
    try {
        const result = await pool.request().query(`
            SELECT Id, Username, FullName, PhoneNumber, Email, Role,
                   IsActive, CreatedAt
            FROM Users
            ORDER BY CreatedAt DESC
        `);
        res.json({ status: 1, data: result.recordset });
    } catch (err) {
        sendServerError(res, err, 'users/list', 'Failed to load users.');
    }
});

/* ──────────────────────────────────────────────────────────
   POST /api/users/create
   Body: { username, fullName, phoneNumber, email, password, role, isActive }
────────────────────────────────────────────────────────── */
router.post('/create', async (req, res) => {
    const { username, fullName, phoneNumber, email, password, role, isActive } = req.body;

    if (!username || !fullName || !password || !role) {
        return res.status(400).json({ status: 0, message: 'Username, Full Name, Password, and Role are required.' });
    }
    if (password.length < 8) {
        return res.status(400).json({ status: 0, message: 'Password must be at least 8 characters.' });
    }

    try {
        // Duplicate check
        const dup = await pool.request()
            .input('username', sql.NVarChar, username.trim())
            .input('email',    sql.NVarChar, email ? email.trim() : '')
            .query(`
                SELECT Id FROM Users
                WHERE Username = @username
                   OR (@email <> '' AND Email = @email)
            `);

        if (dup.recordset.length > 0) {
            return res.status(409).json({ status: 0, message: 'Username or Email already exists.' });
        }

        await pool.request()
            .input('username',    sql.NVarChar, username.trim())
            .input('fullName',    sql.NVarChar, fullName.trim())
            .input('phoneNumber', sql.NVarChar, phoneNumber ? phoneNumber.trim() : '')
            .input('email',       sql.NVarChar, email ? email.trim() : '')
            .input('passwordHash',sql.NVarChar, await hashPassword(password))
            .input('role',        sql.NVarChar, role)
            .input('isActive',    sql.Bit,      isActive !== false ? 1 : 0)
            .query(`
                INSERT INTO Users (Username, FullName, PhoneNumber, Email, PasswordHash, Role, IsActive, CreatedAt)
                VALUES (@username, @fullName, @phoneNumber, @email, @passwordHash, @role, @isActive, GETDATE())
            `);

        res.json({ status: 1, message: 'User created successfully.' });
    } catch (err) {
        sendServerError(res, err, 'users/create', 'Failed to create user.');
    }
});

/* ──────────────────────────────────────────────────────────
   PUT /api/users/update/:id
   Body: { fullName, phoneNumber, email, role, isActive }
   Username is NOT editable after creation.
────────────────────────────────────────────────────────── */
router.put('/update/:id', async (req, res) => {
    const { id } = req.params;
    const { fullName, phoneNumber, email, role, isActive } = req.body;

    if (!fullName || !role) {
        return res.status(400).json({ status: 0, message: 'Full Name and Role are required.' });
    }

    try {
        // Duplicate email check (exclude self)
        if (email) {
            const dup = await pool.request()
                .input('email', sql.NVarChar, email.trim())
                .input('id',    sql.Int,      parseInt(id))
                .query(`SELECT Id FROM Users WHERE Email = @email AND Id <> @id`);
            if (dup.recordset.length > 0) {
                return res.status(409).json({ status: 0, message: 'Email already used by another user.' });
            }
        }

        const result = await pool.request()
            .input('id',          sql.Int,      parseInt(id))
            .input('fullName',    sql.NVarChar, fullName.trim())
            .input('phoneNumber', sql.NVarChar, phoneNumber ? phoneNumber.trim() : '')
            .input('email',       sql.NVarChar, email ? email.trim() : '')
            .input('role',        sql.NVarChar, role)
            .input('isActive',    sql.Bit,      isActive ? 1 : 0)
            .query(`
                UPDATE Users
                SET FullName = @fullName, PhoneNumber = @phoneNumber,
                    Email = @email, Role = @role, IsActive = @isActive
                WHERE Id = @id
            `);

        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({ status: 0, message: 'User not found.' });
        }
        res.json({ status: 1, message: 'User updated successfully.' });
    } catch (err) {
        sendServerError(res, err, 'users/update', 'Failed to update user.');
    }
});

/* ──────────────────────────────────────────────────────────
   PUT /api/users/toggle-status/:id
   Body: { isActive }
────────────────────────────────────────────────────────── */
router.put('/toggle-status/:id', async (req, res) => {
    const { id } = req.params;
    const { isActive } = req.body;

    try {
        await pool.request()
            .input('id',       sql.Int, parseInt(id))
            .input('isActive', sql.Bit, isActive ? 1 : 0)
            .query(`UPDATE Users SET IsActive = @isActive WHERE Id = @id`);

        res.json({ status: 1, message: `User ${isActive ? 'activated' : 'deactivated'} successfully.` });
    } catch (err) {
        sendServerError(res, err, 'users/toggle-status', 'Failed to update user status.');
    }
});

/* ──────────────────────────────────────────────────────────
   PUT /api/users/reset-password/:id
   Body: { newPassword }
────────────────────────────────────────────────────────── */
router.put('/reset-password/:id', async (req, res) => {
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ status: 0, message: 'Password must be at least 8 characters.' });
    }

    try {
        await pool.request()
            .input('id',           sql.Int,      parseInt(id))
            .input('passwordHash', sql.NVarChar, await hashPassword(newPassword))
            .query(`UPDATE Users SET PasswordHash = @passwordHash WHERE Id = @id`);

        res.json({ status: 1, message: 'Password reset successfully.' });
    } catch (err) {
        sendServerError(res, err, 'users/reset-password', 'Failed to reset password.');
    }
});

module.exports = router;
