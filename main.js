#!/usr/bin/env node
/**
 * scrape-novel.js
 *
 * Usage:
 *   node scrape-novel.js "https://tw.abc.com/novel/2139/catalog"
 *
 * Requirements:
 *   npm install playwright
 *   (optional) npx playwright install
 */

const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");
const { chromium } = require("playwright");

async function main() {
	const startUrl = process.argv[2];
	if (!startUrl) {
		console.error('Usage: node scrape-novel.js "<startUrl>"');
		process.exit(1);
	}

	let bookId;
	try {
		bookId = extractBookId(startUrl);
	} catch (e) {
		console.error("Failed to extract book id from URL:", e.message);
		process.exit(1);
	}

	const rootDir = path.join(process.cwd(), String(bookId));
	await fs.mkdir(rootDir, { recursive: true });
	console.log("Root folder:", rootDir);

	/* 	const browser = await chromium.launch({ headless: false });
	const context = await browser.newContext({ viewport: { width: 1200, height: 900 } }); */
	const browser = await chromium.launch({
		headless: false,
		executablePath: "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
	});
	const context = await browser.newContext();
	const page = await context.newPage();

	try {
		await page.goto(startUrl, { waitUntil: "domcontentloaded" });
	} catch (err) {
		console.warn("Initial navigation error (continuing):", err.message);
	}

	// Wait for the volumes container(s) to appear (if they do)
	try {
		await page.waitForSelector("ul.volume-chapters", { timeout: 8000 });
	} catch (e) {
		console.warn("No ul.volume-chapters found within timeout - continuing anyway.");
	}

	const volumeULs = await page.$$("ul.volume-chapters");
	console.log(`Found ${volumeULs.length} volume <ul class="volume-chapters"> elements.`);

	for (let v = 0; v < volumeULs.length; v++) {
		const ul = volumeULs[v];

		// Get h3 text for subfolder name
		let rawH3 = `volume_${v + 1}`;
		try {
			const h3 = await ul.$("h3");
			if (h3) {
				rawH3 = (await h3.evaluate((n) => n.textContent || "")).trim() || rawH3;
			}
		} catch (e) {
			console.warn("Failed to read h3 for volume", v + 1, e.message);
		}
		const folderName = sanitizeFilename(rawH3) || `volume_${v + 1}`;
		const subDir = path.join(rootDir, folderName);
		await fs.mkdir(subDir, { recursive: true });
		console.log(`\nVolume ${v + 1}: "${rawH3}" -> folder: ${subDir}`);

		// Screenshot the first .volume-cover.chapter-li inside this ul (if any)
		try {
			// try a couple of likely selectors within UL
			let coverHandle = await ul.$(".volume-cover.chapter-li");
			if (!coverHandle) coverHandle = await ul.$("li.volume-cover.chapter-li");
			if (coverHandle) {
				await coverHandle.scrollIntoViewIfNeeded();
				const coverPath = path.join(subDir, "cover.png");
				await coverHandle.screenshot({ path: coverPath });
				console.log("Saved cover to", coverPath);
			} else {
				console.log("No cover element found in this volume.");
			}
		} catch (e) {
			console.warn("Error screenshotting cover:", e.message);
		}

		// Get chapter li elements
		const liHandles = await ul.$$("li.chapter-li.jsChapter");
		console.log(`Found ${liHandles.length} chapters in this volume.`);

		let nextChapterUrl = null;
		for (let i = 0; i < liHandles.length; i++) {
			const li = liHandles[i];
			const chapterIndex = i + 1;
			console.log(`\nProcessing chapter ${chapterIndex} of volume ${v + 1} ...`);

			// Save JSON file named "1.json", "2.json", ... in subfolder
			const jsonPath = path.join(subDir, `${chapterIndex}.json`);
			let exists = false;
			try {
				await fs.access(jsonPath);
				console.log(`File exists, chapter ${chapterIndex} of volume ${v + 1}`);
				continue;
				//exists = true;
			} catch (e) {
				// File does not exist, safe to write
			}

			// find anchor and href
			const a = await li.$("a");
			if (!a) {
				console.warn("No <a> found inside li, skipping.");
				continue;
			}
			let href = await a.getAttribute("href");
			if (!href) {
				console.warn("Anchor has no href, skipping.");
				continue;
			}
			// resolve relative URLs
			try {
				href = new URL(href, startUrl).href;
			} catch (e) {
				console.warn("Failed to resolve href", href, e.message);
				continue;
			}

			const chapterPage = await context.newPage();
			const origin = "https://tw.linovelib.com";
			try {
				await chapterPage.goto(href, { waitUntil: "domcontentloaded" });
			} catch (e) {
				console.warn("Navigation error 1 to chapter URL (continuing):", href, e.message);
				try {
					await chapterPage.goto(origin + nextChapterUrl, { waitUntil: "domcontentloaded" });
				} catch (e) {
					console.warn("Navigation error 2 to chapter URL (continuing):", nextChapterUrl, e.message);
					continue;
				}
			}

			try {
				// Wait for #atitle and #acontent to appear (unchanged)
				await chapterPage.waitForSelector("#atitle", { timeout: 10000 }).catch(() => {});
				await chapterPage.waitForSelector("#acontent", { timeout: 10000 }).catch(() => {});
			} catch (e) {
				// continue anyway
			}

			// Read chapter title (from the first page)
			let chapterTitle = "";
			try {
				chapterTitle = (await chapterPage.$eval("#atitle", (el) => (el && el.textContent ? el.textContent.trim() : ""))).trim();
			} catch (e) {
				console.warn("Could not read #atitle:", e.message);
			}

			// Ensure pictures folder exists for this subfolder
			const picturesDir = path.join(subDir, "pictures");
			await fs.mkdir(picturesDir, { recursive: true });

			// Collect page-by-page contents
			const pagesContents = [];
			let pageCount = 0;
			while (true) {
				try {
					await new Promise((res) => setTimeout(res, 3000));
				} catch (e) {
					// ignore
				}
				if (!exists) {
					// After the initial wait/race, remove unwanted elements (in case they appeared)
					try {
						await chapterPage
							.evaluate(() => {
								document.querySelectorAll(".google-auto-placed, iframe, ins").forEach((el) => el.remove());
							})
							.catch(() => {});
					} catch (_) {}

					try {
						await new Promise((res) => setTimeout(res, 1000));
					} catch (e) {
						// ignore
					}

					pageCount++;
					console.log(`  Processing page ${pageCount} of chapter ${chapterIndex} ...`);

					// Wait for #acontent
					try {
						await chapterPage.waitForSelector("#acontent", { timeout: 10000 });
					} catch (e) {
						console.warn(" #acontent not found on this page (continuing):", e.message);
					}

					// === NEW: remove unwanted elements BEFORE extracting content on each page iteration ===
					try {
						await chapterPage
							.evaluate(() => {
								document.querySelectorAll(".google-auto-placed, iframe, ins").forEach((el) => el.remove());
							})
							.catch(() => {});
					} catch (_) {}

					// Extract content for current page
					try {
						const pageContent = await extractAContent(chapterPage, picturesDir);
						pagesContents.push(pageContent);
					} catch (e) {
						console.warn("Error extracting #acontent:", e.message);
						pagesContents.push([]);
					}
				}

				// Check the last <a> in #footlink
				let hasNext = false;
				try {
					const footLocator = chapterPage.locator("#footlink a");
					const count = await footLocator.count();
					if (count > 0) {
						const last = footLocator.nth(count - 1);
						const txt = (await last.textContent()) || "";
						if (txt.trim() === "下一頁") {
							// click it to navigate to next page
							console.log("  Found 下一頁; navigating to next page ...");

							// capture previous acontent html to detect update if there is no full navigation
							let prevHTML = "";
							try {
								prevHTML = await chapterPage.$eval("#acontent", (el) => el.innerHTML).catch(() => "");
							} catch (e) {
								prevHTML = "";
							}

							// try clicking and wait for navigation OR DOM update
							try {
								await Promise.all([
									chapterPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {}),
									last.click({ timeout: 5000 }).catch(() => {}),
								]);
							} catch (e) {
								// ignore
							}

							// wait for #acontent to change (if navigation didn't happen)
							try {
								await chapterPage
									.waitForFunction(
										(selector, prev) => {
											const el = document.querySelector(selector);
											return el && el.innerHTML !== prev;
										},
										{ timeout: 10000 },
										"#acontent",
										prevHTML
									)
									.catch(() => {});
							} catch (e) {
								// ignore
							}

							hasNext = true;
						} else if (txt.trim() === "下一章") {
							console.log("  Found 下一章");
							nextChapterUrl = await chapterPage.evaluate(() => window.ReadParams?.url_next);
							console.log("ReadParams.url_next =", nextChapterUrl);
						}
					}
				} catch (e) {
					console.warn("Error checking footlink:", e.message);
				}

				if (!hasNext) break;
			} // end pages loop

			// Build JSON object
			const jsonObj = {
				chapterTitle: chapterTitle || "",
				contents: pagesContents,
			};

			try {
				await fs.writeFile(jsonPath, JSON.stringify(jsonObj, null, 2), "utf-8");
				console.log(`Saved chapter JSON to ${jsonPath}`);
			} catch (e) {
				console.warn("Failed to write JSON file:", e.message);
			}

			try {
				await chapterPage.close();
			} catch (_) {}
		} // end li loop
	} // end volume loop

	await browser.close();
	console.log("\nAll done.");
}

/**
 * Extracts book id (last digit-group) from URL path
 */
function extractBookId(urlStr) {
	const u = new URL(urlStr);
	const matches = u.pathname.match(/\d+/g);
	if (!matches || matches.length === 0) throw new Error("No digits found in URL path");
	return matches[matches.length - 1];
}

/**
 * Sanitize file/folder name
 */
function sanitizeFilename(name) {
	if (!name) return "";
	// remove control chars and characters disallowed in filenames
	const sanitized = name
		.replace(/[\u0000-\u001F\u007F<>:"/\\|?*]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	// limit length
	return sanitized.substring(0, 200);
}

/**
 * Extracts a single page's acontent elements into an array of strings according to your rules.
 * Saves images (screenshots) into picturesDir and inserts (((<imageId>))) entries into returned array.
 */
async function extractAContent(page, picturesDir) {
	const result = [];

	const acHandle = await page.$("#acontent");
	if (!acHandle) return result;

	// Get child nodes (including text nodes) as handles
	const childNodesHandle = await acHandle.evaluateHandle((el) => Array.from(el.childNodes));
	const properties = await childNodesHandle.getProperties();

	// Config
	const STABLE_SAMPLES = 3;
	const STABLE_INTERVAL = 100; // ms
	const LAZY_POLL_INTERVAL = 100; // ms
	const LAZY_TIMEOUT = 20000; // ms
	const SCROLL_SETTLE = 100; // ms
	const PRE_CAPTURE_DELAY = 100; // ms

	// iterate through each node handle separately
	for (const handle of properties.values()) {
		const elem = handle.asElement();
		if (!elem) {
			// text node
			try {
				const txt = await handle.evaluate((n) => n.textContent || "").catch(() => "");
				if (txt && txt.trim()) result.push(txt.trim());
			} catch (_) {}
			continue;
		}

		const isHidden = await elem
			.evaluate((el) => {
				const style = window.getComputedStyle(el);
				return style && (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0);
			})
			.catch(() => true); // on error, treat as hidden
		if (isHidden) continue;

		// get tag
		let tagNameRaw = "";
		try {
			tagNameRaw = await elem.evaluate((n) => n.tagName).catch(() => "");
		} catch (_) {
			tagNameRaw = "";
		}
		const tagName = (tagNameRaw || "").toLowerCase();

		if (tagName === "p") {
			const text = (await elem.evaluate((n) => n.textContent || "")).trim();
			if (text) result.push(text);
			continue;
		} else if (tagName === "br") {
			result.push("");
			continue;
		} else if (tagName === "center") {
			const text = (await elem.evaluate((n) => n.textContent || "")).trim();
			result.push(`((${text}))`);
			continue;
		} else if (tagName !== "img") {
			//const text = (await elem.evaluate((n) => n.textContent || "")).trim();
			//if (text) result.push(text);
			continue;
		}

		// -------------------------------
		// Now handle <img> elements only
		// -------------------------------
		await fs.mkdir(picturesDir, { recursive: true });

		// read src candidates
		let src = "";
		try {
			src = await elem
				.evaluate(
					(img) =>
						img.getAttribute("src") ||
						img.getAttribute("data-src") ||
						img.getAttribute("data-original") ||
						(img.dataset && (img.dataset.src || img.dataset.original)) ||
						""
				)
				.catch(() => "");
		} catch (_) {
			src = "";
		}

		// scroll into view and wait a bit
		try {
			await elem.evaluate((img) => img.scrollIntoView({ block: "center", inline: "center", behavior: "auto" })).catch(() => {});
		} catch (_) {}
		await page.waitForTimeout(SCROLL_SETTLE);

		// wait for lazy load status
		const startLazy = Date.now();
		let lazyReady = false;
		while (Date.now() - startLazy < LAZY_TIMEOUT) {
			try {
				const st = await elem
					.evaluate((img) => {
						return {
							lazy: !!(img.classList && img.classList.contains("lazyloaded")),
							hasSrc: !!(img.getAttribute && (img.getAttribute("src") || img.getAttribute("data-src") || img.getAttribute("data-original"))),
							nw: img.naturalWidth && img.naturalWidth > 0 ? img.naturalWidth : 0,
							nh: img.naturalHeight && img.naturalHeight > 0 ? img.naturalHeight : 0,
						};
					})
					.catch(() => ({ lazy: false, hasSrc: false, nw: 0, nh: 0 }));
				if (st.lazy || st.hasSrc || st.nw > 0) {
					lazyReady = true;
					break;
				}
			} catch (_) {}
			await page.waitForTimeout(LAZY_POLL_INTERVAL);
		}
		if (!lazyReady) console.warn("Image lazy-ready timed out; continuing capture attempt.");

		// re-read src in case it changed
		try {
			src = await elem
				.evaluate(
					(img) =>
						img.getAttribute("src") ||
						img.getAttribute("data-src") ||
						img.getAttribute("data-original") ||
						(img.dataset && (img.dataset.src || img.dataset.original)) ||
						""
				)
				.catch(() => src);
		} catch (_) {}

		// sample bounding rect until stable
		let lastRect = null;
		let stableCount = 0;
		const startStable = Date.now();
		const STABLE_TIMEOUT = 8000;
		while (Date.now() - startStable < STABLE_TIMEOUT) {
			let rect = null;
			try {
				rect = await elem
					.evaluate((el) => {
						const r = el.getBoundingClientRect();
						return {
							x: r.left,
							y: r.top,
							w: r.width,
							h: r.height,
							scrollX: window.scrollX || window.pageXOffset || 0,
							scrollY: window.scrollY || window.pageYOffset || 0,
							dpr: window.devicePixelRatio || 1,
						};
					})
					.catch(() => null);
			} catch (_) {
				rect = null;
			}

			if (rect && rect.w > 0 && rect.h > 0) {
				if (lastRect && Math.abs(rect.w - lastRect.w) < 1 && Math.abs(rect.h - lastRect.h) < 1 && Math.abs(rect.x - lastRect.x) < 1 && Math.abs(rect.y - lastRect.y) < 1) {
					stableCount++;
				} else {
					stableCount = 1;
					lastRect = rect;
				}
				if (stableCount >= STABLE_SAMPLES) break;
			} else {
				stableCount = 0;
				lastRect = rect;
			}
			await page.waitForTimeout(STABLE_INTERVAL);
		}

		// fallback to single read if nothing stable
		if (!lastRect) {
			try {
				lastRect = await elem
					.evaluate((el) => {
						const r = el.getBoundingClientRect();
						return {
							x: r.left,
							y: r.top,
							w: r.width,
							h: r.height,
							scrollX: window.scrollX || window.pageXOffset || 0,
							scrollY: window.scrollY || window.pageYOffset || 0,
							dpr: window.devicePixelRatio || 1,
						};
					})
					.catch(() => null);
			} catch (_) {
				lastRect = null;
			}
		}

		// small pre-capture pause
		await page.waitForTimeout(PRE_CAPTURE_DELAY);

		const imageId = extractImageIdFromSrc(src) || String(Date.now());
		const savePath = path.join(picturesDir, `${imageId}.png`);

		if (!fileExistsSync(savePath)) {
			// Try precise clip screenshot if we have a valid rect
			if (lastRect && lastRect.w > 0 && lastRect.h > 0) {
				try {
					await elem.screenshot({ path: savePath });
				} catch (err) {
					console.warn(imageId, "Clip screenshot error", err.message);
				}
			} else {
				console.warn(imageId, "Clip screenshot error: no valid bounding rect");
			}
		}

		result.push(`(((${imageId})))`);
	}

	try {
		await childNodesHandle.dispose();
	} catch (_) {}
	return result;
}

/**
 * Extract last numeric group from an image src string, e.g. ".../224341.jpg" -> "224341"
 */
function extractImageIdFromSrc(src) {
	if (!src) return null;
	try {
		// normalize relative urls
		const u = new URL(src, "http://example.com");
		const parts = u.pathname.split("/").filter(Boolean);
		const base = parts.length ? parts[parts.length - 1] : u.pathname;
		const matches = base.match(/\d+/g);
		if (matches && matches.length) return matches[matches.length - 1];
	} catch (e) {
		const matches = src.match(/\d+/g);
		if (matches && matches.length) return matches[matches.length - 1];
	}
	return null;
}

/**
 * Synchronously check if file exists (used to avoid race conditions between async checks)
 */
function fileExistsSync(p) {
	try {
		return fsSync.existsSync(p);
	} catch (_) {
		return false;
	}
}

// Run the main routine
main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(2);
});
