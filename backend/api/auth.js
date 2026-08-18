const express = require('express');
const crypto  = require('crypto');
const bcrypt  = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { pool, sql } = require('../db');
const { signToken, authenticate } = require('../middleware/auth');
const { sendServerError } = require('../utils/respond');

const INTERAKT_API_TOKEN = process.env.INTERAKT_API_TOKEN;
const BCRYPT_ROUNDS = 12;
const MAX_OTP_ATTEMPTS = 5;

/** Legacy unsalted SHA-256 hash — kept only to verify passwords created before the bcrypt migration. */
function legacyHash(plain) {
    return crypto.createHash('sha256').update(plain).digest('hex');
}

/** True if the stored value looks like a bcrypt hash (all new/reset passwords use this format). */
function isBcryptHash(hash) {
    return typeof hash === 'string' && /^\$2[aby]?\$/.test(hash);
}

/**
 * Verifies `plain` against `storedHash`, transparently migrating legacy SHA-256
 * hashes — and any plaintext values seeded directly into the database outside
 * the app's own hashing logic — to bcrypt in place, so existing accounts keep
 * working without a forced password reset. Returns true/false for the match.
 */
async function verifyAndMigratePassword(plain, storedHash, onMigrate) {
    if (isBcryptHash(storedHash)) {
        return bcrypt.compare(plain, storedHash);
    }
    const matches = storedHash === legacyHash(plain) || storedHash === plain;
    if (matches && typeof onMigrate === 'function') {
        const newHash = await bcrypt.hash(plain, BCRYPT_ROUNDS);
        await onMigrate(newHash);
    }
    return matches;
}

async function hashPassword(plain) {
    return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

const router = express.Router();

// In-memory store for OTPs. In production, use a more persistent store like Redis.
const otpStore = new Map();

// Tight rate limits on the auth surface — mitigates brute-force / OTP guessing / credential stuffing.
const otpRequestLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${req.body?.mobileNumber || ''}`,
    message: { message: 'Too many OTP requests. Please try again later.' },
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many login attempts. Please try again later.' },
});

// POST /api/auth/send-otp
// Generates and sends an OTP via WhatsApp
router.post('/send-otp', otpRequestLimiter, async (req, res) => {
    const { mobileNumber } = req.body;
    if (!mobileNumber) {
        return res.status(400).send({ message: 'Mobile number is required.' });
    }

    // 1. Verify vendor exists
    try {
        const result = await pool.request()
            .input('mobileNumber', sql.NVarChar, mobileNumber)
            .query(`
                SELECT TOP 1 CardCode FROM OCRD
                WHERE (Phone1 = @mobileNumber OR Phone2 = @mobileNumber) AND validFor = 'Y'
            `);

        if (result.recordset.length === 0) {
            return res.status(404).send({ message: 'Vendor not found or not valid.' });
        }
    }
    catch (err) {
        return sendServerError(res, err, 'send-otp:lookup', 'Could not connect to the vendor directory.');
    }

    // 2. Generate and store OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit OTP
    const expires = Date.now() + 5 * 60 * 1000; // 5 minute expiry
    otpStore.set(mobileNumber, { otp, expires, attempts: 0 });

    // 3. Send OTP via Interakt API — never echo the OTP back in the HTTP response.
    if (!INTERAKT_API_TOKEN) {
        return sendServerError(res, new Error('INTERAKT_API_TOKEN is not configured'), 'send-otp:config', 'OTP delivery is not configured.');
    }

    try {
        const response = await fetch('https://api.interakt.ai/v1/public/message/', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${INTERAKT_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                "countryCode": "+91",
                "phoneNumber": `${mobileNumber}`,
                "callbackData": "some text here",
                "type": "Template",
                "template": {
                    "name": "dwp_login",
                    "languageCode": "en",
                    "bodyValues": [
                        `${otp}`
                    ],
                    "buttonValues": {
                        "0": [
                            `${otp}`
                        ]
                    }
                }
            })
        });

        if (!response.ok) {
            return res.status(500).send({ message: 'Failed to send OTP to WhatsApp.' });
        }

        return res.status(200).send({ success: true, message: 'OTP sent successfully via WhatsApp.' });

    } catch (error) {
        return sendServerError(res, error, 'send-otp:whatsapp', 'An error occurred while sending the OTP.');
    }
});


// POST /api/auth/login/vendor
// Handles mobile number based login for vendors
router.post('/login/vendor', loginLimiter, async (req, res) => {
    const { mobileNumber, otp } = req.body;
    if (!mobileNumber || !otp) {
        return res.status(400).send({ message: 'Mobile number and OTP are required.' });
    }

    // 1. Verify OTP
    const storedOtpData = otpStore.get(mobileNumber);
    if (!storedOtpData) {
        return res.status(401).send({ message: 'OTP not found. Please request a new one.' });
    }

    if (Date.now() > storedOtpData.expires) {
        otpStore.delete(mobileNumber); // Clean up expired OTP
        return res.status(401).send({ message: 'OTP has expired. Please request a new one.' });
    }

    if (storedOtpData.attempts >= MAX_OTP_ATTEMPTS) {
        otpStore.delete(mobileNumber);
        return res.status(429).send({ message: 'Too many incorrect attempts. Please request a new OTP.' });
    }

    if (storedOtpData.otp !== otp) {
        storedOtpData.attempts += 1;
        return res.status(401).send({ message: 'Invalid OTP.' });
    }

    // OTP is valid, clean it up
    otpStore.delete(mobileNumber);

    // 2. Fetch user details and log in
    try {
        const result = await pool.request()
            .input('mobileNumber', sql.NVarChar, mobileNumber)
            .query(`
                SELECT TOP 1 CardCode, CardFName, CardName
                FROM OCRD
                WHERE (Phone1 = @mobileNumber OR Phone2 = @mobileNumber) AND validFor = 'Y' AND CardType = 'S'
            `);

        if (result.recordset.length > 0) {
            const dbUser = result.recordset[0];
            const user = {
                mobileNumber: mobileNumber,
                partyCode: dbUser.CardCode,
                name: dbUser.CardName || 'N/A',
                role: 'vendor',
                permissions: ['vendor', 'joStatus'],
            };
            const token = signToken(user);
            return res.json({ ...user, token });
        }
        else
        {
            // This case should ideally not be hit if send-otp is used, but as a safeguard:
            return res.status(404).send({ message: 'Vendor not found or not valid.' });
        }
    } catch (err) {
        return sendServerError(res, err, 'login/vendor', 'Could not connect to the vendor directory. Please try again later.');
    }
});

// POST /api/auth/login/member
router.post('/login/member', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).send({ message: 'Username and password are required.' });
    }

    try {
        const result = await pool.request()
            .input('username', sql.NVarChar, username)
            .query(`
                SELECT u.Id, u.Username, u.FullName, u.Role, u.PhoneNumber, u.PasswordHash,
                       ISNULL(r.Permissions, '[]') AS Permissions
                FROM Users u
                LEFT JOIN AppRoles r ON r.RoleName = u.Role
                WHERE u.Username = @username
                  AND u.IsActive = 1
            `);

        const user = result.recordset[0];
        const passwordOk = user
            ? await verifyAndMigratePassword(password, user.PasswordHash, async (newHash) => {
                await pool.request()
                    .input('id', sql.Int, user.Id)
                    .input('newHash', sql.NVarChar, newHash)
                    .query(`UPDATE Users SET PasswordHash = @newHash WHERE Id = @id`);
            })
            : false;

        if (!user || !passwordOk) {
            return res.status(401).send({ message: 'Invalid username or password.' });
        }

        let permissions = [];
        try { permissions = JSON.parse(user.Permissions || '[]'); } catch {}

        const sessionUser = {
            id: user.Id,
            username: user.Username,
            name: user.FullName,
            role: user.Role,
            permissions,
        };
        const token = signToken(sessionUser);
        return res.json({ ...sessionUser, token });
    } catch (err) {
        return sendServerError(res, err, 'login/member', 'Server error during login.');
    }
});

// PUT /api/auth/change-password
// Requires a valid session; a user may only change their own password.
router.put('/change-password', authenticate, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const username = req.user.username;

    if (!username) {
        return res.status(403).json({ message: 'Only member accounts can change their password here.' });
    }
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: 'All fields are required.' });
    }
    if (newPassword.length < 8) {
        return res.status(400).json({ message: 'New password must be at least 8 characters.' });
    }
    try {
        const result = await pool.request()
            .input('username', sql.NVarChar, username)
            .query(`SELECT Id, PasswordHash FROM Users WHERE Username = @username AND IsActive = 1`);

        const user = result.recordset[0];
        const currentOk = user ? await verifyAndMigratePassword(currentPassword, user.PasswordHash) : false;

        if (!user || !currentOk) {
            return res.status(401).json({ message: 'Current password is incorrect.' });
        }

        const newHash = await hashPassword(newPassword);
        await pool.request()
            .input('id', sql.Int, user.Id)
            .input('newPasswordHash', sql.NVarChar, newHash)
            .query(`UPDATE Users SET PasswordHash = @newPasswordHash WHERE Id = @id`);

        res.json({ success: true, message: 'Password changed successfully.' });
    } catch (err) {
        sendServerError(res, err, 'change-password', 'Server error.');
    }
});

module.exports = router;
