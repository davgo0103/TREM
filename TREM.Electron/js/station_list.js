// 測站清單有兩份，ID 互不相通（參考 ExpTechTW/TREM-Lite resource.ts）：
// * static.core 的 CSV：16 進位 ID，與 SSE 即時資料一致
// * 舊版清單（api-1 /trem/station，GitHub 有鏡像）：10 進位 ID，只用來把舊設定換成最近的新測站
const STATION_URL = "https://static.core.exptech.dev/resource/station";
const LEGACY_STATION_URLS = ["https://api-1.exptech.dev/api/v1/trem/station", "https://raw.githubusercontent.com/exptechtw/api/master/resource/station.json"];
const CACHE_KEY = "station_csv";

// 新版測站清單為 CSV：loc_code,id,lat,lon,floor,code,net,time,work
function parseStationCSV(text) {
	const data = {};
	const lines = text.trim().split(/\r?\n/);
	const header = lines.shift().split(",").map((c) => c.trim());
	const col = (name) => header.indexOf(name);

	for (const line of lines) {
		const v = line.split(",").map((c) => c.trim());
		const id = v[col("id")];
		const lat = +v[col("lat")];
		const lon = +v[col("lon")];

		if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;

		// 新網路的 net 代號（3/4）無法對應舊的 SE-Net/MS-Net，一律視為一般測站
		data[id] = {
			net  : "SE-Net",
			info : [{ code: +v[col("code")], lat, lon, time: v[col("time")] }],
			work : col("work") === -1 ? true : v[col("work")] === "1",
		};
	}

	return data;
}

/**
 * 取得新版測站清單，成功時存進 localStorage；抓不到就用上次存的。
 * @returns {Promise<{ data: object, source: string, error?: Error }>}
 */
async function fetchStationList() {
	let error;

	try {
		const res = await fetch(STATION_URL);

		if (!res.ok) throw new Error(`HTTP ${res.status} ${STATION_URL}`);

		const text = await res.text();
		const data = parseStationCSV(text);

		if (Object.keys(data).length !== 0) {
			localStorage.setItem(CACHE_KEY, text);
			return { data, source: STATION_URL };
		}
	} catch (err) {
		error = err;
	}

	const cached = localStorage.getItem(CACHE_KEY);

	if (cached) return { data: parseStationCSV(cached), source: "cache", error };

	return { data: {}, source: "", error };
}

/** 舊網路的測站清單（10 進位 ID），只用於換算舊設定。 */
async function fetchLegacyStationList() {
	for (const url of LEGACY_STATION_URLS)
		try {
			const res = await fetch(url);

			if (!res.ok) continue;

			const data = await res.json();

			if (Object.keys(data).length !== 0) return data;
		} catch {
			// 換下一個來源
		}

	return {};
}

module.exports = { parseStationCSV, fetchStationList, fetchLegacyStationList };
