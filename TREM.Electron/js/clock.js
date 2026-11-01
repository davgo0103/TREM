// 校時（參考 ExpTechTW/TREM-Lite lib/ntp.ts）
//
// 每 CALIBRATE_MS 量一次本機時鐘差，來回超過 MAX_RTT_MS 的結果不採用。
// 超過 TRUSTED_MS 都沒校時成功時，才改用 SSE 心跳的伺服器時間（精度約一秒）。
const CALIBRATE_MS = 600_000;
const HTTP_NTP = "https://lb.exptech.dev/ntp";
const MAX_RTT_MS = 1_000;
const TRUSTED_MS = 30 * 60_000;

let offset = 0;
let calibratedAt = -Infinity;
let logger = () => void 0;

/** 校正後的現在時間（ms）。 */
function realNow() {
	return Date.now() + offset;
}

async function syncClock() {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 3_000);
		const t1 = Date.now();
		const res = await fetch(HTTP_NTP, { cache: "no-store", signal: controller.signal });
		const t3 = Number((await res.text()).trim());
		const t4 = Date.now();
		clearTimeout(timer);

		if (!res.ok || !Number.isFinite(t3)) throw new Error(`HTTP ${res.status}`);

		if (t4 - t1 > MAX_RTT_MS) throw new Error(`rtt ${t4 - t1}ms > ${MAX_RTT_MS}ms`);

		offset = (t3 - t1 + (t3 - t4)) / 2;
		calibratedAt = performance.now();
		logger(`clock offset ${offset.toFixed(1)}ms, rtt ${t4 - t1}ms`, 1);
	} catch (err) {
		logger(`clock sync failed, keeping offset ${offset.toFixed(1)}ms: ${err}`, 2);
	}
}

/** SSE 心跳的伺服器時間（ms）；只在太久沒校時成功、且差距超過 5 秒時採用。 */
function adoptServerTime(serverMs) {
	if (performance.now() - calibratedAt < TRUSTED_MS) return;

	const next = serverMs - Date.now();

	if (Math.abs(next - offset) < 5_000) return;

	offset = next;
	logger(`clock sync failing, using server heartbeat: offset ${Math.round(offset)}ms`, 2);
}

let started = false;

function startClock(log) {
	if (log) logger = log;

	if (started) return;

	started = true;
	syncClock();
	setInterval(syncClock, CALIBRATE_MS);
}

module.exports = { realNow, adoptServerTime, startClock };
