import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";
import readline from "readline";
import XLSX from "xlsx";
import nodemailer from "nodemailer";
import { createObjectCsvWriter } from "csv-writer";

puppeteer.use(StealthPlugin());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class GoogleMapsPuppeteerScraper {
  constructor(headless = false) {
    this.headless = headless;
    this.maxRetries = 3;
  }

  async init() {
    try {
      const executablePath = this.getDefaultChromePath();

      const launchOptions = {
        headless: this.headless,
        executablePath,
        args: [
          "--window-size=1920,1080",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
          "--disable-web-security",
          "--disable-features=VizDisplayCompositor",
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--disable-default-apps",
        ],
        timeout: 60000,
        ignoreDefaultArgs: ["--enable-automation"],
      };

      this.browser = await puppeteer.launch(launchOptions);
      this.page = await this.browser.newPage();

      await this.page.setViewport({ width: 1920, height: 1080 });
      await this.page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      );

      await this.page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", {
          get: () => undefined,
        });
      });

      await this.page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
      });

      console.log("Browser launched successfully.");
    } catch (err) {
      console.error("Init error:", err);
      throw err;
    }
  }

  getDefaultChromePath() {
    const platform = process.platform;
    switch (platform) {
      case "win32":
        return "C:/Program Files/Google/Chrome/Application/chrome.exe";
      case "darwin":
        return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      case "linux":
        return "/usr/bin/google-chrome";
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  }

  // Clean text to remove non-English characters and icons
  cleanText(text) {
    if (!text) return "";

    // Remove icons and special characters
    let cleaned = text
      .replace(/[^\x00-\x7F]/g, " ") // Remove non-ASCII
      .replace(/\s+/g, " ") // Collapse multiple spaces
      .trim();

    // Convert Bangla digits to English
    const digitMap = {
      "০": "0",
      "১": "1",
      "২": "2",
      "৩": "3",
      "৪": "4",
      "৫": "5",
      "৬": "6",
      "৭": "7",
      "৮": "8",
      "৯": "9",
    };

    return cleaned
      .split("")
      .map((char) => digitMap[char] || char)
      .join("");
  }

  async _scrollResults() {
    console.log("Loading all results...");
    await this.page.waitForSelector('div[role="feed"]', { timeout: 30000 });

    let previousCount = 0;
    let currentCount = 0;
    let scrollAttempts = 0;
    const maxScrollAttempts = 20;

    do {
      previousCount = currentCount;

      await this.page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]') || window;
        feed.scrollTop = feed.scrollHeight || window.scrollBy(0, 1000);
      });

      await sleep(2000 + Math.random() * 1000);

      // Try to click "Load more" if available
      try {
        const loadMoreBtn = await this.page.$(
          'button[aria-label*="more"], button:contains("Show more")',
        );
        if (loadMoreBtn) {
          await loadMoreBtn.click();
          await sleep(2000);
        }
      } catch (err) {
        // Ignore if not found
      }

      // Count current business links
      const links = await this.page.$$eval(
        "a[href*='/maps/place/']",
        (els) => els.length,
      );
      currentCount = links;
      console.log(`Loaded ${currentCount} businesses...`);

      scrollAttempts++;
      if (scrollAttempts > maxScrollAttempts) {
        console.log("Max scroll attempts reached. Stopping.");
        break;
      }
    } while (currentCount > previousCount);

    console.log("All results loaded.");
  }

  async _extractBusinessDetails(link) {
    let detailPage;
    const details = {
      name: "",
      phone: "",
      email: "",
      city: "",
      address: "",
      reviews: "",
      website: "",
    };

    let retryCount = 0;

    while (retryCount < this.maxRetries) {
      try {
        detailPage = await this.browser.newPage();
        await detailPage.goto(link, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await sleep(3000 + Math.random() * 2000);

        // Extract business name
        const nameSelectors = ["h1[data-attrid='title']", "h1.DUwDvf", "h1"];
        for (const selector of nameSelectors) {
          const nameEl = await detailPage.$(selector);
          if (nameEl) {
            let nameText = await detailPage.evaluate(
              (el) => el.innerText,
              nameEl,
            );
            details.name = this.cleanText(nameText);
            break;
          }
        }

        // Extract phone
        const phoneSelectors = [
          "button[data-item-id^='phone']",
          "a[href^='tel:']",
        ];
        for (const sel of phoneSelectors) {
          const phoneEl = await detailPage.$(sel);
          if (phoneEl) {
            let phoneText = await detailPage.evaluate(
              (el) => el.innerText || el.getAttribute("href"),
              phoneEl,
            );
            if (phoneText) {
              details.phone = this.cleanText(phoneText.replace("tel:", ""));
              break;
            }
          }
        }

        // Extract website
        const websiteSelectors = [
          "a[data-item-id^='authority']",
          "a[href^='http']:not([href*='google'])",
        ];
        for (const sel of websiteSelectors) {
          const siteEl = await detailPage.$(sel);
          if (siteEl) {
            details.website = await detailPage.evaluate(
              (el) => el.getAttribute("href"),
              siteEl,
            );
            break;
          }
        }

        // Extract address
        const addressSelectors = [
          "button[data-item-id^='address']",
          ".x3AX1-LfntMc-header-title-address",
        ];
        for (const sel of addressSelectors) {
          const addrEl = await detailPage.$(sel);
          if (addrEl) {
            let addressText = await detailPage.evaluate(
              (el) => el.innerText,
              addrEl,
            );
            details.address = this.cleanText(addressText);

            // Extract city from address
            const parts = details.address.split(",");
            if (parts.length > 1) {
              // US format: [street], [city], [state zip], [country]
              details.city =
                parts.length > 2 ? this.cleanText(parts[parts.length - 3]) : "";
            }
            break;
          }
        }

        // Extract reviews
        const reviewSelectors = [
          "div[aria-label*='reviews']",
          "div[data-value*='reviews']",
          "button[jsaction*='reviews']",
        ];
        for (const sel of reviewSelectors) {
          const reviewEl = await detailPage.$(sel);
          if (reviewEl) {
            let reviewText = await detailPage.evaluate(
              (el) => el.innerText,
              reviewEl,
            );
            details.reviews = this.cleanText(reviewText);
            break;
          }
        }

        // Extract email
        if (details.website && !details.website.includes("google.com")) {
          try {
            console.log(`Scraping website for email: ${details.website}`);
            const emailPage = await this.browser.newPage();
            await emailPage.goto(details.website, {
              waitUntil: "domcontentloaded",
              timeout: 15000,
            });
            await sleep(3000);

            const pageContent = await emailPage.content();
            const emailRegex =
              /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
            const emails = pageContent.match(emailRegex) || [];

            // Filter out non-business emails
            const businessEmails = emails.filter(
              (email) =>
                !email.endsWith("@gmail.com") &&
                !email.endsWith("@yahoo.com") &&
                !email.endsWith("@hotmail.com") &&
                !email.includes("noreply") &&
                !email.includes("no-reply"),
            );

            if (businessEmails.length > 0) {
              details.email = businessEmails[0];
            } else {
              details.email = "Not found";
            }
            await emailPage.close();
          } catch (err) {
            details.email = "Error";
          }
        } else if (!details.email) {
          details.email = details.website ? "No website" : "Not found";
        }

        return details;
      } catch (error) {
        retryCount++;
        console.error(
          `Detail page error (attempt ${retryCount}):`,
          error.message,
        );
        if (retryCount >= this.maxRetries) {
          console.error("Max retries reached for this business");
        }
        await sleep(2000 * retryCount);
      } finally {
        if (detailPage) await detailPage.close();
      }
    }

    return details;
  }

  async searchBusinesses(query, region, maxResults = 0) {
    const results = [];
    try {
      const searchTerm = `${query} ${region}`;
      const url = `https://www.google.com/maps/search/${encodeURIComponent(
        searchTerm,
      )}/`;

      console.log(`Searching for: ${searchTerm}`);
      console.log(`URL: ${url}`);

      await this.page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await sleep(5000 + Math.random() * 2000);

      await this._scrollResults();

      // Get all business links
      const links = await this.page.$$eval('a[href*="/maps/place/"]', (els) =>
        els
          .map((el) => el.href)
          .filter(
            (href) =>
              !href.includes("contributor") && !href.includes("preview"),
          ),
      );

      const uniqueLinks = [...new Set(links)];
      console.log(`Found ${uniqueLinks.length} businesses`);

      if (uniqueLinks.length === 0) {
        console.error("No business links found.");
        return results;
      }

      console.log(
        `Processing ${
          maxResults > 0
            ? Math.min(maxResults, uniqueLinks.length)
            : uniqueLinks.length
        } businesses...`,
      );

      for (let i = 0; i < uniqueLinks.length; i++) {
        if (maxResults > 0 && results.length >= maxResults) break;

        console.log(`Processing business ${i + 1}/${uniqueLinks.length}`);
        const data = await this._extractBusinessDetails(uniqueLinks[i]);

        if (data && data.name) {
          results.push(data);
          console.log(
            `✓ Collected: ${data.name || "No Name"} (${results.length})`,
          );
        } else {
          console.log(`✗ Failed to extract data from business ${i + 1}`);
        }

        // Random delay between requests
        await sleep(1500 + Math.random() * 2000);
      }
    } catch (err) {
      console.error("Search error:", err);
    }
    return results;
  }

  exportToCsv(businesses, filename = "results.csv") {
    if (!businesses || businesses.length === 0) {
      console.log("No data to export to CSV.");
      return false;
    }

    try {
      const csvWriter = createObjectCsvWriter({
        path: filename,
        header: [
          { id: "name", title: "BUSINESS_NAME" },
          { id: "phone", title: "PHONE" },
          { id: "email", title: "EMAIL" },
          { id: "city", title: "CITY" },
          { id: "address", title: "ADDRESS" },
          { id: "reviews", title: "REVIEWS" },
          { id: "website", title: "WEBSITE" },
        ],
      });

      csvWriter
        .writeRecords(businesses)
        .then(() =>
          console.log(
            `✓ CSV saved to "${filename}" with ${businesses.length} entries`,
          ),
        );

      return true;
    } catch (err) {
      console.error("CSV export error:", err);
      return false;
    }
  }

  exportToXlsx(businesses, filename = "results.xlsx") {
    if (!businesses || businesses.length === 0) {
      console.log("No data to export to Excel.");
      return false;
    }

    try {
      const worksheet = XLSX.utils.json_to_sheet(businesses);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Leads");
      XLSX.writeFile(workbook, filename);
      console.log(
        `✓ Excel saved to "${filename}" with ${businesses.length} entries`,
      );
      return true;
    } catch (err) {
      console.error("Excel export error:", err);
      return false;
    }
  }

  // async sendBulkEmails(leads, emailConfig) {
  //   if (!leads || leads.length === 0) {
  //     console.log("No leads to email.");
  //     return { successCount: 0, failCount: 0 };
  //   }

  //   // Validate email config
  //   if (
  //     !emailConfig ||
  //     !emailConfig.smtp ||
  //     !emailConfig.from ||
  //     !emailConfig.subject ||
  //     !emailConfig.body
  //   ) {
  //     throw new Error("Invalid email configuration");
  //   }

  //   // Filter valid emails
  //   const validLeads = leads.filter(
  //     (lead) =>
  //       lead.email &&
  //       !["Not found", "No website", "Error"].includes(lead.email) &&
  //       /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email),
  //   );

  //   if (validLeads.length === 0) {
  //     console.log("No valid email addresses found.");
  //     return { successCount: 0, failCount: 0 };
  //   }

  //   console.log(`Preparing to send emails to ${validLeads.length} leads...`);

  //   const transporter = nodemailer.createTransport({
  //     host: emailConfig.smtp.host,
  //     port: emailConfig.smtp.port,
  //     secure: emailConfig.smtp.secure,
  //     auth: {
  //       user: emailConfig.smtp.user,
  //       pass: emailConfig.smtp.password,
  //     },
  //   });

  //   let successCount = 0;
  //   let failCount = 0;
  //   const failedEmails = [];

  //   for (const [index, lead] of validLeads.entries()) {
  //     try {
  //       // Personalize email content
  //       const personalizedBody = emailConfig.body
  //         .replace(/{{\s*name\s*}}/gi, lead.name || "")
  //         .replace(/{{\s*business\s*}}/gi, lead.name || "")
  //         .replace(/{{\s*city\s*}}/gi, lead.city || "")
  //         .replace(/{{\s*address\s*}}/gi, lead.address || "");

  //       const personalizedSubject = emailConfig.subject
  //         .replace(/{{\s*name\s*}}/gi, lead.name || "")
  //         .replace(/{{\s*business\s*}}/gi, lead.name || "")
  //         .replace(/{{\s*city\s*}}/gi, lead.city || "");

  //       const mailOptions = {
  //         from: emailConfig.from,
  //         to: lead.email,
  //         subject: personalizedSubject,
  //         html: personalizedBody,
  //         text: personalizedBody.replace(/<[^>]+>/g, ""), // Plain text version
  //       };

  //       // Send email
  //       await transporter.sendMail(mailOptions);
  //       console.log(
  //         `✓ Email sent to ${lead.email} (${index + 1}/${validLeads.length})`,
  //       );
  //       successCount++;

  //       // Random delay to avoid being flagged as spam
  //       await sleep(2000 + Math.random() * 3000);
  //     } catch (err) {
  //       console.error(`✗ Failed to send to ${lead.email}: ${err.message}`);
  //       failCount++;
  //       failedEmails.push(lead.email);
  //     }
  //   }

  //   // Save failed emails for reference
  //   if (failedEmails.length > 0) {
  //     const failedFile = `failed_emails_${Date.now()}.txt`;
  //     fs.writeFileSync(failedFile, failedEmails.join("\n"));
  //     console.log(
  //       `Saved ${failedEmails.length} failed emails to ${failedFile}`,
  //     );
  //   }

  //   return { successCount, failCount };
  // }

  async close() {
    if (this.browser) {
      await this.browser.close();
      console.log("Browser closed.");
    }
  }
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (question) =>
    new Promise((resolve) => rl.question(question, resolve));

  try {
    console.log("=== Google Maps Lead Extractor & Email Automation ===");
    console.log("=====================================================");

    // Get headless preference
    const isHeadless =
      (await ask("Run in headless mode? (y/n): ")).toLowerCase() === "y";

    // Get scraping parameters
    console.log("\n=== Business Search Parameters ===");
    const niche = await ask("Business niche/category to search for: ");
    const region = await ask("Region (city, state, country): ");
    const maxResults =
      parseInt(await ask("Number of leads to collect (0 for all): ")) || 0;

    // Create output directory
    const outputDir = "Leads_Output";
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    }

    // Run scraper
    console.log("\n=== Starting Lead Extraction ===");
    const scraper = new GoogleMapsPuppeteerScraper(isHeadless);
    await scraper.init();
    const results = await scraper.searchBusinesses(niche, region, maxResults);

    if (results.length > 0) {
      // Save results
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      const csvFile = `${outputDir}/leads_${timestamp}.csv`;
      const xlsxFile = `${outputDir}/leads_${timestamp}.xlsx`;

      scraper.exportToCsv(results, csvFile);
      scraper.exportToXlsx(results, xlsxFile);

      console.log(`\n✓ ${results.length} leads collected`);
      console.log(`Files saved: ${csvFile}\n        ${xlsxFile}`);

      // Count valid emails
      const validEmails = results.filter(
        (lead) =>
          lead.email &&
          !["Not found", "No website", "Error"].includes(lead.email),
      ).length;

      console.log(`\nEmails found: ${validEmails}/${results.length}`);

      // Email automation
      // if (validEmails > 0) {
      //   const sendEmails =
      //     (
      //       await ask("\nSend emails to collected leads? (y/n): ")
      //     ).toLowerCase() === "y";
      //   if (sendEmails) {
      //     console.log("\n=== Email Configuration ===");

      //     const emailConfig = {
      //       smtp: {
      //         host: await ask("SMTP Host: "),
      //         port: parseInt(await ask("SMTP Port: ")),
      //         secure: (await ask("Use SSL/TLS? (y/n): ")).toLowerCase() === "y",
      //         user: await ask("SMTP Username: "),
      //         password: await ask("SMTP Password: "),
      //       },
      //       from: await ask("From Email: "),
      //       subject: await ask("Email Subject: "),
      //       body: await ask(
      //         "Email Body (HTML supported, use {{name}}, {{business}}, {{city}} for personalization):\n",
      //       ),
      //     };

      //     // console.log("\n=== Sending Emails ===");
      //     // // const { successCount, failCount } = await scraper.sendBulkEmails(
      //     // //   results,
      //     // //   emailConfig,
      //     // // );

      //     // console.log("\n=== Email Report ===");
      //     // console.log(`✓ Successfully sent: ${successCount}`);
      //     // console.log(`✗ Failed to send: ${failCount}`);

      //     // if (successCount > 0) {
      //     //   console.log("\nTips for better deliverability:");
      //     //   console.log("- Check your spam folder for test emails");
      //     //   console.log(
      //     //     "- Warm up your email account by sending small batches first",
      //     //   );
      //     //   console.log("- Use a professional email domain (not @gmail.com)");
      //     //   console.log("- Include unsubscribe link in your emails");
      //     // }
      //   }
      // } else {
      //   console.log("No valid emails found to send messages.");
      // }
    } else {
      console.log("\nNo leads found. Possible reasons:");
      console.log("- Google Maps structure changed");
      console.log("- Anti-bot measures triggered");
      console.log("- Invalid search parameters");
    }

    await scraper.close();
  } catch (error) {
    console.error("Fatal error:", error);
  } finally {
    rl.close();
    process.exit(0);
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\nReceived SIGINT. Graceful shutdown...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\nReceived SIGTERM. Graceful shutdown...");
  process.exit(0);
});

main().catch(console.error);

export default GoogleMapsPuppeteerScraper;
