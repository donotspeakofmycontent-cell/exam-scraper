const { writeFile } = require('fs/promises');
const zlib = require('zlib');
const crypto = require('crypto');

const SECRET_PASSPHRASE = 'NaxlexSecretKey2026!#';

const BASE_URL = 'https://nursing.naxlex.com';

// 👇 Define BOTH targets + output files
const SCRAPE_TARGETS = [
  {
    slug: 'ati-1691653469', // LPN
    file: 'archive-lpn.json',
  },
  {
    slug: 'ati-1691653441', // RN
    file: 'archive-rn.json',
  },
];

// ⚠️ Safer settings (adjust if needed)
const MAX_CONCURRENT = 10;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 300;

// -----------------------------
// Concurrency Limiter
// -----------------------------
class ConcurrencyLimiter {
  constructor(limit) {
    this.limit = limit;
    this.running = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.running >= this.limit) {
      await new Promise(resolve => this.queue.push(resolve));
    }

    this.running++;

    try {
      return await fn();
    } finally {
      this.running--;

      if (this.queue.length) {
        const next = this.queue.shift();
        next();
      }
    }
  }
}

const limiter = new ConcurrencyLimiter(MAX_CONCURRENT);

// -----------------------------
// Fetch with Retry + Backoff
// -----------------------------
async function fetchWithRetry(endpoint, body, retries = MAX_RETRIES) {
  const doFetch = async () => {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: JSON.stringify(body),
    });

    if (response.status === 429) {
      throw new Error('RATE_LIMITED');
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await doFetch();
    } catch (err) {
      if (err.message === 'RATE_LIMITED' && attempt < retries) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`  ⚠️ Rate limited, retrying after ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

async function postAPI(endpoint, body) {
  return limiter.run(() => fetchWithRetry(endpoint, body));
}

// -----------------------------
// Scrape ONE Parent
// -----------------------------
async function scrapeParent(PARENT_SLUG, OUTPUT_FILE) {
  console.log(`\n🧠 Scraping parent: ${PARENT_SLUG}`);

  // 1. Get categories
  console.log('📚 Fetching categories...');
  const subjectsResp = await postAPI('/api/question-subjects', {
    slug: PARENT_SLUG,
  });

  const categories = subjectsResp.exams || [];
  console.log(`Found ${categories.length} categories.`);

  const archive = {
    parentSlug: PARENT_SLUG,
    parentName: subjectsResp.parentName,
    scrapedAt: new Date().toISOString(),
    categories: [],
  };

  // 2. Process categories
  const categoryResults = await Promise.all(
    categories.map(async (cat, idx) => {
      console.log(`\n📁 [${idx + 1}/${categories.length}] ${cat.name}`);

      const catData = {
        name: cat.name,
        slug: cat.slug,
        examsCount: cat.examsCount,
        subtopics: [],
      };

      // First page
      const firstPageResp = await postAPI('/api/paginated-sub-topics', {
        slug: cat.slug,
        page: 1,
      });

      let allSubtopics = firstPageResp.subTopics?.data || [];
      const lastPage = firstPageResp.subTopics?.last_page || 1;

      // باقي الصفحات
      if (lastPage > 1) {
        const pagePromises = [];

        for (let p = 2; p <= lastPage; p++) {
          pagePromises.push(
            postAPI('/api/paginated-sub-topics', {
              slug: cat.slug,
              page: p,
            })
          );
        }

        const pages = await Promise.all(pagePromises);

        for (const resp of pages) {
          allSubtopics.push(...(resp.subTopics?.data || []));
        }
      }

      console.log(`  → ${allSubtopics.length} subtopics`);

      // Fetch questions
      const subtopicResults = await Promise.all(
        allSubtopics.map(async (sub) => {
          console.log(`    ❓ ${sub.name}`);

          try {
            const qResp = await postAPI('/api/review-exam/questions', {
              hasSubscription: true,
              slug: sub.slug,
              extra: "",
            });

            const qCount = qResp.questions?.length || 0;
            console.log(`      ✓ ${qCount} questions`);

            return {
              id: sub.id,
              name: sub.name,
              slug: sub.slug,
              questionsCount: sub.questionsCount,
              questions: qResp.questions || [],
            };
          } catch (err) {
            console.error(`      ✗ Failed: ${err.message}`);

            return {
              id: sub.id,
              name: sub.name,
              slug: sub.slug,
              questionsCount: sub.questionsCount,
              error: err.message,
              questions: [],
            };
          }
        })
      );

      catData.subtopics = subtopicResults;
      console.log(`✅ Completed ${cat.name}`);

      return catData;
    })
  );

  archive.categories = categoryResults;

  // 3. Compress and Encrypt
  const jsonString = JSON.stringify(archive); // no formatting to save space
  const compressedContent = zlib.gzipSync(jsonString);

  const key = crypto.createHash('sha256').update(SECRET_PASSPHRASE).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  const encryptedContent = Buffer.concat([cipher.update(compressedContent), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const finalBuffer = Buffer.concat([iv, encryptedContent, authTag]);

  // Save the file as .naxenc
  const finalOutputFile = OUTPUT_FILE.replace('.json', '.naxenc');
  await writeFile(finalOutputFile, finalBuffer);
  console.log(`\n💾 Saved compressed & encrypted archive to ${finalOutputFile}`);
}

// -----------------------------
// Main Runner
// -----------------------------
async function main() {
  console.log(`🚀 Starting multi-exam scrape`);

  for (const target of SCRAPE_TARGETS) {
    try {
      console.log(`\n==============================`);
      console.log(`📦 Scraping ${target.slug}`);
      console.log(`==============================`);

      await scrapeParent(target.slug, target.file);
    } catch (err) {
      console.error(`❌ Failed for ${target.slug}:`, err.message);
    }
  }

  console.log(`\n✅ All scrapes complete`);
}

main().catch(err => {
  console.error('❌ Scraper crashed:', err);
  process.exit(1);
});
