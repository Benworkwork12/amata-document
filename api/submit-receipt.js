const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const { Readable } = require('stream');
const Busboy = require('busboy');

// Parse multipart form data (Vercel doesn't do this automatically)
function parseForm(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    let fileData = null;

    const busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
    });

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    busboy.on('file', (name, stream, info) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        fileData = {
          buffer: Buffer.concat(chunks),
          filename: info.filename,
          mimeType: info.mimeType,
        };
      });
    });

    busboy.on('finish', () => resolve({ fields, file: fileData }));
    busboy.on('error', reject);

    req.pipe(busboy);
  });
}

// Initialize Google Drive
function getGoogleDrive() {
  const decoded = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf-8');
  const credentials = JSON.parse(decoded);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

  return google.drive({ version: 'v3', auth });
}

// Initialize email
function getEmailTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_EMAIL,
      pass: process.env.SMTP_PASSWORD,
    },
  });
}

// ============================================
// MAIN HANDLER
// ============================================
module.exports = async function handler(req, res) {
  // Handle CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Parse form data
    const { fields, file } = await parseForm(req);
    const { fullName, email, company, amount, date, category, purpose } = fields;

    // Validate
    if (!fullName || !email || !company || !amount || !date || !category || !purpose || !file) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // ========== Upload to Google Drive ==========
    const drive = getGoogleDrive();

    const safeCompany = company.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const safeCategory = category.replace(/\s+/g, '-');
    const fileName = `${date}_${safeCompany}_${safeCategory}_${file.filename}`;

    const driveResponse = await drive.files.create({
      resource: {
        name: fileName,
        parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
      },
      media: {
        mimeType: file.mimeType,
        body: Readable.from([file.buffer]),
      },
      fields: 'id, webViewLink',
    });

    const driveLink = driveResponse.data.webViewLink;

    // Make viewable by link
    await drive.permissions.create({
      fileId: driveResponse.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    // ========== Send emails ==========
    const transporter = getEmailTransporter();
    const formattedAmount = `$${parseFloat(amount).toFixed(2)}`;

    // Email to client
    await transporter.sendMail({
      from: `"Amata Document" <${process.env.SMTP_EMAIL}>`,
      to: email,
      subject: `Receipt confirmed: ${formattedAmount} — ${category}`,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 500px;">
          <h2 style="color: #1a1a1a;">Receipt received</h2>
          <p>Hi ${fullName},</p>
          <p>We've received your business expense receipt. Here's what we recorded:</p>
          <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
            <tr style="background: #f9fafb;">
              <td style="padding: 10px; border: 1px solid #e5e7eb; font-weight: 600;">Amount</td>
              <td style="padding: 10px; border: 1px solid #e5e7eb;">${formattedAmount}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #e5e7eb; font-weight: 600;">Date</td>
              <td style="padding: 10px; border: 1px solid #e5e7eb;">${date}</td>
            </tr>
            <tr style="background: #f9fafb;">
              <td style="padding: 10px; border: 1px solid #e5e7eb; font-weight: 600;">Category</td>
              <td style="padding: 10px; border: 1px solid #e5e7eb;">${category}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #e5e7eb; font-weight: 600;">Purpose</td>
              <td style="padding: 10px; border: 1px solid #e5e7eb;">${purpose}</td>
            </tr>
          </table>
          <p style="color: #666; font-size: 14px;">Our team will review this shortly. We'll follow up if we need anything.</p>
          <p style="color: #999; font-size: 12px; margin-top: 24px;">— Amata Document</p>
        </div>
      `,
    });

    // Email to practice
    await transporter.sendMail({
      from: `"Amata Document" <${process.env.SMTP_EMAIL}>`,
      to: process.env.PRACTICE_EMAIL,
      subject: `[Receipt] ${formattedAmount} from ${fullName} (${company})`,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 500px;">
          <h2 style="color: #1a1a1a;">New receipt submission</h2>
          <p><strong>Client:</strong> ${fullName}</p>
          <p><strong>Company:</strong> ${company}</p>
          <p><strong>Email:</strong> ${email}</p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 16px 0;">
          <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
            <tr style="background: #f9fafb;">
              <td style="padding: 10px; border: 1px solid #e5e7eb; font-weight: 600;">Amount</td>
              <td style="padding: 10px; border: 1px solid #e5e7eb;">${formattedAmount}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #e5e7eb; font-weight: 600;">Date</td>
              <td style="padding: 10px; border: 1px solid #e5e7eb;">${date}</td>
            </tr>
            <tr style="background: #f9fafb;">
              <td style="padding: 10px; border: 1px solid #e5e7eb; font-weight: 600;">Category</td>
              <td style="padding: 10px; border: 1px solid #e5e7eb;">${category}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #e5e7eb; font-weight: 600;">Purpose</td>
              <td style="padding: 10px; border: 1px solid #e5e7eb;">${purpose}</td>
            </tr>
          </table>
          <p style="margin-top: 16px;">
            <a href="${driveLink}" style="display: inline-block; padding: 12px 20px; background: #1a56db; color: white; text-decoration: none; border-radius: 6px; font-weight: 600;">View receipt in Google Drive</a>
          </p>
        </div>
      `,
    });

    return res.status(200).json({ success: true, message: 'Receipt submitted' });

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Submission failed. Please try again.' });
  }
};

// Tell Vercel not to parse the body (we handle it with Busboy)
module.exports.config = {
  api: { bodyParser: false },
};
