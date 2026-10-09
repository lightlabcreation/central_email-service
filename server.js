require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');

const app = express();
app.use(cors());

const iconv = require('iconv-lite');

// We use multer memory storage. We set defCharset to 'latin1' to prevent busboy from 
// corrupting non-UTF8 bytes (like ISO-8859-1 French characters) into question marks.
const upload = multer({ 
    storage: multer.memoryStorage(),
    defCharset: 'latin1' 
});

// POST /api/incoming-email
// SendGrid Inbound Parse will hit this endpoint when a tenant replies!
app.post('/api/incoming-email', upload.any(), async (req, res) => {
    // 1. Instantly respond 200 OK so SendGrid doesn't time out or retry
    res.status(200).send('OK');

    // SendGrid puts the text fields in req.body and files in req.files
    const emailData = req.body; 

    // Parse the charsets field provided by SendGrid
    let charsets = {};
    if (emailData.charsets) {
        try {
            charsets = JSON.parse(emailData.charsets);
        } catch (e) {}
    }

    // Fix character encoding issues
    for (let key in emailData) {
        if (typeof emailData[key] === 'string' && key !== 'charsets') {
            const charset = (charsets[key] || 'utf-8').toLowerCase();
            try {
                // Since multer parsed it as latin1, we have the raw bytes intact.
                const rawBytes = Buffer.from(emailData[key], 'latin1');
                
                // Decode using the exact charset SendGrid told us it was sent in
                if (iconv.encodingExists(charset)) {
                    emailData[key] = iconv.decode(rawBytes, charset);
                } else {
                    emailData[key] = iconv.decode(rawBytes, 'utf8');
                }
            } catch (e) {
                // Ignore conversion errors
            }
        }
    }

    const toAddress = emailData.to || ''; // e.g. "reply+property1_tenant99@reply.campushabitations.com"

    console.log(`Received incoming email bound for: ${toAddress}`);

    // 2. Read the address and route it to the correct backend!
    try {
        if (toAddress.includes('+property1')) {
            console.log("Routing to Property 1 Backend...");
            await axios.post('https://saif-property-client-railway-production.up.railway.app/api/webhooks/email/incoming', emailData, {
                headers: { 'Authorization': `Bearer ${process.env.INTERNAL_SECRET_KEY}` }
            });
        } 
        else if (toAddress.includes('+property2')) {
            console.log("Routing to Property 2 Backend...");
            await axios.post('https://saif-property2-client-railway-production.up.railway.app/api/webhooks/email/incoming', emailData, {
                headers: { 'Authorization': `Bearer ${process.env.INTERNAL_SECRET_KEY}` }
            });
        }
        else {
            console.log("No routing tag found, ignoring or sending to default backend.");
        }
    } catch (error) {
        console.error("Failed to forward email. (You can add Queue/Retry logic here later!)", error.message);
    }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Central Email Service (INCOMING ONLY) is running on port ${PORT}`);
});
