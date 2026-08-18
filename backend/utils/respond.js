/**
 * Logs the full error server-side and sends a sanitized message to the client.
 * Prevents leaking SQL error text, stack traces, or internal paths in API responses.
 */
function sendServerError(res, err, context, fallbackMessage) {
    console.error(`[${context}]`, err);
    const message = fallbackMessage || 'An unexpected error occurred. Please try again later.';
    return res.status(500).json({ status: 0, message });
}

module.exports = { sendServerError };
