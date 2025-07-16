// sendEmailsFromCsv.js
import fs from "fs";
import readline from "readline";
import nodemailer from "nodemailer";
import csv from "csv-parser";
import { createReadStream } from "fs";

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Helper to ask input
const ask = (question) =>
  new Promise((resolve) => rl.question(question, resolve));

// Sleep utility
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Main
async function sendEmailsFromCsv() {
  try {
    console.log("=== CSV Email Sender ===");
    console.log("========================");

    const csvPath = await ask("Enter path to CSV file: ");

    const leads = [];
    await new Promise((resolve, reject) => {
      createReadStream(csvPath)
        .pipe(csv())
        .on("data", (row) => leads.push(row))
        .on("end", resolve)
        .on("error", reject);
    });

    if (leads.length === 0) {
      console.log("No leads found in CSV");
      return;
    }

    console.log(`Found ${leads.length} leads in CSV`);

    // Email config
    console.log("\n=== Email Configuration ===");
    const emailConfig = {
      smtp: {
        host: await ask("SMTP Host: "),
        port: parseInt(await ask("SMTP Port: ")),
        secure: (await ask("Use SSL/TLS? (y/n): ")).toLowerCase() === "y",
        user: await ask("SMTP Username: "),
        password: await ask("SMTP Password: "),
      },
      from: await ask("From Email: "),
      subject: await ask("Email Subject: "),
      body: await ask(
        "Email Body (HTML supported, use {{name}}, {{business}}, {{city}}):\n",
      ),
    };

    // Normalize emails
    const validLeads = leads
      .map((lead) => {
        const rawEmail =
          lead.email || lead.EMAIL || lead.Email || lead.eMail || "";
        const email = rawEmail.trim().toLowerCase();
        if (
          email &&
          !["not found", "no website", "error"].includes(email) &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        ) {
          return { ...lead, _email: email };
        }
        return null;
      })
      .filter(Boolean);

    if (validLeads.length === 0) {
      console.log("No valid email addresses found");
      return;
    }

    // Setup transporter
    const transporter = nodemailer.createTransport({
      host: emailConfig.smtp.host,
      port: emailConfig.smtp.port,
      secure: emailConfig.smtp.secure,
      auth: {
        user: emailConfig.smtp.user,
        pass: emailConfig.smtp.password,
      },
      tls: {
        rejectUnauthorized: false,
      },
    });

    try {
      await transporter.verify();
      console.log("✅ SMTP verified: ready to send");
    } catch (err) {
      console.error("❌ SMTP verification failed:", err.message);
      process.exit(1);
    }

    let successCount = 0;
    let failCount = 0;
    const failedEmails = [];

    // Send emails
    for (const [index, lead] of validLeads.entries()) {
      const toEmail = lead._email;

      const personalizedBody = emailConfig.body
        .replace(/{{\s*name\s*}}/gi, lead.BUSINESS_NAME || "")
        .replace(/{{\s*business\s*}}/gi, lead.BUSINESS_NAME || "")
        .replace(/{{\s*city\s*}}/gi, lead.CITY || "")
        .replace(/{{\s*address\s*}}/gi, lead.ADDRESS || "");

      const personalizedSubject = emailConfig.subject
        .replace(/{{\s*name\s*}}/gi, lead.BUSINESS_NAME || "")
        .replace(/{{\s*business\s*}}/gi, lead.BUSINESS_NAME || "")
        .replace(/{{\s*city\s*}}/gi, lead.CITY || "");

      const mailOptions = {
        from: emailConfig.from,
        to: toEmail,
        subject: personalizedSubject,
        html: personalizedBody,
        text: personalizedBody.replace(/<[^>]+>/g, ""),
      };

      try {
        await transporter.sendMail(mailOptions);
        console.log(`✓ Sent to ${toEmail} (${index + 1}/${validLeads.length})`);
        successCount++;
      } catch (err) {
        console.error(`✗ Failed to send to ${toEmail}: ${err.message}`);
        failCount++;
        failedEmails.push(toEmail);
      }

      await sleep(2000 + Math.random() * 3000); // delay
    }

    if (failedEmails.length > 0) {
      const failedFile = `failed_emails_${Date.now()}.txt`;
      fs.writeFileSync(failedFile, failedEmails.join("\n"));
      console.log(
        `Saved ${failedEmails.length} failed emails to ${failedFile}`,
      );
    }

    console.log("\n=== Email Report ===");
    console.log(`✓ Successfully sent: ${successCount}`);
    console.log(`✗ Failed to send: ${failCount}`);
  } catch (error) {
    console.error("Unexpected Error:", error.message);
  } finally {
    rl.close();
  }
}

sendEmailsFromCsv();
