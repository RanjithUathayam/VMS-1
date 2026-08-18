const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

if (!JWT_SECRET) {
    // Fail loudly at startup rather than silently signing tokens with `undefined`.
    throw new Error('JWT_SECRET is not set. Add it to backend/.env before starting the server.');
}

/** Issues a signed session token for an authenticated user. */
function signToken(user) {
    return jwt.sign(
        {
            sub:         user.username || user.mobileNumber,
            id:          user.id,
            username:    user.username,
            mobileNumber: user.mobileNumber,
            partyCode:   user.partyCode,
            name:        user.name,
            role:        user.role,
            permissions: user.permissions || [],
        },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

/** Requires a valid Bearer token; attaches the decoded identity to req.user. */
function authenticate(req, res, next) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
        return res.status(401).json({ status: 0, message: 'Authentication required.' });
    }

    try {
        req.user = jwt.verify(token, JWT_SECRET);
        return next();
    } catch (err) {
        return res.status(401).json({ status: 0, message: 'Invalid or expired session. Please log in again.' });
    }
}

/**
 * Requires req.user to hold the given screen permission.
 * Must run after `authenticate`. Admin role always passes.
 */
function authorize(permission) {
    return (req, res, next) => {
        const user = req.user;
        if (!user) {
            return res.status(401).json({ status: 0, message: 'Authentication required.' });
        }
        const perms = Array.isArray(user.permissions) ? user.permissions : [];
        if (user.role === 'admin' || perms.includes(permission)) {
            return next();
        }
        return res.status(403).json({ status: 0, message: 'You do not have permission to perform this action.' });
    };
}

module.exports = { authenticate, authorize, signToken };
