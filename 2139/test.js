#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

if (process.argv.length < 3) {
	console.error("Usage: node checkJsons.js <root-folder>");
	process.exit(1);
}

const root = path.resolve(process.argv[2]);

/**
 * Recursively walk a directory and call cb(filePath) for each file.
 */
function walkDir(dir, cb) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		console.error(`Failed to read directory: ${dir} - ${err.message}`);
		return;
	}

	for (const ent of entries) {
		const full = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			walkDir(full, cb);
		} else if (ent.isFile()) {
			cb(full);
		}
	}
}

/**
 * Validate a parsed JSON object according to the rules:
 * - must be an object
 * - chapterTitle must be a non-empty string
 * - contents must be a non-empty array
 * - each element in contents must be a non-empty array
 *
 * Returns an array of error messages (empty if valid).
 */
function validateJson(obj) {
	const errs = [];

	if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
		errs.push("root is not an object");
		return errs;
	}

	if (!Object.prototype.hasOwnProperty.call(obj, "chapterTitle")) {
		errs.push('missing "chapterTitle" property');
	} else {
		if (typeof obj.chapterTitle !== "string") {
			errs.push('"chapterTitle" is not a string');
		} else if (obj.chapterTitle.trim() === "") {
			errs.push('"chapterTitle" is empty');
		}
	}

	if (!Object.prototype.hasOwnProperty.call(obj, "contents")) {
		errs.push('missing "contents" property');
	} else {
		if (!Array.isArray(obj.contents)) {
			errs.push('"contents" is not an array');
		} else if (obj.contents.length === 0) {
			errs.push('"contents" is an empty array');
		} else {
			obj.contents.forEach((sub, i) => {
				if (!Array.isArray(sub)) {
					errs.push(`contents[${i}] is not an array`);
				} else if (sub.length === 0) {
					errs.push(`contents[${i}] is an empty array`);
				}
			});
		}
	}

	return errs;
}

const badFiles = [];

walkDir(root, (filePath) => {
	if (path.extname(filePath).toLowerCase() !== ".json") return;

	let raw;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch (err) {
		console.error(`Failed to read file: ${filePath} - ${err.message}`);
		return;
	}

	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		console.error(`Invalid JSON: ${filePath} - ${err.message}`);
		badFiles.push({ filePath, errors: ["invalid JSON"] });
		return;
	}

	const errors = validateJson(parsed);
	if (errors.length > 0) {
		badFiles.push({ filePath, errors });
	}
});

if (badFiles.length === 0) {
	console.log("All JSON files passed validation.");
	process.exit(0);
}

console.log("Files with schema issues:");
for (const entry of badFiles) {
	console.log(entry.filePath);
	for (const e of entry.errors) {
		console.log("  - " + e);
	}
}
process.exit(2);
