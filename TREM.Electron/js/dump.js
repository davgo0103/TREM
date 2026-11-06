const $ = require("jquery");
const { app } = require("@electron/remote");
const fs = require("node:fs");
const path = require("node:path");

// 第一次啟動時這些資料夾還不存在（例如剛裝好的 macOS），要先建立才能寫入
// 路徑不會變，先記下來；每寫一行都同步問主程式的話，主程式忙時畫面也會跟著卡
const LOGS_DIR = app.getPath("logs");
const EEW_DIR = path.join(app.getPath("userData"), "EEW");

fs.mkdirSync(LOGS_DIR, { recursive: true });
fs.mkdirSync(EEW_DIR, { recursive: true });

const latestLog = path.join(LOGS_DIR, "latest.log");

// latest.log 記錄這次執行的主畫面；只有主畫面載入時清空，開設定、震度等其他視窗不能把它洗掉
if (location.pathname.endsWith("/MainView.html"))
	fs.writeFileSync(latestLog, "", { encoding: "utf8", flag: "w" });

// 寫檔先排隊，等這段程式跑完再一次寫出：速報流程上會連續記好幾行，
// 每行都同步寫檔的話（Windows 防毒掃描時每次可達數 ms）會延後畫面與音效
// 錯誤與視窗關閉前直接同步寫出，當掉或卡住時才不會少掉最後幾行
const pending = new Map();
let flushTimer = null;
let writing = Promise.resolve();

function queueWrite(file, text, now = false) {
	pending.set(file, (pending.get(file) ?? "") + text);

	if (now) return flushSync();

	flushTimer ??= setTimeout(flush, 0);
}

function takePending() {
	clearTimeout(flushTimer);
	flushTimer = null;

	const batch = [...pending];
	pending.clear();
	return batch;
}

function flush() {
	const batch = takePending();

	// 串起來依序寫，避免兩批同時寫同一個檔案時順序錯亂
	writing = writing.then(() => Promise.all(batch.map(([file, text]) => fs.promises.appendFile(file, text, "utf8")))).catch(() => void 0);
}

function flushSync() {
	for (const [file, text] of takePending())
		try {
			fs.appendFileSync(file, text, "utf8");
		} catch {
			// 寫不進去也不能讓呼叫端出錯
		}
}

window.addEventListener("beforeunload", flushSync);

function log_time_string() {
	const now = new Date();
	let _Now = now.getFullYear();
	_Now += "-";

	if ((now.getMonth() + 1) < 10) _Now += "0" + (now.getMonth() + 1);
	else _Now += (now.getMonth() + 1);
	_Now += "-";

	if (now.getDate() < 10) _Now += "0" + now.getDate();
	else _Now += now.getDate();
	_Now += "_";

	if (now.getHours() < 10) _Now += "0" + now.getHours();
	else _Now += now.getHours();
	return _Now;
}

function now_time(date) {
	const utc = date ? new Date(date) : new Date();
	const now = new Date(utc.getTime() + utc.getTimezoneOffset() * 60000 + 28800000);
	return now.getTime();
}

function time_to_string(date) {
	const now = new Date(date ? now_time(date) : now_time());
	let _Now = now.getFullYear();
	_Now += "/";

	if ((now.getMonth() + 1) < 10) _Now += "0" + (now.getMonth() + 1);
	else _Now += (now.getMonth() + 1);
	_Now += "/";

	if (now.getDate() < 10) _Now += "0" + now.getDate();
	else _Now += now.getDate();
	_Now += " ";

	if (now.getHours() < 10) _Now += "0" + now.getHours();
	else _Now += now.getHours();
	_Now += ":";

	if (now.getMinutes() < 10) _Now += "0" + now.getMinutes();
	else _Now += now.getMinutes();
	_Now += ":";

	if (now.getSeconds() < 10) _Now += "0" + now.getSeconds();
	else _Now += now.getSeconds();
	return _Now;
}

function removelog() {
	const list = fs.readdirSync(LOGS_DIR);
	let remove_logs = 0;

	for (let i = 0; i < list.length; i++)
		// 每個視窗都會執行清理，檔案可能已被其他視窗刪除
		try {
			const file = path.join(LOGS_DIR, list[i]);

			if (Date.now() - fs.statSync(file).ctimeMs > 86400 * 1000 * 7) {
				fs.rmSync(file, { force: true });
				remove_logs += 1;
			}
		} catch {
			// 已被其他視窗刪除
		}

	log(`remove: ${remove_logs} logs`, 1, "dump", "removelog");
}

function removeEEW() {
	const list = fs.readdirSync(EEW_DIR);
	let remove_EEW = 0;

	for (let i = 0; i < list.length; i++)
		try {
			const file = path.join(EEW_DIR, list[i]);

			if (Date.now() - fs.statSync(file).ctimeMs > 86400 * 1000 * 7) {
				fs.rmSync(file, { force: true });
				remove_EEW += 1;
			}
		} catch {
			// 已被其他視窗刪除
		}

	log(`remove: ${remove_EEW} EEW`, 1, "dump", "removeEEW");
}

const LogPath = () => path.join(LOGS_DIR, `${log_time_string()}.log`);

if (!fs.existsSync(LogPath())) {
	fs.writeFileSync(LogPath(), "");
	log(app.getVersion(), 2, "TREM", "version");
}

function log(msg, type = 1, sender = "main", fun = "unknow") {
	const _type = (type == 0) ? "Debug" : (type == 3) ? "Error" : (type == 2) ? "Warn" : "Info";
	const _msg = `[${_type}][${time_to_string()}][${sender}/${fun}]: ${msg}`;

	try {
		if (type == 3)
			console.log("\x1b[31m" + _msg + "\x1b[0m");
		else if (type == 2)
			console.log("\x1b[33m" + _msg + "\x1b[0m");
		else if (type == 1)
			console.log("\x1b[32m" + _msg + "\x1b[0m");
		else if (type == 0)
			console.debug("\x1b[34m" + _msg + "\x1b[0m");
	} catch (err) {
		console.log("\x1b[31m" + _msg + "\x1b[0m");
	}

	queueWrite(LogPath(), `${_msg}\r\n`, type == 3);
}

removelog();
removeEEW();

setInterval(() => {
	removelog();
	removeEEW();
}, 86400_000);

/**
 * Dump a message.
 * @param {DumpData} dumpData
 * @typedef {object} DumpData
 * @property {0|1|2|3} level 0: info, 1: warn, 2: error, 3: debug
 * @property {string} message Dump message.
 * @property {string} origin Dump origin.
 */
function dump(dumpData) {
	const now = new Date();
	const nowTime = (new Date(now.getTime() - (now.getTimezoneOffset() * 60000))).toISOString().slice(0, -1);
	console[[
		"log",
		"warn",
		"error",
		"debug",
	][dumpData.level]](`%c[${nowTime}]`, dumpData.level == 0 ? "color: rgba(255, 255, 255, .4)" : "", dumpData.origin + " >> " + dumpData.message);

	if (dumpData.level != 3)
		queueWrite(latestLog, `[${[
			"Log",
			"Warn",
			"Error",
			"Debug",
		][dumpData.level]}] [${nowTime}] [${dumpData.origin}]` + dumpData.message + "\r\n", dumpData.level == 2);
}
