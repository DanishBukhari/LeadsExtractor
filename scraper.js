// scraper.js
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import XLSX from 'xlsx';
import { createObjectCsvWriter } from 'csv-writer';

puppeteer.use(StealthPlugin());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const njCities = [
  'Newark', 'Jersey City', 'Paterson', 'Lakewood', 'Elizabeth', 'Edison', 'Woodbridge', 'Toms River', 'Hamilton township', 'Trenton',
  'Clifton', 'Cherry Hill', 'Brick', 'Camden', 'Bayonne', 'East Orange', 'Passaic', 'Franklin township', 'Old Bridge', 'Middletown',
  'Gloucester', 'Union City', 'Piscataway', 'Vineland', 'Union township', 'Jackson', 'Irvington', 'North Bergen', 'Hoboken', 'Parsippany-Troy Hills',
  'New Brunswick', 'Perth Amboy', 'Plainfield', 'Howell', 'Bloomfield', 'Wayne', 'West New York', 'East Brunswick', 'Washington township', 'Monroe township',
  'Evesham', 'West Orange', 'Egg Harbor', 'South Brunswick', 'Mount Laurel', 'Manchester', 'Bridgewater', 'Hackensack', 'Sayreville', 'Berkeley'
]; // Top 50 cities in NJ by population

class GoogleMapsPuppeteerScraper {
  constructor(headless = false, enableSocial = false) {
    this.headless = headless;
    this.enableSocial = enableSocial;
    this.maxRetries = 3;
  }

  async init() {
    try {
      const executablePath = this.getDefaultChromePath();

      const launchOptions = {
        headless: this.headless,
        executablePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-web-security',
          '--disable-features=VizDisplayCompositor',
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--disable-default-apps',
        ],
        timeout: 60000,
        ignoreDefaultArgs: ['--enable-automation'],
      };

      this.browser = await puppeteer.launch(launchOptions);
      this.page = await this.browser.newPage();

      await this.page.setViewport({ width: 1920, height: 1080 });
      await this.page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      );

      await this.page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        });
      });

      await this.page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      });

      console.log('Browser launched successfully.');
    } catch (err) {
      console.error('Init error:', err);
      throw err;
    }
  }

  getDefaultChromePath() {
    const platform = process.platform;
    switch (platform) {
      case 'win32':
        return 'C:/Program Files/Google/Chrome/Application/chrome.exe';
      case 'darwin':
        return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      case 'linux':
        return '/usr/bin/google-chrome';
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  }

  cleanText(text) {
    if (!text) return '';

    let cleaned = text
      .replace(/[^\x00-\x7F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const digitMap = {
      '০': '0',
      '১': '1',
      '২': '2',
      '৩': '3',
      '৪': '4',
      '৫': '5',
      '৬': '6',
      '৭': '7',
      '৮': '8',
      '৯': '9',
    };

    return cleaned
      .split('')
      .map((char) => digitMap[char] || char)
      .join('');
  }

  async _scrollResults() {
    console.log('Loading all results...');
    await this.page.waitForSelector('div[role="feed"]', { timeout: 30000 });

    let previousCount = 0;
    let currentCount = 0;
    let scrollAttempts = 0;
    const maxScrollAttempts = 200; // Increased to attempt more results

    do {
      previousCount = currentCount;

      await this.page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]') || window;
        feed.scrollTop = feed.scrollHeight;
      });

      await sleep(2000 + Math.random() * 1000);

      try {
        const loadMoreBtn = await this.page.$(
          'button[aria-label*="more"], button:contains("Show more"), span:contains("More results")',
        );
        if (loadMoreBtn) {
          await loadMoreBtn.click();
          await sleep(3000);
        }
      } catch (err) {}

      const links = await this.page.$$eval(
        'a[href*="/maps/place/"]',
        (els) => els.length,
      );
      currentCount = links;
      console.log(`Loaded ${currentCount} businesses...`);

      scrollAttempts++;
      if (scrollAttempts > maxScrollAttempts) {
        console.log('Max scroll attempts reached. Stopping.');
        break;
      }
    } while (currentCount > previousCount);

    console.log('All results loaded.');
  }

  async _extractBusinessDetails(link) {
    let detailPage;
    const details = {
      name: '',
      phone: '',
      email: '',
      city: '',
      address: '',
      rating: '',
      website: '',
    };

    let retryCount = 0;

    while (retryCount < this.maxRetries) {
      try {
        detailPage = await this.browser.newPage();
        await detailPage.goto(link, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        await sleep(3000 + Math.random() * 2000);

        // Extract business name
        const nameSelectors = ['h1[data-attrid="title"]', 'h1.DUwDvf', 'h1'];
        for (const selector of nameSelectors) {
          const nameEl = await detailPage.$(selector);
          if (nameEl) {
            details.name = this.cleanText(await detailPage.evaluate((el) => el.innerText, nameEl));
            break;
          }
        }

        // Extract phone
        const phoneSelectors = [
          'button[data-item-id^="phone"]',
          'a[href^="tel:"]',
        ];
        for (const sel of phoneSelectors) {
          const phoneEl = await detailPage.$(sel);
          if (phoneEl) {
            let phoneText = await detailPage.evaluate(
              (el) => el.innerText || el.getAttribute('href'),
              phoneEl,
            );
            details.phone = this.cleanText(phoneText.replace('tel:', ''));
            break;
          }
        }

        // Extract website
        const websiteSelectors = [
          'a[data-item-id^="authority"]',
          'a[href^="http"]:not([href*="google"])',
        ];
        for (const sel of websiteSelectors) {
          const siteEl = await detailPage.$(sel);
          if (siteEl) {
            details.website = await detailPage.evaluate(
              (el) => el.getAttribute('href'),
              siteEl,
            );
            break;
          }
        }

        // Extract address
        const addressSelectors = [
          'button[data-item-id^="address"]',
          '.x3AX1-LfntMc-header-title-address',
        ];
        for (const sel of addressSelectors) {
          const addrEl = await detailPage.$(sel);
          if (addrEl) {
            let addressText = await detailPage.evaluate(
              (el) => el.innerText,
              addrEl,
            );
            details.address = this.cleanText(addressText);

            const parts = details.address.split(',');
            if (parts.length > 1) {
              details.city = parts.length > 2 ? this.cleanText(parts[parts.length - 3]) : '';
            }
            break;
          }
        }

        // Extract number of reviews
        const reviewSelectors = [
          'button[jsaction="pane.rating.moreReviews"]',
          'span[aria-label*="review"]',
        ];
        for (const sel of reviewSelectors) {
          const reviewEl = await detailPage.$(sel);
          if (reviewEl) {
            let reviewText = await detailPage.evaluate(
              (el) => el.innerText,
              reviewEl,
            );
            reviewText = this.cleanText(reviewText);
            // Extract only the number, e.g., from "123 reviews" or "(123)"
            const match = reviewText.match(/(\d+)/);
            if (match) {
              details.rating = match[1];
              break;
            }
          }
        }

        // Extract email from website
        details.email = 'Not found';
        if (details.website && !details.website.includes('google.com')) {
          try {
            console.log(`Scraping website for email: ${details.website}`);
            const emailPage = await this.browser.newPage();
            await emailPage.goto(details.website, {
              waitUntil: 'domcontentloaded',
              timeout: 15000,
            });
            await sleep(3000);

            const pageContent = await emailPage.content();
            const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
            const emails = pageContent.match(emailRegex) || [];

            const businessEmails = emails.filter(
              (email) =>
                !email.includes('noreply') &&
                !email.includes('no-reply'),
            );

            if (businessEmails.length > 0) {
              details.email = businessEmails[0];
            }
            await emailPage.close();
          } catch (err) {
            details.email = 'Error';
          }
        }

        // Extract email from social media if enabled and no email found
        if (this.enableSocial && (details.email === 'Not found' || details.email === 'Error')) {
          const socialLinks = await detailPage.$$eval(
            'a[data-item-id^="authority"]',
            (els) => els.map((el) => el.href).filter((h) => h.includes('facebook.com') || h.includes('instagram.com') || h.includes('twitter.com')),
          );

          for (let socialUrl of socialLinks) {
            if (details.email !== 'Not found' && details.email !== 'Error') break;
            try {
              console.log(`Scraping social for email: ${socialUrl}`);
              const socialPage = await this.browser.newPage();
              await socialPage.goto(socialUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
              await sleep(4000);

              let pageContent = await socialPage.content();

              // Special handling for Facebook 'about' section
              if (socialUrl.includes('facebook.com')) {
                try {
                  const aboutSelector = 'a[href*="/about"], div[role="tab"][aria-label="About"]';
                  const aboutEl = await socialPage.$(aboutSelector);
                  if (aboutEl) {
                    await aboutEl.click();
                    await sleep(3000);
                    pageContent = await socialPage.content();
                  }
                } catch (err) {}
              }

              const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
              const emails = pageContent.match(emailRegex) || [];

              const businessEmails = emails.filter(
                (email) =>
                  !email.includes('noreply') &&
                  !email.includes('no-reply'),
              );

              if (businessEmails.length > 0) {
                details.email = businessEmails[0];
              }
              await socialPage.close();
            } catch (err) {
              console.error('Social scrape error:', err.message);
            }
            await sleep(3000);
          }
        }

        return details;
      } catch (error) {
        retryCount++;
        console.error(`Detail page error (attempt ${retryCount}):`, error.message);
        if (retryCount >= this.maxRetries) {
          console.error('Max retries reached for this business');
        }
        await sleep(2000 * retryCount);
      } finally {
        if (detailPage) await detailPage.close();
      }
    }

    return details;
  }

  async _performSearch(query, subRegion, maxResultsPerSearch) {
    const searchTerm = `${query} in ${subRegion}`;
    const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}/`;

    console.log(`Searching for: ${searchTerm}`);
    console.log(`URL: ${url}`);

    await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(5000 + Math.random() * 2000);

    await this._scrollResults();

    const links = await this.page.$$eval('a[href*="/maps/place/"]', (els) =>
      els
        .map((el) => el.href)
        .filter((href) => !href.includes('contributor') && !href.includes('preview')),
    );

    const uniqueLinks = [...new Set(links)];
    console.log(`Found ${uniqueLinks.length} businesses in ${subRegion}`);

    const results = [];
    const processCount = maxResultsPerSearch > 0 ? Math.min(maxResultsPerSearch, uniqueLinks.length) : uniqueLinks.length;
    console.log(`Processing ${processCount} businesses in ${subRegion}...`);

    for (let i = 0; i < uniqueLinks.length; i++) {
      if (maxResultsPerSearch > 0 && results.length >= maxResultsPerSearch) break;

      console.log(`Processing business ${i + 1}/${uniqueLinks.length} in ${subRegion}`);
      const data = await this._extractBusinessDetails(uniqueLinks[i]);

      if (data && data.name) {
        results.push(data);
        console.log(`✓ Collected: ${data.name || 'No Name'} (${results.length}) in ${subRegion}`);
      } else {
        console.log(`✗ Failed to extract data from business ${i + 1} in ${subRegion}`);
      }

      await sleep(1500 + Math.random() * 2000);
    }

    return results;
  }

  async searchBusinesses(query, region, maxResults = 0) {
    let allResults = [];
    const uniqueBusinesses = new Map(); // For dedup: key = name + address

    const normalizedRegion = region.toUpperCase().trim();
    let subRegions = [region]; // Default to single region
    let maxPerSub = maxResults;

    if (normalizedRegion === 'NJ' || normalizedRegion === 'NEW JERSEY') {
      subRegions = njCities;
      console.log(`Splitting NJ into ${subRegions.length} cities for broader search.`);
      if (maxResults > 0) {
        maxPerSub = Math.ceil(maxResults / subRegions.length);
      } else {
        maxPerSub = 0; // Unlimited per sub-region
      }
    }

    for (const subRegion of subRegions) {
      const subResults = await this._performSearch(query, `${subRegion}, ${region}`, maxPerSub);
      subResults.forEach((result) => {
        const key = `${result.name.toLowerCase() || ''}-${result.address.toLowerCase() || ''}`;
        if (!uniqueBusinesses.has(key)) {
          uniqueBusinesses.set(key, result);
          allResults.push(result);
        }
      });

      if (maxResults > 0 && allResults.length >= maxResults) {
        allResults = allResults.slice(0, maxResults);
        break;
      }

      // Delay between sub-regions to avoid detection
      await sleep(5000 + Math.random() * 5000);
    }

    console.log(`Total unique businesses collected: ${allResults.length}`);
    return allResults;
  }

  exportToCsv(businesses, filename = 'results.csv') {
    if (!businesses || businesses.length === 0) {
      console.log('No data to export to CSV.');
      return false;
    }

    try {
      const csvWriter = createObjectCsvWriter({
        path: filename,
        header: [
          { id: 'name', title: 'BUSINESS_NAME' },
          { id: 'phone', title: 'PHONE' },
          { id: 'email', title: 'EMAIL' },
          { id: 'city', title: 'CITY' },
          { id: 'address', title: 'ADDRESS' },
          { id: 'rating', title: 'REVIEWS' },
          { id: 'website', title: 'WEBSITE' },
        ],
      });

      csvWriter.writeRecords(businesses)
        .then(() => console.log(`✓ CSV saved to "${filename}" with ${businesses.length} entries`));

      return true;
    } catch (err) {
      console.error('CSV export error:', err);
      return false;
    }
  }

  exportToXlsx(businesses, filename = 'results.xlsx') {
    if (!businesses || businesses.length === 0) {
      console.log('No data to export to Excel.');
      return false;
    }

    try {
      const worksheet = XLSX.utils.json_to_sheet(businesses);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Leads');
      XLSX.writeFile(workbook, filename);
      console.log(`✓ Excel saved to "${filename}" with ${businesses.length} entries`);
      return true;
    } catch (err) {
      console.error('Excel export error:', err);
      return false;
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      console.log('Browser closed.');
    }
  }
}

export default GoogleMapsPuppeteerScraper;