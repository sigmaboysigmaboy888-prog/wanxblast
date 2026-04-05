const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const Pino = require('pino');
const path = require('path');
const fs = require('fs-extra');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" },
    transports: ['polling', 'websocket'],
    pingTimeout: 60000,
    pingInterval: 25000
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Ensure directories exist
const sessionsDir = path.join(__dirname, 'sessions');
const publicDir = path.join(__dirname, 'public');
fs.ensureDirSync(sessionsDir);

// Store untuk sessions
const sessions = new Map();
const clients = new Map();

// Logger
const logger = Pino({
    level: 'info',
    transport: {
        target: 'pino-pretty',
        options: { colorize: true }
    }
});

// Cleanup old sessions every hour
setInterval(() => {
    const now = Date.now();
    for (const [number, session] of sessions.entries()) {
        if (session.lastUsed && now - session.lastUsed > 3600000) {
            sessions.delete(number);
            logger.info(`Cleaned up inactive session: ${number}`);
        }
    }
}, 3600000);

// Fungsi untuk membuat session WhatsApp
async function createWhatsAppSession(phoneNumber, socketId) {
    try {
        const sessionDir = path.join(sessionsDir, phoneNumber);
        fs.ensureDirSync(sessionDir);

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: Pino({ level: 'silent' }),
            browser: ['Chrome (Linux)', '', ''],
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 5000,
            generateHighQualityLinkPreview: false,
            patchMessageBeforeSending: (message) => {
                const requiresPatch = !!(
                    message.buttonsMessage ||
                    message.templateMessage ||
                    message.listMessage
                );
                if (requiresPatch) {
                    message = {
                        viewOnceMessage: {
                            message: {
                                messageContextInfo: {
                                    deviceListMetadata: {},
                                    deviceListMetadataVersion: 2
                                },
                                ...message
                            }
                        }
                    };
                }
                return message;
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr && socketId && clients.has(socketId)) {
                io.to(socketId).emit('qr', { phoneNumber, qr });
            }

            if (connection === 'open') {
                logger.info(`Connected: ${phoneNumber}`);
                sessions.set(phoneNumber, { sock, lastUsed: Date.now() });
                
                if (socketId && clients.has(socketId)) {
                    io.to(socketId).emit('status_update', {
                        phoneNumber,
                        status: 'active',
                        message: 'Connected successfully'
                    });
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                let status = 'inactive';
                let statusType = 'inactive';
                
                if (statusCode === DisconnectReason.loggedOut) {
                    status = 'banned';
                    statusType = 'banned';
                    logger.warn(`Account banned: ${phoneNumber}`);
                } else if (statusCode === 429 || lastDisconnect?.error?.message?.includes('rate')) {
                    status = 'limited';
                    statusType = 'limited';
                    logger.warn(`Rate limited: ${phoneNumber}`);
                } else {
                    status = 'inactive';
                    statusType = 'inactive';
                }
                
                if (socketId && clients.has(socketId)) {
                    io.to(socketId).emit('status_update', {
                        phoneNumber,
                        status: statusType,
                        message: `Disconnected: ${status}`
                    });
                }
                
                sessions.delete(phoneNumber);
                
                if (statusCode !== DisconnectReason.loggedOut) {
                    setTimeout(() => createWhatsAppSession(phoneNumber, socketId), 30000);
                }
            }
        });

        sock.ev.on('creds.update', saveCreds);
        
        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                if (msg.key.fromMe) continue;
                logger.info(`Message received from ${msg.key.remoteJid}`);
            }
        });

        return sock;
    } catch (error) {
        logger.error(`Error creating session for ${phoneNumber}:`, error);
        if (socketId && clients.has(socketId)) {
            io.to(socketId).emit('error', { phoneNumber, error: error.message });
        }
        return null;
    }
}

// Socket.IO connection
io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);
    clients.set(socket.id, { connected: true });

    // Request pairing code
    socket.on('request_pairing', async (data) => {
        const { phoneNumber } = data;
        logger.info(`Pairing request for: ${phoneNumber}`);
        
        try {
            const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
            const sock = await createWhatsAppSession(cleanNumber, socket.id);
            
            if (sock) {
                const pairingCode = await sock.requestPairingCode(cleanNumber);
                socket.emit('pairing_code', { phoneNumber: cleanNumber, code: pairingCode });
                logger.info(`Pairing code sent for: ${cleanNumber}`);
            } else {
                socket.emit('error', { phoneNumber: cleanNumber, error: 'Failed to create session' });
            }
        } catch (error) {
            logger.error(`Pairing error for ${phoneNumber}:`, error);
            socket.emit('error', { phoneNumber, error: error.message });
        }
    });

    // Send blast message
    socket.on('send_blast', async (data) => {
        const { phoneNumber, targets, templates, delay } = data;
        logger.info(`Blast request from: ${phoneNumber} to ${targets.length} targets`);
        
        const session = sessions.get(phoneNumber);
        
        if (!session || !session.sock) {
            socket.emit('blast_result', {
                phoneNumber,
                results: targets.map(t => ({ 
                    number: t, 
                    status: 'failed', 
                    message: 'Session not connected' 
                }))
            });
            return;
        }

        const sock = session.sock;
        const results = [];
        
        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            const template = templates[i % templates.length];
            
            try {
                let formattedNumber = target.replace(/[^0-9]/g, '');
                if (!formattedNumber.endsWith('@s.whatsapp.net')) {
                    formattedNumber = formattedNumber + '@s.whatsapp.net';
                }
                
                await sock.sendMessage(formattedNumber, { text: template });
                
                results.push({
                    number: target,
                    status: 'sent',
                    message: 'Message sent successfully'
                });
                
                socket.emit('blast_progress', {
                    phoneNumber,
                    current: i + 1,
                    total: targets.length,
                    lastResult: { number: target, status: 'sent' }
                });
                
                if (delay > 0 && i < targets.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, delay * 1000));
                }
                
            } catch (error) {
                let status = 'failed';
                let errorMsg = error.message;
                
                if (error.message?.includes('banned') || error.message?.includes('blocked')) {
                    status = 'banned';
                } else if (error.message?.includes('rate') || error.message?.includes('too many')) {
                    status = 'limited';
                } else if (error.message?.includes('not registered')) {
                    status = 'pending';
                }
                
                results.push({
                    number: target,
                    status: status,
                    message: errorMsg
                });
                
                socket.emit('blast_progress', {
                    phoneNumber,
                    current: i + 1,
                    total: targets.length,
                    lastResult: { number: target, status: status }
                });
                
                logger.error(`Failed to send to ${target}:`, error.message);
            }
        }
        
        socket.emit('blast_result', { phoneNumber, results });
        logger.info(`Blast completed for ${phoneNumber}: ${results.filter(r => r.status === 'sent').length} sent`);
    });

    // Get session status
    socket.on('get_status', async (data) => {
        const { phoneNumber } = data;
        const session = sessions.get(phoneNumber);
        
        if (!session || !session.sock || !session.sock.user) {
            socket.emit('status_response', {
                phoneNumber,
                status: 'inactive'
            });
        } else {
            socket.emit('status_response', {
                phoneNumber,
                status: 'active'
            });
        }
    });

    socket.on('disconnect', () => {
        logger.info(`Client disconnected: ${socket.id}`);
        clients.delete(socket.id);
    });
});

// Serve HTML
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling
app.use((err, req, res, next) => {
    logger.error(err.stack);
    res.status(500).send('Something broke!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    logger.info(`Server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received, closing server...');
    server.close(() => {
        logger.info('Server closed');
        process.exit(0);
    });
});
