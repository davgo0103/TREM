const { getCurrentWindow } = require("@electron/remote");
const echarts = require("echarts");
const { fetchStationList } = require("../js/station_list.js");
const { SSEStream } = require("../js/sse.js");
const win = getCurrentWindow();

document.onreadystatechange = () => {
	if (document.readyState == "complete")
		handleWindowControls();
};

function handleWindowControls() {
	// Make minimise/maximise/restore/close buttons work when they are clicked
	document.getElementById("min-button").addEventListener("click", () => {
		win.minimize();
	});

	document.getElementById("max-button").addEventListener("click", () => {
		win.maximize();
	});

	document.getElementById("restore-button").addEventListener("click", () => {
		win.unmaximize();
	});

	document.getElementById("close-button").addEventListener("click", () => {
		win.close();
	});

	toggleMaxRestoreButtons();
	win.on("maximize", toggleMaxRestoreButtons);
	win.on("unmaximize", toggleMaxRestoreButtons);

	function toggleMaxRestoreButtons() {
		if (win.isMaximized())
			document.body.classList.add("maximized");
		else
			document.body.classList.remove("maximized");
	}
}

const wave_count = +localStorage.getItem("displayWaveCount") ?? 12;
let Realtimestation = app.Configuration.data["Real-time.station"];
let Realtimestation1 = app.Configuration.data["Real-time.station.1"];
let Realtimestation2 = app.Configuration.data["Real-time.station.2"];
let Realtimestation3 = app.Configuration.data["Real-time.station.3"];
let Realtimestation4 = app.Configuration.data["Real-time.station.4"];
let Realtimestation5 = app.Configuration.data["Real-time.station.5"];
let themecolor = app.Configuration.data["theme.color"];
let themedark = app.Configuration.data["theme.dark"];

let chartuuids = [
	Realtimestation1,
	Realtimestation2,
	Realtimestation3,
	Realtimestation4,
	Realtimestation5,
	Realtimestation,
	Realtimestation,
	Realtimestation,
];

// 波形來源：ES-Net 公開的 SSE，每個測站一條連線，Header 帶 key: 測站ID（參考 ExpTechTW/ES-Net-Wave）
const WAVE_SSE_URL = "https://bamboo.exptech.dev/api/sse/esnet";
const WAVE_WINDOW_MS = 120_000;
const wave_streams = new Map();

/**
 * 解析一筆波形資料「測站ID~base64」。0x10 為三軸加速度（gal，50 Hz，每包約 0.5 秒）：
 * [0]=0x10 [1]=筆數 [2..9]=時間（ms，uint64 LE） 之後每筆 x、y、z 各一個 float32 LE。
 * 0x11（震度與 PGA）不需要，略過。
 */
function parseWavePacket(text) {
	const [id, payload] = text.split("~");

	if (!payload) return null;

	const bytes = Buffer.from(payload, "base64");

	if (bytes.length < 10 || bytes[0] !== 0x10) return null;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const count = bytes[1];
	const X = [];
	const Y = [];
	const Z = [];

	for (let i = 0, offset = 10; i < count && offset + 12 <= bytes.length; i++, offset += 12) {
		X.push(view.getFloat32(offset, true));
		Y.push(view.getFloat32(offset + 4, true));
		Z.push(view.getFloat32(offset + 8, true));
	}

	return { id, time: Number(view.getBigUint64(2, true)), X, Y, Z };
}

/** 依目前設定的測站開關波形連線：新的測站開連線，不再使用的關掉。 */
function syncWaveStreams() {
	const ids = new Set([
		Realtimestation1,
		Realtimestation2,
		Realtimestation3,
		Realtimestation4,
		Realtimestation5,
		Realtimestation,
	]
		.map((uuid) => uuid?.split("-")[2])
		.filter(Boolean));

	for (const [id, stream] of wave_streams)
		if (!ids.has(id)) {
			stream.stop();
			wave_streams.delete(id);
		}

	for (const id of ids) {
		if (wave_streams.has(id)) continue;

		const stream = new SSEStream({
			label   : `wave ${id}`,
			url     : () => WAVE_SSE_URL,
			headers : { key: id },
			onEvent : (event, text) => {
				const packet = parseWavePacket(text);

				if (packet?.id === id) wave(packet);
			},
			log: (message, level) => {
				if (level >= 2) console.warn(message);
			},
		});
		stream.start();
		wave_streams.set(id, stream);
	}
}

const data = {
	stations: {},
};
const timer = {};

const Real_time_station_run = () => {
	chartuuids = [
		Realtimestation1,
		Realtimestation2,
		Realtimestation3,
		Realtimestation4,
		Realtimestation5,
		Realtimestation,
		Realtimestation,
		Realtimestation,
	];

	setCharts([
		Realtimestation1.split("-")[2],
		Realtimestation2.split("-")[2],
		Realtimestation3.split("-")[2],
		Realtimestation4.split("-")[2],
		Realtimestation5.split("-")[2],
		Realtimestation.split("-")[2],
		Realtimestation.split("-")[2],
		Realtimestation.split("-")[2],
	]);
	syncWaveStreams();
};

const Real_time_station = () => {
	try {
		const _data = [
			parseInt(Realtimestation1.split("-")[2]),
			parseInt(Realtimestation2.split("-")[2]),
			parseInt(Realtimestation3.split("-")[2]),
			parseInt(Realtimestation4.split("-")[2]),
			parseInt(Realtimestation5.split("-")[2]),
			parseInt(Realtimestation.split("-")[2]),
		];

		if (Realtimestation != app.Configuration.data["Real-time.station"]) {
			Realtimestation = app.Configuration.data["Real-time.station"];
			Real_time_station_run(_data);
		} else if (Realtimestation1 != app.Configuration.data["Real-time.station.1"]) {
			Realtimestation1 = app.Configuration.data["Real-time.station.1"];
			Real_time_station_run(_data);
		} else if (Realtimestation2 != app.Configuration.data["Real-time.station.2"]) {
			Realtimestation2 = app.Configuration.data["Real-time.station.2"];
			Real_time_station_run(_data);
		} else if (Realtimestation3 != app.Configuration.data["Real-time.station.3"]) {
			Realtimestation3 = app.Configuration.data["Real-time.station.3"];
			Real_time_station_run(_data);
		} else if (Realtimestation4 != app.Configuration.data["Real-time.station.4"]) {
			Realtimestation4 = app.Configuration.data["Real-time.station.4"];
			Real_time_station_run(_data);
		} else if (Realtimestation5 != app.Configuration.data["Real-time.station.5"]) {
			Realtimestation5 = app.Configuration.data["Real-time.station.5"];
			Real_time_station_run(_data);
		} else if (themecolor != app.Configuration.data["theme.color"]) {
			themecolor = app.Configuration.data["theme.color"];
			setCharts(_data);
		} else if (themedark != app.Configuration.data["theme.dark"]) {
			themedark = app.Configuration.data["theme.dark"];
			setCharts(_data);
		}
	} catch (error) {
		console.warn("Failed to load station data!", error);
	}
};

const fetch_files = async () => {
	try {
		// let res;
		// const s = {};

		station_v2_run((await fetchStationList()).data);

		// if (app.Configuration.data["Real-time.local"]) res = require(path.resolve(__dirname, "../station.json"));
		// else res = await (await fetch("https://raw.githubusercontent.com/ExpTechTW/API/master/Json/earthquake/station.json")).json();

		// if (!res) res = await (await fetch("https://cdn.jsdelivr.net/gh/ExpTechTW/API@master/Json/earthquake/station.json")).json();

		// if (!res) res = await (await fetch("https://exptech.com.tw/api/v1/file?path=/resource/station.json")).json();

		// if (res) {
		// 	for (let i = 0, k = Object.keys(res), n = k.length; i < n; i++) {
		// 		const id = k[i];

		// 		if (res[id].Long > 118)
		// 			s[id.split("-")[2]] = { uuid: id, ...res[id] };
		// 	}

		// 	data.stations = s;
		// }
	} catch (error) {
		console.warn("Failed to load station data!", error);
	}
};

function station_v2_run(station_data) {
	for (let k = 0, k_ks = Object.keys(station_data), n = k_ks.length; k < n; k++) {
		const station_id = k_ks[k];
		const station_ = station_data[station_id];

		//	if (!station_.work) continue;

		const station_net = station_.net === "MS-Net" ? "H" : "L";

		let station_new_id = "";
		let station_code = "000";
		let Loc = "";
		let area = "";
		let Lat = 0;
		let Long = 0;

		let latest = station_.info[0];

		if (station_.info.length > 1)
			for (let i = 1; i < station_.info.length; i++) {
				const currentTime = new Date(station_.info[i].time);
				const latestTime = new Date(latest.time);

				if (currentTime > latestTime)
					latest = station_.info[i];
			}

		for (let i = 0, ks = Object.keys(TREM.Resources.regionv2), j = ks.length; i < j; i++) {
			const reg_id = ks[i];
			const reg = TREM.Resources.regionv2[reg_id];

			for (let r = 0, r_ks = Object.keys(reg), l = r_ks.length; r < l; r++) {
				const ion_id = r_ks[r];
				const ion = reg[ion_id];

				if (ion.code === latest.code) {
					station_code = latest.code.toString();
					Loc = `${reg_id} ${ion_id}`;
					area = ion.area;
					Lat = latest.lat;
					Long = latest.lon;
				}
			}
		}

		station_new_id = `${station_net}-${station_code}-${station_id}`;

		if (station_code === "000") {
			Lat = latest.lat;
			Long = latest.lon;

			if (station_id === "13379360") {
				Loc = "重庆市 北碚区";
				area = "重庆市中部";
			} else if (station_id === "7363648") {
				Loc = "南楊州市 和道邑";
				area = "南楊州市中部";
			}
		}

		data.stations[station_id] = { uuid: station_new_id, Lat, Long, Loc, area };
	}
}

const charts = [
	echarts.init(document.getElementById("wave-1"), null, { height: 560 / 6, width: 400, renderer: "svg" }),
	echarts.init(document.getElementById("wave-2"), null, { height: 560 / 6, width: 400, renderer: "svg" }),
	echarts.init(document.getElementById("wave-3"), null, { height: 560 / 6, width: 400, renderer: "svg" }),
	echarts.init(document.getElementById("wave-4"), null, { height: 560 / 6, width: 400, renderer: "svg" }),
	echarts.init(document.getElementById("wave-5"), null, { height: 560 / 6, width: 400, renderer: "svg" }),
	echarts.init(document.getElementById("wave-6"), null, { height: 560 / 6, width: 400, renderer: "svg" }),
	echarts.init(document.getElementById("wave-7"), null, { height: 560 / 6, width: 400, renderer: "svg" }),
	echarts.init(document.getElementById("wave-8"), null, { height: 560 / 6, width: 400, renderer: "svg" }),
];
const chartdata = [
	[],
	[],
	[],
	[],
	[],
	[],
	[],
	[],
];

for (let i = 0; i < wave_count; i++) {
	const dom = document.createElement("div");
	document.getElementById("wave-container").append(dom);
	charts.push(echarts.init(dom, null, { height: 560 / wave_count, width: 400 }));
	chartdata.push([]);
}

/**
 * @param {string[]} ids
 */
const setCharts = (ids) => {
	for (let i = 0; i < 8; i++)
		if (data.stations?.[ids[i]]?.uuid) {
			if (chartuuids[i] != data.stations[ids[i]].uuid) {
				chartuuids[i] = data.stations[ids[i]].uuid;
				chartdata[i] = [];
			}

			if (i >= 5)
				charts[i].setOption({
					title: {
						text: `${data.stations[ids[i]].Loc} | ${chartuuids[i]} | ${(i == 5) ? "X" : (i == 6) ? "Y" : (i == 7) ? "Z" : ""}`,
					},
				});
			else
				charts[i].setOption({
					title: {
						text: `${data.stations[ids[i]].Loc} | ${chartuuids[i]}`,
					},
				});
		} else {
			chartuuids[i] = null;
			charts[i].clear();
			charts[i].setOption({
				title: {
					textStyle: {
						fontSize : 10,
						color    : (themedark ? "rgb(230, 225, 229)" : "rgb(26, 28, 25)"),
					},
				},
				xAxis: {
					type      : "time",
					splitLine : {
						show: false,
					},
					show: false,
				},
				yAxis: {
					type      : "value",
					animation : false,
					splitLine : {
						show: false,
					},
					axisLabel: {
						interval : 1,
						fontSize : 10,
					},
				},
				grid: {
					top    : 16,
					right  : 0,
					bottom : 0,
				},
				series: [
					{
						type       : "line",
						showSymbol : false,
						data       : [],
						color      : themecolor,
					},
				],
			});
		}
};

const wave = (wave_data) => {
	const n = wave_data.Z.length;

	if (!n) return;

	const step = 500 / n;
	const cutoff = wave_data.time + 500 - WAVE_WINDOW_MS;

	const draw = (j, values) => {
		for (let i = 0; i < n; i++)
			chartdata[j].push({
				name  : wave_data.time,
				value : [wave_data.time + i * step, Math.round(values[i] * 1000) / 1000],
			});

		while (chartdata[j].length && chartdata[j][0].value[0] < cutoff)
			chartdata[j].shift();

		// 未滿兩分鐘時在最前面補一個空點，讓 X 軸固定顯示兩分鐘
		if (!chartdata[j].length || chartdata[j][0].value[0] > cutoff)
			chartdata[j].unshift({ name: cutoff, value: [cutoff, null] });

		// Y 軸範圍取最大振幅並往上取到 0.5 的倍數（刻度較整齊），最小 ±1 gal
		let peak = 0;

		for (const v of chartdata[j])
			if (v.value[1] != null && Math.abs(v.value[1]) > peak) peak = Math.abs(v.value[1]);

		const maxmin = Math.max(1, Math.ceil(peak * 2) / 2);

		charts[j].setOption({
			animation : false,
			yAxis     : { max: maxmin, min: -maxmin },
			series    : [
				{
					type     : "line",
					sampling : "lttb",
					data     : chartdata[j],
				},
			],
		});
	};

	for (let j = 0; j < 5; j++)
		if (chartuuids[j]?.split("-")[2] === wave_data.id) draw(j, wave_data.Z);

	if (Realtimestation?.split("-")[2] === wave_data.id) {
		draw(5, wave_data.X);
		draw(6, wave_data.Y);
		draw(7, wave_data.Z);
	}
};

async function init() {
	await (async () => {
		await fetch_files();

		if (!timer.stations)
			timer.stations = setInterval(fetch_files, 300_000);

		if (!timer.Realtimestation)
			timer.Realtimestation = setInterval(Real_time_station, 1_000);
	})().catch(e => {
		log(e, 3, "rts", "init");
		dump({ level: 2, message: e });
	});
	setCharts([
		Realtimestation1.split("-")[2],
		Realtimestation2.split("-")[2],
		Realtimestation3.split("-")[2],
		Realtimestation4.split("-")[2],
		Realtimestation5.split("-")[2],
		Realtimestation.split("-")[2],
		Realtimestation.split("-")[2],
		Realtimestation.split("-")[2],
	]);
	for (const chart of charts)
		chart.setOption({
			title: {
				textStyle: {
					fontSize : 10,
					color    : (themedark ? "rgb(230, 225, 229)" : "rgb(26, 28, 25)"),
				},
			},
			xAxis: {
				type      : "time",
				splitLine : {
					show: false,
				},
				show: false,
			},
			yAxis: {
				type      : "value",
				animation : false,
				splitLine : {
					show: false,
				},
				axisLabel: {
					interval : 1,
					fontSize : 10,
				},
			},
			grid: {
				top    : 16,
				right  : 0,
				bottom : 0,
			},
			series: [
				{
					type       : "line",
					showSymbol : false,
					data       : [],
					color      : themecolor,
				},
			],
		});

	syncWaveStreams();
}
