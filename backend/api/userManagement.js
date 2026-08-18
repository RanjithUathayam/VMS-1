const express = require('express');
const crypto  = require('crypto'); // built-in Node.js module, no install needed
const { pool, sql } = require('../db');

const router = express.Router();

/** SHA-256 hash — keeps passwords out of plain-text without requiring bcrypt install */
function hashPassword(plain) {
    return crypto.createHash('sha256').update(plain).digest('hex');
}

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
        console.error('Users list error:', err);
        res.status(500).json({ status: 0, message: err.message });
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
            .input('passwordHash',sql.NVarChar, hashPassword(password))
            .input('role',        sql.NVarChar, role)
            .input('isActive',    sql.Bit,      isActive !== false ? 1 : 0)
            .query(`
                INSERT INTO Users (Username, FullName, PhoneNumber, Email, PasswordHash, Role, IsActive, CreatedAt)
                VALUES (@username, @fullName, @phoneNumber, @email, @passwordHash, @role, @isActive, GETDATE())
            `);

        res.json({ status: 1, message: 'User created successfully.' });
    } catch (err) {
        console.error('Create user error:', err);
        res.status(500).json({ status: 0, message: err.message });
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
        console.error('Update user error:', err);
        res.status(500).json({ status: 0, message: err.message });
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
        console.error('Toggle status error:', err);
        res.status(500).json({ status: 0, message: err.message });
    }
});

/* ──────────────────────────────────────────────────────────
   PUT /api/users/reset-password/:id
   Body: { newPassword }
────────────────────────────────────────────────────────── */
router.put('/reset-password/:id', async (req, res) => {
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 4) {
        return res.status(400).json({ status: 0, message: 'Password must be at least 4 characters.' });
    }

    try {
        await pool.request()
            .input('id',           sql.Int,      parseInt(id))
            .input('passwordHash', sql.NVarChar, hashPassword(newPassword))
            .query(`UPDATE Users SET PasswordHash = @passwordHash WHERE Id = @id`);

        res.json({ status: 1, message: 'Password reset successfully.' });
    } catch (err) {
        console.error('Reset password error:', err);
        res.status(500).json({ status: 0, message: err.message });
    }
});

module.exports = router;
