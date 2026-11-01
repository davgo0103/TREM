// ExpTech 各服務的區域節點（參考 ExpTechTW/TREM-Lite lib/http/regions.ts）
//
// 程式裡只寫 DNS 平衡名稱（如 api.core.exptech.dev），實際送出時換成目前使用中的區域節點，
// 避免每次查詢 DNS 落到不同區域、兩邊資料不一致。使用中的節點只在以下情況切換：
// 探測失敗、連續 3 次請求失敗、或另一個節點快兩倍以上。
const SERVICES = {
	"api.lb.exptech.dev": {
		nodes : ["api.lb-tpe1.exptech.dev", "api.lb-khh1.exptech.dev"],
		probe : "/api/v2/eq/eew",
	},
	"static.lb.exptech.dev": {
		nodes : ["static.lb-tpe1.exptech.dev", "static.lb-khh1.exptech.dev"],
		probe : "/api/v1/map/tiles/0/0/0.pbf",
	},
	"api.core.exptech.dev": {
		nodes : ["api.core-tnn1.exptech.dev", "api.core-tyo1.exptech.dev"],
		probe : "/api/v2/eq/eew",
	},
	"static.core.exptech.dev": {
		nodes : ["static.core-tnn1.exptech.dev", "static.core-tyo1.exptech.dev"],
		probe : "/resource/station",
	},
};

const PROBE_EVERY = 30_000;
const PROBE_TIMEOUT = 3_000;
const FAILS_TO_SWITCH = 3;

const state = {};

for (const [balanced, service] of Object.entries(SERVICES))
	state[balanced] = { active: 0, fails: 0, nodes: service.nodes, probe: service.probe };

let logger = () => void 0;

function setLogger(fn) {
	logger = fn;
}

/** 平衡名稱對應的使用中節點；不認得的主機原樣傳回。 */
function host(balanced) {
	const s = state[balanced];
	return s ? s.nodes[s.active] : balanced;
}

/** 把網址裡的平衡名稱換成使用中的節點；offset 不為 0 時改用其後第 offset 個節點（重試換節點用）。 */
function resolve(url, offset = 0) {
	const u = new URL(url);
	const s = state[u.hostname];

	if (s) u.hostname = s.nodes[(s.active + offset) % s.nodes.length];

	return u.toString();
}

function serviceOf(url) {
	const name = new URL(url).hostname;

	for (const [balanced, s] of Object.entries(state))
		if (balanced === name || s.nodes.includes(name)) return balanced;

	return null;
}

function switchTo(balanced, index, why) {
	const s = state[balanced];

	if (s.active === index) return;

	logger(`${balanced}: ${s.nodes[s.active]} -> ${s.nodes[index]} (${why})`);
	s.active = index;
	s.fails = 0;
}

/** 回報一次請求的結果；連續失敗 FAILS_TO_SWITCH 次就換下一個節點。 */
function report(url, ok) {
	const balanced = serviceOf(url);

	if (!balanced) return;

	const s = state[balanced];

	if (ok) {
		s.fails = 0;
		return;
	}

	if (++s.fails >= FAILS_TO_SWITCH)
		switchTo(balanced, (s.active + 1) % s.nodes.length, `${FAILS_TO_SWITCH} failures in a row`);
}

const MAX_ATTEMPTS = 3;
const RETRY_AFTER_CAP_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shouldRetry = (status) => status >= 500 || status === 429;

/** Retry-After（秒數或 HTTP 日期）轉成毫秒，最多 RETRY_AFTER_CAP_MS；沒有時回傳 null。 */
function retryAfterMs(res) {
	const value = res.headers.get("retry-after");

	if (!value) return null;

	const ms = /^\d+$/.test(value) ? +value * 1000 : Date.parse(value) - Date.now();

	return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), RETRY_AFTER_CAP_MS) : null;
}

async function fetchOnce(url, offset, timeout, options) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeout);

	try {
		const res = await fetch(resolve(url, offset), { cache: "no-cache", ...options, signal: controller.signal });
		report(url, res.status < 500);
		return res;
	} catch (err) {
		report(url, false);
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 帶逾時、節點切換與重試的 fetch（參考 TREM-Lite lib/http/webBackend.ts）。
 * 預設 cache: "no-cache"，讓瀏覽器用 ETag 重新驗證，沒變的資料只會拿到 304。
 * GET 遇到 5xx、429 或沒有回應時重試，最多 MAX_ATTEMPTS 次：第一次重試立即換另一個
 * 區域節點，之後以指數退避（含隨機抖動）等待，並遵守 Retry-After。
 */
async function apiFetch(url, { timeout = 5_000, ...options } = {}) {
	const retryable = !options.method || options.method.toUpperCase() === "GET";
	let lastError = null;
	let lastResponse = null;
	let wait = 0;

	for (let attempt = 0; attempt < (retryable ? MAX_ATTEMPTS : 1); attempt++) {
		if (wait) await sleep(wait);

		try {
			lastResponse = await fetchOnce(url, attempt, timeout, options);

			if (!shouldRetry(lastResponse.status)) return lastResponse;

			lastError = null;
			wait = retryAfterMs(lastResponse);
		} catch (err) {
			lastError = err;
			wait = null;
		}

		// 第一次重試直接換節點，不等待；之後 0.5 秒、1 秒……加上抖動
		wait ??= attempt === 0 ? 0 : 500 * 2 ** (attempt - 1) + Math.random() * 250;
	}

	if (lastError) throw lastError;

	return lastResponse;
}

async function probeNode(node, path) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
	const t = performance.now();

	try {
		const res = await fetch(`https://${node}${path}`, { cache: "no-store", signal: controller.signal });
		return res.ok ? performance.now() - t : Infinity;
	} catch {
		return Infinity;
	} finally {
		clearTimeout(timer);
	}
}

async function probeAll() {
	await Promise.all(Object.entries(state).map(async ([balanced, s]) => {
		const times = await Promise.all(s.nodes.map((node) => probeNode(node, s.probe)));
		const current = times[s.active];
		let best = s.active;

		for (let i = 0; i < times.length; i++)
			if (times[i] < times[best]) best = i;

		if (!Number.isFinite(current) && Number.isFinite(times[best]))
			switchTo(balanced, best, "probe failed");
		else if (times[best] * 2 <= current)
			switchTo(balanced, best, `${Math.round(times[best])}ms vs ${Math.round(current)}ms`);
	}));
}

let probing = null;

/** 只需在主視窗啟動；其他視窗沿用預設（最近的）節點。 */
function startProbing() {
	if (probing) return;

	probeAll();
	probing = setInterval(probeAll, PROBE_EVERY);
}

module.exports = { host, resolve, report, apiFetch, startProbing, setLogger };
