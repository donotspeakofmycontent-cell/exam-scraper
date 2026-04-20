const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const app = express();
const port = process.env.PORT || 3000;

// Set up Multer for handling file uploads (stored in memory)
const upload = multer({ storage: multer.memoryStorage() });

// Serve static files from the current directory (for index.html, etc)
app.use(express.static(__dirname));

// The secret passphrase. Keep this safe on your server!
const SECRET_PASSPHRASE = 'NaxlexSecretKey2026!#';

app.post('/api/decrypt', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
        const buffer = req.file.buffer;
        
        // Derive a 32-byte key from the passphrase using SHA-256
        const key = crypto.createHash('sha256').update(SECRET_PASSPHRASE).digest();
        
        // The first 12 bytes are the Initialization Vector (IV)
        const iv = buffer.slice(0, 12);
        
        // The remaining bytes contain the encrypted content and the 16-byte authentication tag
        const data = buffer.slice(12);

        if (data.length < 16) {
            throw new Error('Invalid file format: file too small');
        }

        const encryptedContent = data.slice(0, data.length - 16);
        const authTag = data.slice(data.length - 16);

        // Create the decipher using AES-GCM
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);

        // Decrypt the content
        const decrypted = decipher.update(encryptedContent);
        const finalDecrypted = Buffer.concat([decrypted, decipher.final()]);

        // Decompress the decrypted content
        const uncompressed = zlib.gunzipSync(finalDecrypted);

        // Verify it's a valid JSON object
        const jsonObj = JSON.parse(uncompressed.toString('utf8'));

        // Send the decrypted JSON back to the client
        res.json(jsonObj);
    } catch (err) {
        console.error('Decryption failed:', err.message);
        res.status(400).json({ error: 'Decryption failed. The file is invalid or corrupted.' });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
    console.log(`Open your browser to start using the visualizer.`);
});
