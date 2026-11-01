// 以 fetch 讀取的 SSE 連線（參考 ExpTechTW/TREM-Lite features/data/dataHttp.ts）
//
// * 斷線後重連：延遲從 reconnectDelay 起每次加倍，最多 BACKOFF_MAX_MS
// * STALE_MS 內沒收到任何東西（含心跳）視為卡住，主動斷開重連
// * switchUrl()：新連線收到第一個事件後才關閉舊連線；READY_MS 內沒回應就放棄新連線
const { resolve, report } = require("./endpoints.js");

const BACKOFF_MAX_MS = 15_000;
const STALE_MS = 90_000;
const READY_MS = 10_000;

class SSEStream {

	/**
	 * @param {object} options
	 * @param {string} options.label
	 * @param {() => string} options.url 每次連線時呼叫，可依狀態換網址
	 * @param {(event: string, data: string) => void} options.onEvent
	 * @param {(text: string) => void} [options.onComment] 心跳等註解行（": ping 1793509101"）
	 * @param {(message: string, level: number) => void} [options.log]
	 * @param {number} [options.reconnectDelay]
	 */
	constructor({ label, url, onEvent, onComment = () => void 0, log = () => void 0, reconnectDelay = 3_000 }) {
		this.label = label;
		this.url = url;
		this.onEvent = onEvent;
		this.onComment = onComment;
		this.log = log;
		this.reconnectDelay = reconnectDelay;
		this.failures = 0;
		this.conn = null;
		this.retryTimer = null;
		this.stopped = true;
	}

	start() {
		if (!this.stopped) return;

		this.stopped = false;
		this.conn = this.open();
	}

	stop() {
		this.stopped = true;
		clearTimeout(this.retryTimer);
		this.conn?.close();
		this.conn = null;
	}

	/** 換網址重連，新連線就緒後才關掉舊的。 */
	switchUrl() {
		if (this.stopped) return;

		const old = this.conn;
		const next = this.open({
			onReady: () => {
				// 交接期間舊連線若已自行重連，this.conn 會是另一條，一併關掉
				clearTimeout(this.retryTimer);
				old?.close();

				if (this.conn !== old) this.conn?.close();

				this.conn = next;
			},
			onFailBeforeReady: () => next.close(),
		});

		setTimeout(() => {
			if (!next.ready) {
				this.log(`${this.label} handover timed out, keeping current connection`, 2);
				next.close();
			}
		}, READY_MS);
	}

	scheduleReconnect() {
		if (this.stopped) return;

		const delay = Math.min(this.reconnectDelay * 2 ** this.failures, BACKOFF_MAX_MS);
		this.failures++;
		clearTimeout(this.retryTimer);
		this.retryTimer = setTimeout(() => {
			if (!this.stopped) this.conn = this.open();
		}, delay);
		this.log(`${this.label} reconnecting in ${delay / 1000}s`, 2);
	}

	open({ onReady, onFailBeforeReady } = {}) {
		const balancedUrl = this.url();
		const controller = new AbortController();
		const conn = {
			ready  : false,
			closed : false,
			close  : () => {
				conn.closed = true;
				clearTimeout(stale);
				controller.abort();
			},
		};
		let stale;

		const touch = () => {
			clearTimeout(stale);
			stale = setTimeout(() => {
				this.log(`${this.label} no data for ${STALE_MS / 1000}s`, 2);
				controller.abort();
			}, STALE_MS);
		};

		const fail = (why) => {
			if (conn.closed) return;

			conn.closed = true;
			clearTimeout(stale);
			report(balancedUrl, false);
			this.log(`${this.label} ${why}`, 3);

			if (!conn.ready && onFailBeforeReady) return onFailBeforeReady();

			if (this.conn === conn) this.scheduleReconnect();
		};

		(async () => {
			touch();
			const res = await fetch(resolve(balancedUrl), {
				headers : { Accept: "text/event-stream", "Cache-Control": "no-cache" },
				cache   : "no-store",
				signal  : controller.signal,
			});

			if (!res.ok) throw new Error(`HTTP ${res.status}`);

			report(balancedUrl, true);
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let event = "";
			let data = [];

			for (;;) {
				const { value, done } = await reader.read();

				if (done) throw new Error("stream ended");

				touch();
				buffer += decoder.decode(value, { stream: true });
				let nl;

				while ((nl = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, nl).replace(/\r$/, "");
					buffer = buffer.slice(nl + 1);

					if (line === "") {
						if (data.length) {
							if (!conn.ready) {
								conn.ready = true;
								this.failures = 0;
								onReady?.();
							}

							try {
								this.onEvent(event || "message", data.join("\n"));
							} catch (err) {
								this.log(`${this.label} handler error: ${err}`, 3);
							}
						}

						event = "";
						data = [];
					} else if (line.startsWith(":")) {
						this.onComment(line.slice(1).trim());
					} else if (line.startsWith("event:")) {
						event = line.slice(6).trim();
					} else if (line.startsWith("data:")) {
						data.push(line.slice(5).replace(/^ /, ""));
					}
				}
			}
		})().catch((err) => fail(err?.name === "AbortError" ? "aborted" : String(err?.message ?? err)));

		return conn;
	}
}

module.exports = { SSEStream };
