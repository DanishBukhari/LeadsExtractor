// server.js
require('dotenv').config();

import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import GoogleMapsPuppeteerScraper from './scraper.js';
import csv from 'csv-parser';
import nodemailer from 'nodemailer';
import { createReadStream } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 5000;

// Create output directory
const OUTPUT_DIR = path.join(__dirname, 'output');
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR);
}

// Sleep utility
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Scraping endpoint
app.post('/scrape', async (req, res) => {
  const { niche, region, maxResults = 10, headless = true, enableSocial = false } = req.body;

  if (!niche || !region) {
    return res.status(400).json({ error: 'Missing niche or region parameter' });
  }

  try {
    const scraper = new GoogleMapsPuppeteerScraper(headless, enableSocial);
    await scraper.init();

    console.log(`Starting scrape for: ${niche} in ${region}`);
    const results = await scraper.searchBusinesses(niche, region, maxResults);
    await scraper.close();

    if (results.length === 0) {
      return res.status(404).json({ message: 'No results found' });
    }

    // Save to CSV
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);
    const csvFilename = `leads_${timestamp}.csv`;
    const csvFilePath = path.join(OUTPUT_DIR, csvFilename);
    await scraper.exportToCsv(results, csvFilePath);

    // Save to XLSX
    const xlsxFilename = `leads_${timestamp}.xlsx`;
    const xlsxFilePath = path.join(OUTPUT_DIR, xlsxFilename);
    await scraper.exportToXlsx(results, xlsxFilePath);

    res.json({
      message: `Scraped ${results.length} businesses`,
      downloadCsvUrl: `/download/${csvFilename}`,
      downloadXlsxUrl: `/download/${xlsxFilename}`,
      filenameCsv: csvFilename,
      filenameXlsx: xlsxFilename,
      data: results,
    });
  } catch (error) {
    console.error('Scraping error:', error);
    res.status(500).json({ error: 'Scraping failed', details: error.message });
  }
});

// Email sending endpoint (modified to handle leads array or filename)
app.post('/send-emails', async (req, res) => {
  const { filename, leads, subject, body } = req.body;

  if (!subject || !body) {
    return res.status(400).json({ error: 'Missing subject or body' });
  }

  let validLeads = [];

  if (filename) {
    const filePath = path.join(OUTPUT_DIR, filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'CSV file not found' });
    }

    const fileLeads = [];
    await new Promise((resolve, reject) => {
      createReadStream(filePath)
        .pipe(csv())
        .on('data', (row) => fileLeads.push(row))
        .on('end', resolve)
        .on('error', reject);
    });

    validLeads = fileLeads
      .map((lead) => {
        const rawEmail = lead.EMAIL || lead.email || '';
        const email = rawEmail.trim().toLowerCase();
        if (
          email &&
          !['not found', 'no website', 'error'].includes(email) &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        ) {
          return { ...lead, _email: email };
        }
        return null;
      })
      .filter(Boolean);
  } else if (leads && Array.isArray(leads)) {
    validLeads = leads
      .map((lead) => {
        const rawEmail = lead.email || '';
        const email = rawEmail.trim().toLowerCase();
        if (
          email &&
          !['not found', 'no website', 'error'].includes(email) &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        ) {
          return { ...lead, _email: email };
        }
        return null;
      })
      .filter(Boolean);
  } else {
    return res.status(400).json({ error: 'Missing filename or leads data' });
  }

  if (validLeads.length === 0) {
    return res.json({ successCount: 0, failCount: 0, message: 'No valid emails found' });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.zoho.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.user,
        pass: process.env.pass
      },
      tls: {
        rejectUnauthorized: false,
      },
    });

    await transporter.verify();

    let successCount = 0;
    let failCount = 0;
    const failedEmails = [];

    for (const lead of validLeads) {
      const toEmail = lead._email;

      const personalizedBody = body
        .replace(/{{\s*businessName\s*}}/gi, lead.BUSINESS_NAME || lead.name || '')
        .replace(/{{\s*city\s*}}/gi, lead.CITY || lead.city || '')
        .replace(/{{\s*address\s*}}/gi, lead.ADDRESS || lead.address || '');

      const personalizedSubject = subject
        .replace(/{{\s*businessName\s*}}/gi, lead.BUSINESS_NAME || lead.name || '')
        .replace(/{{\s*city\s*}}/gi, lead.CITY || lead.city || '');

      const mailOptions = {
        from: process.env.user,
        to: toEmail,
        subject: personalizedSubject,
        html: personalizedBody,
        text: personalizedBody.replace(/<[^>]+>/g, ''),
      };

      try {
        await transporter.sendMail(mailOptions);
        successCount++;
      } catch (err) {
        failCount++;
        failedEmails.push(toEmail);
      }

      await sleep(2000 + Math.random() * 3000);
    }

    res.json({ successCount, failCount, failedEmails });
  } catch (error) {
    console.error('Email sending error:', error);
    res.status(500).json({ error: 'Email sending failed', details: error.message });
  }
});

// File download endpoint
app.get('/download/:filename', (req, res) => {
  const filePath = path.join(OUTPUT_DIR, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.download(filePath, (err) => {
      if (err) console.error('Download error:', err);
    });
  } else {
    res.status(404).send('File not found');
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});