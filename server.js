// Load .env for local dev; on cPanel env vars are set via the panel
try { await import('dotenv/config'); } catch {}
import express from 'express';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } from 'baileys';
import https from 'https';
import QRCode from 'qrcode';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcrypt';
import session from 'express-session';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.set('trust proxy', 1); // behind LiteSpeed reverse proxy on cPanel
const router = express.Router();
const PORT = process.env.PORT || 3000;
const TOKENS_DIR = path.join(__dirname, 'tokens');
const BASE_PATH = process.env.BASE_PATH || '';

// Rate limiting
const generalLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
const strictLimiter = rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false });

// Middleware
router.use(generalLimiter);
router.use(express.json());
router.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-dev-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 86400000,
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
    },
}));

// Auth middleware — public paths pass through, everything else requires session
const PUBLIC_PATHS = ['/login.html', '/login.js', '/styles.css', '/api/login', '/api/auth-status'];
router.use((req, res, next) => {
    if (PUBLIC_PATHS.includes(req.path)) return next();
    if (req.session && req.session.authenticated) return next();
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    return res.redirect('login.html');
});

router.use(express.static(path.join(__dirname, 'public')));

// Global state
let sock = null;
let qrCodeData = null;
let isAuthenticated = false;
let connectionStatus = 'disconnected';
let initRetryCount = 0;
const MAX_INIT_RETRIES = 3;

// Clear session tokens to force fresh QR code generation
function clearSessionTokens() {
    if (fs.existsSync(TOKENS_DIR)) {
        fs.rmSync(TOKENS_DIR, { recursive: true, force: true });
        console.log('Cleared old session tokens');
    }
}

// Fetch WA Web version using node:https (avoids undici WASM crash on shared hosting)
// Mirrors Baileys' fetchLatestWaWebVersion: fetches sw.js and extracts client_revision
function fetchWAVersion() {
    return new Promise((resolve, reject) => {
        https.get('https://web.whatsapp.com/sw.js', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const match = data.match(/client_revision.{0,5}?(\d{5,})/);
                if (match) {
                    resolve([2, 3000, Number(match[1])]);
                } else {
                    reject(new Error('Could not extract client_revision from sw.js'));
                }
            });
        }).on('error', reject);
    });
}

// Format phone number to Baileys JID
function formatJid(number) {
    const digits = number.replace(/[^\d]/g, '');
    if (!digits || digits.length < 10) return null;
    return `${digits}@s.whatsapp.net`;
}

// API key auth middleware for external endpoints — SHA-256 hash in EXTERNAL_API_KEY_HASH
function apiKeyAuth(req, res, next) {
    const storedHash = process.env.EXTERNAL_API_KEY_HASH;
    if (!storedHash) {
        return res.status(500).json({ success: false, error: { code: 'api_key_not_configured', message: 'External API key not configured on server' } });
    }
    const provided = req.header('X-API-Key');
    if (!provided) {
        return res.status(401).json({ success: false, error: { code: 'missing_api_key', message: 'X-API-Key header is required' } });
    }
    const providedHash = crypto.createHash('sha256').update(provided).digest();
    let storedBuf;
    try { storedBuf = Buffer.from(storedHash, 'hex'); } catch { storedBuf = Buffer.alloc(0); }
    if (storedBuf.length !== providedHash.length || !crypto.timingSafeEqual(storedBuf, providedHash)) {
        return res.status(401).json({ success: false, error: { code: 'invalid_api_key', message: 'Invalid API key' } });
    }
    next();
}

// Validate URL to prevent SSRF — reject private/internal addresses
function isUrlAllowed(urlStr) {
    try {
        const parsed = new URL(urlStr);
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;
        const host = parsed.hostname.toLowerCase();
        if (host === 'localhost' || host.endsWith('.local') || host === '[::1]') return false;
        const parts = host.split('.').map(Number);
        if (parts.length === 4 && parts.every(p => p >= 0 && p <= 255)) {
            if (parts[0] === 10) return false;
            if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
            if (parts[0] === 192 && parts[1] === 168) return false;
            if (parts[0] === 127) return false;
            if (parts[0] === 169 && parts[1] === 254) return false;
            if (parts[0] === 0) return false;
        }
        return true;
    } catch { return false; }
}

// Initialize Baileys client
async function initializeClient(forceNewSession = false) {
    // Reset state
    qrCodeData = null;
    isAuthenticated = false;
    connectionStatus = 'connecting';

    if (forceNewSession) {
        clearSessionTokens();
    }

    console.log('Initializing Baileys client...');

    let version;
    try {
        version = await fetchWAVersion();
        console.log('Fetched WA version:', version);
    } catch (err) {
        console.warn('Could not fetch WA version, using Baileys default:', err.message);
    }

    const { state, saveCreds } = await useMultiFileAuthState(TOKENS_DIR);

    sock = makeWASocket({
        auth: state,
        ...(version && { version }),
        browser: Browsers.ubuntu('Chrome'),
        logger: pino({ level: 'silent' }),
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR Code received');
            qrCodeData = await QRCode.toDataURL(qr);
            connectionStatus = 'qr_ready';
            initRetryCount = 0;
        }

        if (connection === 'open') {
            console.log('WhatsApp connected successfully');
            isAuthenticated = true;
            qrCodeData = null;
            connectionStatus = 'connected';
            initRetryCount = 0;
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;

            console.log('Connection closed. Reason:', statusCode, loggedOut ? '(logged out)' : '');

            isAuthenticated = false;
            connectionStatus = 'disconnected';
            sock = null;

            if (loggedOut) {
                clearSessionTokens();
                initRetryCount = 0;
                initializeClient(true);
                return;
            }

            // Non-logout disconnects: reconnect with retry limit
            initRetryCount++;
            if (initRetryCount <= MAX_INIT_RETRIES) {
                console.log(`Reconnecting... (attempt ${initRetryCount}/${MAX_INIT_RETRIES})`);
                initializeClient(false);
            } else {
                console.error(`Failed to connect after ${MAX_INIT_RETRIES} attempts. Use POST /api/restart to try again.`);
            }
        }
    });
}

// --- API Routes ---

// Get connection status
router.get('/api/status', (req, res) => {
    res.json({
        status: connectionStatus,
        authenticated: isAuthenticated,
        hasQR: qrCodeData !== null,
    });
});

// Get QR Code
router.get('/api/qr', (req, res) => {
    if (isAuthenticated) {
        return res.json({ success: false, message: 'Already authenticated', authenticated: true });
    }
    if (!qrCodeData) {
        return res.json({ success: false, message: 'QR Code not ready yet. Please wait...', status: connectionStatus });
    }
    res.json({ success: true, qrCode: qrCodeData, authenticated: false });
});

// Login
router.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const adminUser = process.env.ADMIN_USERNAME;
    const adminHash = process.env.ADMIN_PASSWORD_HASH;

    if (!adminUser || !adminHash) {
        console.error('ADMIN_USERNAME or ADMIN_PASSWORD_HASH not configured');
        return res.status(500).json({ success: false, error: 'Server authentication not configured' });
    }

    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Username and password are required' });
    }

    if (username !== adminUser) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    try {
        const match = await bcrypt.compare(password, adminHash);
        if (!match) {
            return res.status(401).json({ success: false, error: 'Invalid credentials' });
        }

        req.session.authenticated = true;
        res.json({ success: true, message: 'Login successful' });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ success: false, error: 'Login failed' });
    }
});

// Auth status check
router.get('/api/auth-status', (req, res) => {
    res.json({ authenticated: req.session && req.session.authenticated === true });
});

// Restart / re-initialize connection (force fresh QR)
router.post('/api/restart', strictLimiter, async (req, res) => {
    try {
        console.log('Restart requested...');
        if (sock) {
            sock.end();
            sock = null;
        }
        isAuthenticated = false;
        qrCodeData = null;
        connectionStatus = 'connecting';
        initRetryCount = 0;

        initializeClient(true);

        res.json({ success: true, message: 'Restarting connection... QR code will be available shortly.' });
    } catch (error) {
        console.error('Error restarting:', error);
        res.status(500).json({ success: false, error: 'Failed to restart' });
    }
});

// Send text message
router.post('/api/send-message', async (req, res) => {
    try {
        if (!isAuthenticated || !sock) {
            return res.status(401).json({ success: false, error: 'WhatsApp not authenticated. Please scan QR code first.' });
        }

        const { number, message } = req.body;
        if (!number || !message) {
            return res.status(400).json({ success: false, error: 'Number and message are required' });
        }
        if (message.length > 4096) {
            return res.status(400).json({ success: false, error: 'Message too long (max 4096 characters)' });
        }

        const jid = formatJid(number);
        if (!jid) {
            return res.status(400).json({ success: false, error: 'Invalid phone number. Please provide a valid number with country code (e.g., 201234567890)' });
        }

        console.log('Sending message to:', jid);
        const result = await sock.sendMessage(jid, { text: message });

        res.json({ success: true, message: 'Message sent successfully', data: result });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ success: false, error: 'Failed to send message' });
    }
});

// Send message with image
router.post('/api/send-image', async (req, res) => {
    try {
        if (!isAuthenticated || !sock) {
            return res.status(401).json({ success: false, error: 'WhatsApp not authenticated' });
        }

        const { number, imageUrl, caption } = req.body;
        if (!number || !imageUrl) {
            return res.status(400).json({ success: false, error: 'Number and imageUrl are required' });
        }
        if (!isUrlAllowed(imageUrl)) {
            return res.status(400).json({ success: false, error: 'Invalid image URL. Only public http/https URLs are allowed.' });
        }
        if (caption && caption.length > 1024) {
            return res.status(400).json({ success: false, error: 'Caption too long (max 1024 characters)' });
        }

        const jid = formatJid(number);
        if (!jid) {
            return res.status(400).json({ success: false, error: 'Invalid phone number. Please provide a valid number with country code (e.g., 201234567890)' });
        }

        console.log('Sending image to:', jid);
        const result = await sock.sendMessage(jid, { image: { url: imageUrl }, caption: caption || '' });

        res.json({ success: true, message: 'Image sent successfully', data: result });
    } catch (error) {
        console.error('Error sending image:', error);
        res.status(500).json({ success: false, error: 'Failed to send image' });
    }
});

// Check if number is registered on WhatsApp
router.post('/api/check-number', async (req, res) => {
    try {
        if (!isAuthenticated || !sock) {
            return res.status(401).json({ success: false, error: 'WhatsApp not authenticated' });
        }

        const { number } = req.body;
        if (!number) {
            return res.status(400).json({ success: false, error: 'Number is required' });
        }

        const digits = number.replace(/[^\d]/g, '');
        const [result] = await sock.onWhatsApp(digits);

        res.json({
            success: true,
            data: {
                numberExists: result?.exists || false,
                id: result ? { user: result.jid?.replace('@s.whatsapp.net', '') } : null,
            },
        });
    } catch (error) {
        console.error('Error checking number:', error);
        res.status(500).json({ success: false, error: 'Failed to check number' });
    }
});

// Logout — connection.update handler handles cleanup + re-initialization on loggedOut
router.post('/api/logout', strictLimiter, async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        req.session.destroy(() => {});
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        console.error('Error logging out:', error);
        res.status(500).json({ success: false, error: 'Failed to logout' });
    }
});

// --- External API (API-key auth, no session, no rate limit) ---
const externalRouter = express.Router();
externalRouter.use(express.json());
externalRouter.use(apiKeyAuth);

function whatsappReady(res) {
    if (!isAuthenticated || !sock) {
        res.status(503).json({
            success: false,
            error: { code: 'whatsapp_not_authenticated', message: 'WhatsApp is not connected. QR code must be scanned by an admin.' },
            connectionStatus,
            hasQR: qrCodeData !== null,
        });
        return false;
    }
    return true;
}

externalRouter.post('/send-message', async (req, res) => {
    if (!whatsappReady(res)) return;
    const { number, message } = req.body || {};
    if (!number || !message) {
        return res.status(400).json({ success: false, error: { code: 'invalid_input', message: 'number and message are required' } });
    }
    if (typeof message !== 'string' || message.length > 4096) {
        return res.status(400).json({ success: false, error: { code: 'invalid_input', message: 'message must be a string up to 4096 characters' } });
    }
    const jid = formatJid(number);
    if (!jid) {
        return res.status(400).json({ success: false, error: { code: 'invalid_number', message: 'Invalid phone number; provide digits with country code' } });
    }
    try {
        const result = await sock.sendMessage(jid, { text: message });
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('External send-message error:', error);
        res.status(500).json({ success: false, error: { code: 'send_failed', message: 'Failed to send message' } });
    }
});

externalRouter.post('/send-image', async (req, res) => {
    if (!whatsappReady(res)) return;
    const { number, imageUrl, caption } = req.body || {};
    if (!number || !imageUrl) {
        return res.status(400).json({ success: false, error: { code: 'invalid_input', message: 'number and imageUrl are required' } });
    }
    if (!isUrlAllowed(imageUrl)) {
        return res.status(400).json({ success: false, error: { code: 'invalid_image_url', message: 'Only public http(s) URLs are allowed' } });
    }
    if (caption && (typeof caption !== 'string' || caption.length > 1024)) {
        return res.status(400).json({ success: false, error: { code: 'invalid_input', message: 'caption must be a string up to 1024 characters' } });
    }
    const jid = formatJid(number);
    if (!jid) {
        return res.status(400).json({ success: false, error: { code: 'invalid_number', message: 'Invalid phone number; provide digits with country code' } });
    }
    try {
        const result = await sock.sendMessage(jid, { image: { url: imageUrl }, caption: caption || '' });
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('External send-image error:', error);
        res.status(500).json({ success: false, error: { code: 'send_failed', message: 'Failed to send image' } });
    }
});

externalRouter.post('/check-number', async (req, res) => {
    if (!whatsappReady(res)) return;
    const { number } = req.body || {};
    if (!number) {
        return res.status(400).json({ success: false, error: { code: 'invalid_input', message: 'number is required' } });
    }
    const digits = String(number).replace(/[^\d]/g, '');
    if (digits.length < 10) {
        return res.status(400).json({ success: false, error: { code: 'invalid_number', message: 'Invalid phone number; provide digits with country code' } });
    }
    try {
        const [result] = await sock.onWhatsApp(digits);
        res.json({
            success: true,
            data: {
                numberExists: result?.exists || false,
                id: result ? { user: result.jid?.replace('@s.whatsapp.net', '') } : null,
            },
        });
    } catch (error) {
        console.error('External check-number error:', error);
        res.status(500).json({ success: false, error: { code: 'check_failed', message: 'Failed to check number' } });
    }
});

// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:"],
        },
    },
}));

// Mount external API router (no session, no rate limit) before the main router
app.use((BASE_PATH || '') + '/api/external', externalRouter);

// Mount router at base path or root
if (BASE_PATH) app.use(BASE_PATH, router);
else app.use('/', router);

// Start server
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Initializing WhatsApp connection...');
    await initializeClient(false);
});

// Export for Passenger compatibility
export default app;

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    if (sock) sock.end();
    process.exit(0);
});
