require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const iconv = require('iconv-lite');

const app = express();
app.use(cors());

// We use multer memory storage. We set defCharset to 'latin1' to prevent busboy from 
// corrupting non-UTF8 bytes (like ISO-8859-1 French characters) into question marks.
const upload = multer({ 
    storage: multer.memoryStorage(),
    defCharset: 'latin1' 
});

// Helper function to forward an email copy to Outlook via SendGrid
async function forwardCopyToOutlook(emailData, files, propertyTag, tenantEmail, tenantName) {
    if (!process.env.SENDGRID_API_KEY) {
        console.warn("[Outlook Forward] SENDGRID_API_KEY is not defined in .env, skipping Outlook forward.");
        return;
    }

    const forwardTo = process.env.OUTLOOK_FORWARD_EMAIL || 'Administration@campushabitations.com';
    const senderEmail = process.env.SENDGRID_SENDER_EMAIL || 'Administration@campushabitations.com';
    const subject = `[${propertyTag}] ${emailData.subject || 'New Tenant Reply'}`;

    // Clean body with context banner
    const originalBody = emailData.html || (emailData.text ? emailData.text.replace(/\n/g, '<br/>') : '');
    const banner = `
        <div style="font-family: Arial, sans-serif; background-color: #f1f5f9; border-left: 4px solid #4f46e5; padding: 12px 16px; margin-bottom: 20px; border-radius: 4px; color: #1e293b;">
            <p style="margin: 0 0 6px 0; font-size: 13px;"><strong>Tenant:</strong> ${tenantName} &lt;${tenantEmail}&gt;</p>
            <p style="margin: 0 0 6px 0; font-size: 13px;"><strong>Property:</strong> ${propertyTag}</p>
            <p style="margin: 0; font-size: 12px; color: #64748b;"><em>💡 Tip: Click "Reply" in Outlook to respond directly to this tenant.</em></p>
        </div>
    `;
    const finalHtml = `${banner}${originalBody}`;

    const payload = {
        personalizations: [{
            to: [{ email: forwardTo }]
        }],
        from: {
            email: senderEmail,
            name: `${tenantName} via ${propertyTag}`
        },
        reply_to: {
            email: tenantEmail,
            name: tenantName
        },
        subject: subject,
        content: [{
            type: 'text/html',
            value: finalHtml
        }]
    };

    // Attach any files sent by the tenant
    if (files && files.length > 0) {
        payload.attachments = files.map(file => ({
            content: file.buffer.toString('base64'),
            filename: file.originalname,
            type: file.mimetype,
            disposition: 'attachment'
        }));
    }

    await axios.post('https://api.sendgrid.com/v3/mail/send', payload, {
        headers: {
            'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
            'Content-Type': 'application/json'
        }
    });

    console.log(`✅ Copy forwarded to Outlook (${forwardTo}) for tenant: ${tenantEmail}`);
}

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
    const lowerTo = toAddress.toLowerCase();
    console.log(`Received incoming email bound for: ${toAddress}`);

    // Determine Property Tag
    let propertyTag = 'General Property';
    if (lowerTo.includes('+property1')) {
        propertyTag = 'Property 1 (Masteko)';
    } else if (lowerTo.includes('+property2')) {
        propertyTag = 'Property 2 (St-Agathe)';
    }

    // Extract tenant email & name
    const fromRaw = emailData.from || '';
    const emailMatch = fromRaw.match(/<([^>]+)>/);
    const tenantEmail = emailMatch ? emailMatch[1].trim() : fromRaw.trim();
    const tenantName = emailMatch ? fromRaw.split('<')[0].replace(/"/g, '').trim() : tenantEmail;

    // 2. Read the address and route it to the correct PMS backend!
    try {
        if (lowerTo.includes('+property1')) {
            console.log("Routing to Property 1 Backend...");
            await axios.post('https://saif-property-client-railway-production.up.railway.app/api/webhooks/email/incoming', emailData, {
                headers: { 'Authorization': `Bearer ${process.env.INTERNAL_SECRET_KEY}` }
            });
        } 
        else if (lowerTo.includes('+property2')) {
            console.log("Routing to Property 2 Backend...");
            await axios.post('https://saif-property2-client-railway-production.up.railway.app/api/webhooks/email/incoming', emailData, {
                headers: { 'Authorization': `Bearer ${process.env.INTERNAL_SECRET_KEY}` }
            });
        }
        else {
            console.log("No routing tag found, ignoring or sending to default backend.");
        }
    } catch (error) {
        console.error("Failed to forward email to PMS backend:", error.message);
    }

    // 3. Forward exact copy to Outlook (Non-blocking & isolated)
    try {
        await forwardCopyToOutlook(emailData, req.files, propertyTag, tenantEmail, tenantName);
    } catch (outlookErr) {
        console.error("Failed to forward copy to Outlook:", outlookErr.response?.data || outlookErr.message);
    }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Central Email Service (INCOMING ONLY) is running on port ${PORT}`);
});
