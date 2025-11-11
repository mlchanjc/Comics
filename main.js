// fetch_novel_playwright_catalog.js
//
// Usage:
//   node fetch_novel_playwright_catalog.js "https://tw.abc.com/novel/2139/catalog"
//
// Requirements:
//   npm install playwright
//   npx playwright install
//
// This version uses Playwright's element.screenshot() to capture images when possible,
// falling back to in-page fetch and context.request if screenshotting fails.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const CONFIG = {
	headless: false,
	slowMo: 0,
	navigationTimeout: 5000,
	userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) FetchScript/1.0",
	scrollStep: 800,
	scrollDelay: 500,
	delayBetweenRequests: 1000,
};

function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
}

function sanitizeName(name, { allowChinese = true } = {}) {
	if (!name) return "untitled";
	name = String(name).trim();
	name = name.replace(/\r?\n/g, " ");
	name = name.replace(/\s+/g, " ");
	name = name.replace(/^[.\s]+|[.\s]+$/g, "");
	if (allowChinese) {
		name = name.replace(/[^\p{L}\p{N}\-_.()\[\] ]+/gu, "");
	} else {
		name = name.replace(/[^\w\-\_.()\[\] ]+/g, "");
	}
	if (!name) return "untitled";
	if (name.length > 240) name = name.slice(0, 240);
	return name;
}

function getExtFromUrl(url) {
	try {
		const u = new URL(url);
		const base = path.basename(u.pathname);
		const dot = base.lastIndexOf(".");
		if (dot >= 0) return base.slice(dot).toLowerCase();
	} catch {}
	return ".jpg";
}

function imageFilenameFromSrc(src, { forcePng = false } = {}) {
	try {
		const u = new URL(src);
		const pathPart = u.pathname;
		const digits = pathPart.match(/\d+/g) || [];
		const ext = getExtFromUrl(src) || ".jpg";
		const name = digits.join("") || Date.now().toString();
		const chosenExt = forcePng ? ".png" : ext;
		return `${name}${chosenExt}`;
	} catch {
		const ext = forcePng ? ".png" : getExtFromUrl(src) || ".jpg";
		return `${Date.now()}${ext}`;
	}
}

async function writeBufferToFile(buffer, filePath) {
	return fs.promises.writeFile(filePath, buffer);
}

async function delay(ms) {
	return new Promise((res) => setTimeout(res, ms));
}

// Perform a full-page scroll to trigger lazy loading
async function fullScroll(page, step = CONFIG.scrollStep, delayMs = CONFIG.scrollDelay) {
	const height = await page.evaluate(() => document.documentElement.scrollHeight);
	let pos = 0;
	while (pos < height) {
		pos += step;
		await page.evaluate((p) => window.scrollTo(0, p), pos);
		await page.waitForTimeout(delayMs);
	}
	// final scroll to bottom
	await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
	await page.waitForTimeout(delayMs);
	// small back scroll to allow any lazy images to load
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.waitForTimeout(delayMs);
}

// Attempt to download image by running fetch inside the page (mimics Save As with credentials)
// Returns a Buffer or throws
async function downloadImageViaPageFetch(page, imgUrl) {
	return await page
		.evaluate(async (url) => {
			const res = await fetch(url, { credentials: "include" });
			if (!res.ok) {
				throw new Error("HTTP " + res.status);
			}
			const blob = await res.blob();
			return await new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onloadend = () => resolve(reader.result.split(",")[1]); // base64 string
				reader.onerror = reject;
				reader.readAsDataURL(blob);
			});
		}, imgUrl)
		.then((b64) => Buffer.from(b64, "base64"));
}

// Fallback download using Playwright context.request (may be blocked on some servers)
async function downloadImageViaContextRequest(context, url) {
	const resp = await context.request.get(url);
	if (!resp.ok()) throw new Error("HTTP " + resp.status());
	return await resp.body();
}

async function screenshotElementIfFound(page, resolvedUrl, outPath) {
	// Find <img> element on the page whose resolved src/data-src/data-original matches resolvedUrl
	// Returns true if screenshot was captured to outPath, false otherwise.
	let handle = null;
	try {
		handle = await page.evaluateHandle((targetUrl) => {
			const imgs = Array.from(document.querySelectorAll("img"));
			for (const img of imgs) {
				try {
					const candidate = img.getAttribute("src") || img.getAttribute("data-src") || img.getAttribute("data-original") || img.src || "";
					if (!candidate) continue;
					const resolved = new URL(candidate, document.baseURI).toString();
					if (resolved === targetUrl) return img;
				} catch (e) {
					// ignore
				}
			}
			return null;
		}, resolvedUrl);

		if (!handle) return false;
		const el = handle.asElement ? handle.asElement() : null;
		if (!el) return false;

		// scroll into view & allow lazy image to render
		try {
			await el.scrollIntoViewIfNeeded();
		} catch (e) {
			try {
				await el.evaluate((node) => node.scrollIntoView({ block: "center", inline: "center" }));
			} catch (e) {}
		}
		await page.waitForTimeout(200);

		// screenshot the element; Playwright saves directly to disk
		await el.screenshot({ path: outPath, timeout: 120000 });
		return true;
	} catch (err) {
		// console.warn('screenshotElementIfFound error', err.message);
		return false;
	} finally {
		try {
			if (handle && typeof handle.dispose === "function") handle.dispose();
		} catch {}
	}
}

async function main() {
	const startUrl = "https://tw.linovelib.com/novel/2139/catalog";

	// create main folder named by numeric id or domain+catalog
	let mainFolderName = null;
	const idMatch = startUrl.match(/\/(\d+)\/catalog|\/(\d+)\/catalog\/?/);
	if (idMatch) mainFolderName = idMatch[1] || idMatch[2];
	if (!mainFolderName) {
		try {
			const u = new URL(startUrl);
			mainFolderName = sanitizeName(u.hostname + u.pathname.replace(/[\/:]/g, "_"), { allowChinese: false });
		} catch {
			mainFolderName = "novel_download";
		}
	}
	ensureDir(mainFolderName);

	const browser = await chromium.launch({ headless: CONFIG.headless, slowMo: CONFIG.slowMo });
	const context = await browser.newContext({ userAgent: CONFIG.userAgent });
	const page = await context.newPage();
	page.setDefaultNavigationTimeout(CONFIG.navigationTimeout);

	console.log("Opening catalog page:", startUrl);
	await page.goto(startUrl, { waitUntil: "domcontentloaded" });

	// Wait for catalog-volume elements (tolerant)
	await page.waitForTimeout(500);
	const catalogVolumes = await page.$$("div.catalog-volume");
	console.log(`Found ${catalogVolumes.length} catalog-volume elements`);

	for (let vi = 0; vi < catalogVolumes.length; vi++) {
		const vol = catalogVolumes[vi];

		// get first h3 textContent
		const h3 = await vol.$("h3");
		let volName = "untitled_volume";
		if (h3) {
			volName = (await h3.evaluate((el) => el.textContent || "")).trim() || volName;
		}
		const volFolder = path.join(mainFolderName, sanitizeName(volName, { allowChinese: true }));
		ensureDir(volFolder);
		console.log(`\n[${vi + 1}/${catalogVolumes.length}] Volume folder: ${volFolder}`);

		// Download cover: first img in this catalog-volume
		const coverImg = await vol.$("img");
		if (coverImg) {
			// get resolved src (might be data-src or lazy attribute)
			let src = await coverImg.evaluate((el) => el.getAttribute("src") || el.getAttribute("data-src") || el.src || "");
			src = src ? new URL(src, page.url()).toString() : "";
			if (!src) {
				console.warn("  No cover src found");
			} else {
				const coverPath = path.join(volFolder, `cover.png`);
				try {
					// Try screenshot first (preferred)
					try {
						await coverImg.scrollIntoViewIfNeeded();
						await page.waitForTimeout(200);
						await coverImg.screenshot({ path: coverPath, timeout: 120000 });
						console.log("  Saved cover (screenshot):", coverPath);
						usedScreenshot = true;
					} catch (err) {
						console.warn("  cover screenshot failed:", err.message);
					}
				} catch (err) {
					console.warn("  Unexpected error downloading cover:", err.message);
				}
			}
		} else {
			console.warn("  No img found in catalog-volume for cover");
		}

		// Collect chapters inside this volume
		const chapterLis = await vol.$$("li.chapter-li.jsChapter");
		console.log(`  Found ${chapterLis.length} chapter-li.jsChapter in this volume`);

		// If no chapters found inside the volume container, try to query globally under this volume via CSS
		if (chapterLis.length === 0) {
			const moreChapters = await vol.$$(":scope li.chapter-li.jsChapter");
			if (moreChapters.length > 0) {
				chapterLis.push(...moreChapters);
			}
		}

		if (chapterLis.length === 0) {
			console.warn("  No chapters found for this volume, skipping.");
			continue;
		}

		// Get first chapter's href to start following sequentially per your instruction
		const firstChapterA = await chapterLis[0].$("a");
		if (!firstChapterA) {
			console.warn("  First chapter has no anchor; skipping volume.");
			continue;
		}
		let firstHref = (await firstChapterA.evaluate((el) => el.getAttribute("href") || el.href || "")) || "";
		if (!firstHref) {
			console.warn("  First chapter href empty; skipping volume.");
			continue;
		}
		firstHref = new URL(firstHref, page.url()).toString();
		console.log("  Starting chapters from:", firstHref);

		// Build a mapping of chapter list to names
		const chapterTitles = [];
		for (const li of chapterLis) {
			const txt = (await li.evaluate((el) => el.textContent || "")).trim().replace(/\s+/g, " ") || "untitled";
			chapterTitles.push(txt);
		}

		// Note: original script limited to first 2 chapters for testing; keep that small loop unless you want all chapters.
		for (let cidx = 0; cidx < chapterLis.length; cidx++) {
			const li = chapterLis[cidx];
			// chap title
			const chapTitleRaw = chapterTitles[cidx] || (await li.evaluate((el) => el.textContent || ""));
			const chapTitle = chapTitleRaw.trim().replace(/\r?\n/g, " ").trim() || `chapter_${cidx + 1}`;
			const chapFileBase = sanitizeName(chapTitle, { allowChinese: true });
			const chapJsonPath = path.join(volFolder, `${chapFileBase}.json`);
			const picturesFolder = path.join(volFolder, "pictures");
			ensureDir(picturesFolder);

			// get href for this chapter
			const aEl = await li.$("a");
			if (!aEl) {
				console.warn(`  Chapter ${cidx + 1} has no anchor; writing empty JSON`);
				fs.writeFileSync(chapJsonPath, JSON.stringify({ title: chapTitle, lines: [] }, null, 2), "utf8");
				continue;
			}
			let href = (await aEl.evaluate((el) => el.getAttribute("href") || el.href || "")) || "";
			if (!href) {
				console.warn(`  Chapter ${cidx + 1} anchor empty; writing empty JSON`);
				fs.writeFileSync(chapJsonPath, JSON.stringify({ title: chapTitle, lines: [] }, null, 2), "utf8");
				continue;
			}
			href = new URL(href, page.url()).toString();

			console.log(`\n  [Chapter ${cidx + 1}/${chapterLis.length}] ${chapTitle}`);
			console.log("    Opening:", href);

			// open a fresh page for chapter processing
			const chapPage = await context.newPage();
			chapPage.setDefaultNavigationTimeout(CONFIG.navigationTimeout);

			let chapterObj = { title: chapTitle, lines: [] };

			try {
				await chapPage.goto(href, { waitUntil: "networkidle" });
			} catch (err) {
				console.warn("    Failed to open chapter page:", err.message);
				await chapPage.close();
				fs.writeFileSync(chapJsonPath, JSON.stringify(chapterObj, null, 2), "utf8");
				continue;
			}

			let pageIndex = 0;
			// Loop: process current page, then check footlink for 下一頁; if found click it and continue
			while (true) {
				pageIndex++;
				console.log(`    Processing page ${pageIndex} of chapter`);

				// Scroll through whole page to trigger lazy images
				await fullScroll(chapPage);

				// Extract content under #acontent
				const acontent = await chapPage.$("#acontent");
				if (!acontent) {
					console.warn("    No #acontent found on this page");
				} else {
					const pEls = await acontent.$$(":scope > *");

					for (const pEl of pEls) {
						// iterate child nodes
						const childNodes = await pEl.evaluate((node) => {
							const arr = [];
							for (const n of node.childNodes) {
								if (n.nodeType === Node.TEXT_NODE) {
									arr.push({ type: "text", text: n.nodeValue });
								} else if (n.nodeType === Node.ELEMENT_NODE) {
									const tag = n.tagName.toLowerCase();
									if (tag === "br") arr.push({ type: "br" });
									else if (tag === "img") {
										const src = n.getAttribute("src") || n.getAttribute("data-src") || n.getAttribute("data-original") || n.src || "";
										arr.push({ type: "img", src });
									} else {
										arr.push({ type: "other", text: n.textContent || "" });
									}
								}
							}
							return arr;
						});

						let buffer = "";
						for (const node of childNodes) {
							if (node.type === "text" || node.type === "other") {
								buffer += node.text || "";
							} else if (node.type === "br") {
								chapterObj.lines.push(buffer);
								buffer = "";
							} else if (node.type === "img") {
								if (buffer.length > 0) {
									chapterObj.lines.push(buffer);
									buffer = "";
								}
								const rawSrc = node.src || "";
								if (!rawSrc) {
									console.warn("      img without src found; skipping");
									continue;
								}
								const imgUrl = new URL(rawSrc, chapPage.url()).toString();
								// Prefer screenshot: filename forced to .png for screenshots
								const filename = imageFilenameFromSrc(imgUrl, { forcePng: true });
								const filepath = path.join(picturesFolder, filename);

								let saved = false;

								try {
									await node.scrollIntoViewIfNeeded();
									await page.waitForTimeout(200);
									await node.screenshot({ path: filepath, timeout: 120000 });
									console.log("  Saved cover (screenshot):", filepath);
								} catch (err) {
									console.warn("  cover screenshot failed:", err.message);
								}

								if (!saved) {
									console.warn("      Could not acquire image bytes for:", imgUrl);
									// Optionally push a placeholder or skip
								}

								// Insert marker
								const marker = `{{${filename}_${imgUrl}}}`;
								chapterObj.lines.push(marker);
							}
						} // end childNodes loop
						if (buffer.length > 0) {
							chapterObj.lines.push(buffer);
							buffer = "";
						}
					} // end pEls loop
				} // end if acontent

				// After processing content on this page, check #footlink last <a>
				await chapPage.waitForTimeout(200);
				const footlink = await chapPage.$("div#footlink");
				let hasNextPage = false;
				if (footlink) {
					const as = await footlink.$$("a");
					if (as.length > 0) {
						const lastA = as[as.length - 1];
						const lastText = (await lastA.evaluate((el) => (el.textContent || "").trim())) || "";
						if (lastText === "下一頁") {
							hasNextPage = true;
							console.log("    下一頁 found, clicking to next page");
							try {
								await Promise.all([chapPage.waitForNavigation({ waitUntil: "networkidle", timeout: CONFIG.navigationTimeout }), lastA.click({ timeout: 10000 })]);
								continue;
							} catch (err) {
								console.warn("    Failed to click or navigate to 下一頁:", err.message);
								hasNextPage = false;
							}
						}
					}
				}

				if (!hasNextPage) {
					console.log("    No 下一頁 found, finishing this chapter");
					break;
				}
			} // end per-page loop

			// Save chapter JSON
			try {
				fs.writeFileSync(chapJsonPath, JSON.stringify(chapterObj, null, 2), "utf8");
				console.log(`    Saved chapter JSON: ${chapJsonPath}`);
			} catch (err) {
				console.warn("    Failed to write chapter JSON:", err.message);
			}

			await chapPage.close();
			await delay(CONFIG.delayBetweenRequests);
			break;
		} // end chapters loop
		break; // keep original behaviour (stop after first volume)
	} // end volumes loop

	await page.close();
	await context.close();
	await browser.close();

	console.log("\nAll done.");
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
