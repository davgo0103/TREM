// 地震重播資料：把報告前後的即時測站（RTS）與地震速報存到本機，重播時直接讀檔、不必連線
//
// * 存在 userData/replay_data/<發震前 5 秒的 Unix 秒數>/，每秒一個 <秒數>.trem
// * 涵蓋發震前 5 秒到發震後 300 秒（重播播 300 秒就結束）
// * 下載可以中斷後接著下載：已存在的秒數會略過；全部完成後寫入 info.json 作為完成標記
const fs = require("node:fs");
const path = require("node:path");
const { app } = require("@electron/remote");
const { apiFetch } = require("./endpoints.js");

const BEFORE_MS = 5_000;
const LAST_OFFSET_S = 305;
const TOTAL_FILES = LAST_OFFSET_S + 1;
const CONCURRENCY = 3;
const MAX_TRIES = 5;
const INFO_FILE = "info.json";

const ROOT = path.join(app.getPath("userData"), "replay_data");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 資料夾名稱（沿用舊版：發震前 5 秒的 Unix 秒數） */
const startOf = (report) => (report.time - BEFORE_MS) / 1000;

const dirOf = (report) => path.join(ROOT, String(startOf(report)));

const fileOf = (dir, second) => path.join(dir, `${second}.trem`);

/**
 * 本機重播資料的狀態
 * @returns {"none" | "partial" | "complete"}
 */
function stateOf(report) {
	const dir = dirOf(report);

	if (fs.existsSync(path.join(dir, INFO_FILE))) return "complete";

	// 舊版下載的資料沒有 info.json：頭尾都在就當作完整
	const start = startOf(report);

	if (fs.existsSync(fileOf(dir, start)) && fs.existsSync(fileOf(dir, start + LAST_OFFSET_S))) return "complete";

	return fs.existsSync(dir) && fs.readdirSync(dir).some((name) => name.endsWith(".trem")) ? "partial" : "none";
}

/** 抓一個網址的 JSON；404 表示伺服器沒有這一秒的資料，回傳 fallback */
async function fetchJson(url, fallback, signal) {
	for (let attempt = 1; ; attempt++) {
		signal.throwIfAborted();

		try {
			const res = await apiFetch(url, { timeout: 10_000 });

			if (res.status == 404) return fallback;

			if (res.ok) return await res.json();

			throw new Error(`HTTP ${res.status} ${url}`);
		} catch (err) {
			if (attempt >= MAX_TRIES) throw err;

			// 1、2、4、8 秒後重試，避免伺服器忙碌時一直打
			await sleep(1000 * 2 ** (attempt - 1));
		}
	}
}

async function downloadSecond(dir, second, signal) {
	const file = fileOf(dir, second);

	if (fs.existsSync(file)) return;

	const rts = await fetchJson(`https://api.core.exptech.dev/api/v3/trem/rts/${second}`, null, signal);
	const eew = await fetchJson(`https://api.core.exptech.dev/api/v2/eq/eew/${second}`, [], signal);

	signal.throwIfAborted();

	// 先寫暫存檔再改名，中斷時不會留下寫到一半的檔案
	const temp = `${file}.tmp`;
	await fs.promises.writeFile(temp, JSON.stringify({ rts, eew: { eew: Array.isArray(eew) ? eew : eew?.eew ?? [], time: second * 1000 } }));
	await fs.promises.rename(temp, file);
}

/** 進行中的下載：報告 ID → { done, total, controller, promise } */
const downloads = new Map();

/**
 * 下載一筆報告的重播資料
 * @param {object} report 報告（需要 id、time）
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<void>} 取消時 reject AbortError
 */
function download(report, onProgress = () => void 0) {
	if (downloads.has(report.id)) return downloads.get(report.id).promise;

	const dir = dirOf(report);
	const start = startOf(report);
	const controller = new AbortController();
	const job = { done: 0, total: TOTAL_FILES, controller, promise: null };

	job.promise = (async () => {
		await fs.promises.mkdir(dir, { recursive: true });

		let next = 0;

		const worker = async () => {
			while (next < TOTAL_FILES) {
				const second = start + next++;
				await downloadSecond(dir, second, controller.signal);
				job.done++;
				onProgress(job.done, job.total);
			}
		};

		// 任一秒失敗就停止其他正在抓的
		await Promise.all(Array.from({ length: CONCURRENCY }, worker)).catch((err) => {
			controller.abort();
			throw err;
		});
		await fs.promises.writeFile(path.join(dir, INFO_FILE), JSON.stringify({ id: report.id, time: report.time, loc: report.loc, mag: report.mag, savedAt: Date.now() }));
	})().finally(() => downloads.delete(report.id));

	downloads.set(report.id, job);
	return job.promise;
}

/** 正在下載的進度，沒有在下載時回傳 null */
function progressOf(report) {
	const job = downloads.get(report.id);
	return job ? { done: job.done, total: job.total } : null;
}

/** 刪除一筆報告的重播資料（下載中會先停止） */
async function remove(report) {
	const job = downloads.get(report.id);

	if (job) {
		job.controller.abort();
		await job.promise.catch(() => void 0);
	}

	await fs.promises.rm(dirOf(report), { recursive: true, force: true });
}

/** 讀重播時某一秒的資料；沒有這一秒的檔案回傳 null */
function readSecond(dirName, second) {
	const file = fileOf(path.join(ROOT, String(dirName)), second);

	if (!fs.existsSync(file)) return null;

	return JSON.parse(fs.readFileSync(file, "utf8"));
}

module.exports = { ROOT, dirOf, stateOf, download, progressOf, remove, readSecond };
