// Webhook 發送
//
// * webhook.url 可填多個網址，以空白、逗號或換行分隔
// * Discord：同一事件（key）的後續訊息改為編輯第一則訊息；可附上截圖，編輯時一併換新圖
// * 其他網址：照舊 POST JSON，不附圖
const { ipcRenderer } = require("electron");

const MESSAGE_EXPIRY_MS = 600_000;
const IMAGE_NAME = "earthquake.png";

/** key → Map<url, messageId> */
const sent = new Map();

/** key → 第一次發送時間 */
const sentAt = new Map();

/** key → 發送中的工作 */
const queue = new Map();

const isDiscord = (url) => /(^|\.)discord(app)?\.com$/i.test(url.hostname) && url.pathname.startsWith("/api/webhooks/");

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
		}
}

/** 擷取主視窗畫面（最寬 1024），失敗回傳 null。 */
async function captureMap() {
	try {
		const png = await ipcRenderer.invoke("webhook:capture");
		return png ? new Blob([png], { type: "image/png" }) : null;
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

	if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);

	return res;
}

async function sendOne(url, body, { key, image }) {
	if (!isDiscord(url)) {
		await request(url, "POST", body, null);
		return;
	}

	const messageId = key != null ? sent.get(key)?.get(url.href) : null;

	if (messageId) {
		const edit = new URL(url);
		edit.pathname += `/messages/${messageId}`;
		edit.searchParams.delete("wait");

		// 編輯不能改 username / avatar
		const { username, avatar_url, tts, ...rest } = body;

		try {
			await request(edit, "PATCH", rest, image);
			return;
		} catch {
			// 原訊息被刪除等情況，改發新訊息
		}
	}

	const post = new URL(url);
	post.searchParams.set("wait", "true");
	const message = await (await request(post, "POST", body, image)).json();

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

	// 截圖要在排隊前取得，才是收到這一報當下的畫面
	const png = image && targets.some(isDiscord) ? await captureMap() : null;

	const send = async () => {
		const results = await Promise.allSettled(targets.map((url) => sendOne(url, body, { key, image: png })));
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

module.exports = { sendWebhook, parseUrls, isDiscord };
