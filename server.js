import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import GoogleMapsPuppeteerScraper from "./scraper.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 5000;

// Create output directory
const OUTPUT_DIR = path.join(__dirname, "output");
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR);
}

// Scraping endpoint
app.post("/scrape", async (req, res) => {
  console.log("hi body", req.body);

  const { niche, region, maxResults = 10, headless = true } = req.body;

  if (!niche || !region) {
    return res.status(400).json({ error: "Missing niche or region parameter" });
  }

  try {
    const scraper = new GoogleMapsPuppeteerScraper(headless);
    await scraper.init();

    console.log(`Starting scrape for: ${niche} in ${region}`);
    const results = await scraper.searchBusinesses(niche, region, maxResults);
    await scraper.close();

    if (results.length === 0) {
      return res.status(404).json({ message: "No results found" });
    }

    // Save to CSV
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const filename = `leads_${timestamp}.csv`;
    const filePath = path.join(OUTPUT_DIR, filename);

    await scraper.exportToCsv(results, filePath);

    res.json({
      message: `Scraped ${results.length} businesses`,
      downloadUrl: `/download/${filename}`,
      data: results, // Optional: include data in response
    });
  } catch (error) {
    console.error("Scraping error:", error);
    res.status(500).json({ error: "Scraping failed", details: error.message });
  }
});

// File download endpoint
app.get("/download/:filename", (req, res) => {
  const filePath = path.join(OUTPUT_DIR, req.params.filename);
  if (fs.existsSync(filePath)) {
    res.download(filePath, (err) => {
      if (err) console.error("Download error:", err);
    });
  } else {
    res.status(404).send("File not found");
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
