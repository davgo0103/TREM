// Webhook 發送
//
// * webhook.url 可填多個網址，以空白、逗號或換行分隔
// * Discord：同一事件（key）的後續訊息改為編輯第一則訊息；可附上截圖，編輯時一併換新圖
// * Discord 限流（429）時依 retry_after 暫停該網址
// * 其他網址：照舊 POST JSON，不附圖
const { ipcRenderer } = require("electron");

const MESSAGE_EXPIRY_MS = 600_000;
const IMAGE_NAME = "earthquake.jpg";

/** key → Map<url, messageId> */
const sent = new Map();

/** key → 第一次發送時間 */
const sentAt = new Map();

/** key → 最後一次發送的內容（更新截圖時沿用） */
const lastBody = new Map();

/** key → 發送中的工作 */
const queue = new Map();

/** url → 限流解除的時間 */
const pausedUntil = new Map();

const isDiscord = (url) => /(^|\.)discord(app)?\.com$/i.test(url.hostname) && url.pathname.startsWith("/api/webhooks/");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class HttpError extends Error {
	constructor(status, text, retryAfter) {
		super(`HTTP ${status} ${text}`);
		this.status = status;
		this.retryAfter = retryAfter;
	}
}

/** @param {string} value */
function parseUrls(value) {
	const urls = [];

	for (const part of String(value ?? "").split(/[\s,]+/)) {
		if (!part) continue;

		try {
			const url = new URL(part);

			if (["http:", "https:"].includes(url.protocol)) urls.push(url);
		} catch {
			// 略過無效網址
		}
	}

	return urls;
}

function prune() {
	const now = Date.now();

	for (const [key, time] of sentAt)
		if (now - time > MESSAGE_EXPIRY_MS) {
			sentAt.delete(key);
			sent.delete(key);
			lastBody.delete(key);
		}
}

/** 擷取主視窗畫面（最寬 1024，JPEG），失敗回傳 null。 */
async function captureMap() {
	try {
		const jpeg = await ipcRenderer.invoke("webhook:capture");
		return jpeg ? new Blob([jpeg], { type: "image/jpeg" }) : null;
	} catch {
		return null;
	}
}

/** 有圖時用 multipart，embed 圖片改指向附件；新附件會取代舊的。 */
function buildRequest(body, image) {
	if (!image) return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };

	const payload = structuredClone(body);

	if (payload.embeds?.[0]) payload.embeds[0].image = { url: `attachment://${IMAGE_NAME}` };

	payload.attachments = [{ id: 0, filename: IMAGE_NAME }];

	const form = new FormData();
	form.append("payload_json", JSON.stringify(payload));
	form.append("files[0]", image, IMAGE_NAME);
	return { body: form };
}

async function request(url, method, body, image) {
	const res = await fetch(url, { method, ...buildRequest(body, image) });

	if (!res.ok) {
		const text = await res.text();
		let retryAfter = Number(res.headers.get("retry-after")) || 0;

		try {
			retryAfter = JSON.parse(text).retry_after ?? retryAfter;
		} catch {
			// 不是 JSON
		}

		if (res.status == 429) pausedUntil.set(url.origin + url.pathname.split("/messages/")[0], Date.now() + retryAfter * 1000);

		throw new HttpError(res.status, text, retryAfter);
	}

	return res;
}

/** 限流時等到解除再送，只重試一次。 */
async function requestWithRetry(url, method, body, image) {
	try {
		return await request(url, method, body, image);
	} catch (error) {
		if (error.status != 429) throw error;

		await sleep(Math.min(error.retryAfter * 1000, 10_000) + 100);
		return request(url, method, body, image);
	}
}

function editUrl(url, messageId) {
	const edit = new URL(url);
	edit.pathname += `/messages/${messageId}`;
	edit.searchParams.delete("wait");
	return edit;
}

/** 編輯不能改 username / avatar */
function editBody(body) {
	const { username, avatar_url, tts, ...rest } = body;
	return rest;
}

async function sendOne(url, body, { key, image }) {
	if (!isDiscord(url)) {
		await requestWithRetry(url, "POST", body, null);
		return;
	}

	const messageId = key != null ? sent.get(key)?.get(url.href) : null;

	if (messageId)
		try {
			await requestWithRetry(editUrl(url, messageId), "PATCH", editBody(body), image);
			return;
		} catch (error) {
			// 原訊息被刪除才改發新訊息，其他錯誤照常回報
			if (error.status != 404) throw error;
		}

	const post = new URL(url);
	post.searchParams.set("wait", "true");
	const message = await (await requestWithRetry(post, "POST", body, image)).json();

	if (key != null && message?.id) {
		if (!sent.has(key)) {
			sent.set(key, new Map());
			sentAt.set(key, Date.now());
		}

		sent.get(key).set(url.href, message.id);
	}
}

/**
 * 發送到所有設定的 Webhook。
 * @param {string} urls setting["webhook.url"]
 * @param {object} body Discord 格式的訊息
 * @param {object} [options]
 * @param {string} [options.key] 同一事件的識別，相同 key 的後續訊息會編輯原訊息（僅 Discord）
 * @param {boolean} [options.image] 附上主視窗截圖（僅 Discord）
 * @returns {Promise<void>} 任一網址失敗時 reject（其餘網址仍會發送）
 */
async function sendWebhook(urls, body, { key, image = false } = {}) {
	prune();
	const targets = parseUrls(urls);

	if (!targets.length) return;

	if (key != null) lastBody.set(key, body);

	// 截圖要在排隊前取得，才是收到這一報當下的畫面
	const jpeg = image && targets.some(isDiscord) ? await captureMap() : null;

	const send = async () => {
		const results = await Promise.allSettled(targets.map((url) => sendOne(url, body, { key, image: jpeg })));
		const errors = results.filter((r) => r.status == "rejected").map((r) => r.reason);

		if (errors.length) throw new Error(errors.map(String).join("; "));
	};

	if (key == null) return send();

	// 同一事件依序發送：前一則拿到訊息 ID 後，這一則才能改為編輯
	const job = (queue.get(key) ?? Promise.resolve()).catch(() => void 0).then(send);
	queue.set(key, job);
	job.finally(() => queue.get(key) === job && queue.delete(key)).catch(() => void 0);
	return job;
}

/**
 * 以目前畫面更新已發出的 Discord 訊息截圖，文字沿用最後一次發送的內容。
 * 上一次還在送、還沒有訊息可編輯、或該網址正被限流時，直接略過這一次。
 * @param {string} urls setting["webhook.url"]
 * @param {string} key 與 sendWebhook 相同的事件識別
 * @returns {Promise<boolean>} 是否有送出
 */
async function refreshWebhookImage(urls, key) {
	const body = lastBody.get(key);
	const messages = sent.get(key);

	if (!body || !messages || queue.has(key)) return false;

	const now = Date.now();
	const targets = parseUrls(urls).filter((url) => isDiscord(url) && messages.has(url.href) && !(pausedUntil.get(url.origin + url.pathname) > now));

	if (!targets.length) return false;

	const job = (async () => {
		const jpeg = await captureMap();

		if (!jpeg) return;

		// 限流或失敗就等下一次，不重試
		await Promise.allSettled(targets.map((url) => request(editUrl(url, messages.get(url.href)), "PATCH", editBody(body), jpeg)));
	})();

	queue.set(key, job);
	job.finally(() => queue.get(key) === job && queue.delete(key)).catch(() => void 0);
	await job;
	return true;
}

module.exports = { sendWebhook, refreshWebhookImage, parseUrls, isDiscord };
