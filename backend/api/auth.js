const express = require('express');
const crypto  = require('crypto');
const { pool, sql } = require('../db');

function hashPassword(plain) {
    return crypto.createHash('sha256').update(plain).digest('hex');
}

const router = express.Router();

// In-memory store for OTPs. In production, use a more persistent store like Redis.
const otpStore = new Map();

// POST /api/auth/send-otp
// Generates and sends an OTP via WhatsApp
router.post('/send-otp', async (req, res) => {
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
        return res.status(503).send({ message: 'Could not connect to the vendor directory.' });
    }

    // 2. Generate and store OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString(); // 4-digit OTP
    const expires = Date.now() + 5 * 60 * 1000; // 5 minute expiry
    otpStore.set(mobileNumber, { otp, expires });
    // 3. Send OTP via Interakt API
    
    try {
        const response = await fetch('https://api.interakt.ai/v1/public/message/', {
            method: 'POST',
            headers: {
                'Authorization': `Basic (YVZ3OEVGOGJTWDRDSFBybk0zVUFCSVplbFVPeE9lMEN3T0QyX0dFdVhlbzo=)`,
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
            const errorBody = await response.text();
            return res.status(500).send({ message: 'Failed to send OTP to WhatsApp.' });
        }
        
        return res.status(200).send({success:true, message: 'OTP sent successfully via WhatsApp.', data:otp });

    } catch (error) {
        return res.status(500).send({success: false, message: 'An error occurred while sending the OTP.' });
    }
});


// POST /api/auth/login/vendor
// Handles mobile number based login for vendors
router.post('/login/vendor', async (req, res) => {
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

    if (storedOtpData.otp !== otp) {
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
                role: 'vendor'
            };
            return res.json(user);
        } 
        else 
        {
            // This case should ideally not be hit if send-otp is used, but as a safeguard:
            return res.status(404).send({ message: 'Vendor not found or not valid.' });
        }
    } catch (err) {
        console.log(`[WARN] Database query for OCRD failed. This is expected if the '[BBLive]' database is not available. Error: ${err.message}`);
        return res.status(503).send({ message: 'Could not connect to the vendor directory. Please try again later.' });
    }
});

// POST /api/auth/login/member
router.post('/login/member', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).send({ message: 'Username and password are required.' });
    }

    try {
        const result = await pool.request()
            .input('username', sql.NVarChar, username)
            .input('password', sql.NVarChar, hashPassword(password))
            .query(`
                SELECT u.Username, u.FullName, u.Role, u.PhoneNumber,
                       ISNULL(r.Permissions, '[]') AS Permissions
                FROM Users u
                LEFT JOIN AppRoles r ON r.RoleName = u.Role
                WHERE u.Username = @username
                  AND u.PasswordHash = @password
                  AND u.IsActive = 1
            `);

        if (result.recordset.length > 0) {
            const user = result.recordset[0];
            let permissions = [];
            try { permissions = JSON.parse(user.Permissions || '[]'); } catch {}
            return res.json({
                username: user.Username,
                name: user.FullName,
                role: user.Role,
                permissions,
            });
        } else {
            return res.status(401).send({ message: 'Invalid username or password.' });
        }
    } catch (err) {
        console.error('[login/member]', err.message);
        res.status(500).send({ message: 'Server error during login.' });
    }
});

// PUT /api/auth/change-password
router.put('/change-password', async (req, res) => {
    const { username, currentPassword, newPassword } = req.body;
    if (!username || !currentPassword || !newPassword) {
        return res.status(400).json({ message: 'All fields are required.' });
    }
    if (newPassword.length < 4) {
        return res.status(400).json({ message: 'New password must be at least 4 characters.' });
    }
    try {
        const check = await pool.request()
            .input('username',     sql.NVarChar, username)
            .input('passwordHash', sql.NVarChar, hashPassword(currentPassword))
            .query(`
                SELECT Id FROM Users
                WHERE Username = @username AND PasswordHash = @passwordHash AND IsActive = 1
            `);
        if (check.recordset.length === 0) {
            return res.status(401).json({ message: 'Current password is incorrect.' });
        }
        await pool.request()
            .input('username',        sql.NVarChar, username)
            .input('newPasswordHash', sql.NVarChar, hashPassword(newPassword))
            .query(`UPDATE Users SET PasswordHash = @newPasswordHash WHERE Username = @username`);
        res.json({ success: true, message: 'Password changed successfully.' });
    } catch (err) {
        console.error('[change-password]', err.message);
        res.status(500).json({ message: 'Server error.' });
    }
});

module.exports = router;