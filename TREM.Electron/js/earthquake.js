/* eslint-disable no-mixed-spaces-and-tabs */
/* eslint-disable no-undef */
require("leaflet");
require("leaflet-edgebuffer");
require("leaflet-geojson-vt");
const vtLayer = require("../js/vt_layer.js");
require("expose-gc");
const { BrowserWindow, shell } = require("@electron/remote");
const { setTimeout, setInterval, clearTimeout, clearInterval } = require("node:timers");
const Route = require("../js/route.js");
const { fetchStationList, fetchLegacyStationList } = require("../js/station_list.js");
const { SSEStream } = require("../js/sse.js");
const { apiFetch, startProbing, setLogger: setEndpointLogger } = require("../js/endpoints.js");
const { realNow, adoptServerTime, startClock } = require("../js/clock.js");
const { sendWebhook, refreshWebhookImage, hasWebhookMessage } = require("../js/webhook.js");
const ReplayData = require("../js/replay_data.js");
const route = new Route();

// 版本不會變，先記下來；不然每 0.5 秒都要同步問一次主程式
const APP_VERSION = app.getVersion();

// 告訴主程式畫面還活著；太久沒回報時主程式會重新載入，避免卡住時收不到警報
setInterval(() => ipcRenderer.send("renderer:heartbeat"), 5_000);

const JSZip = require("jszip");

TREM.Audios = {
	pga1   : new Audio("../audio/PGA1.wav"),
	pga2   : new Audio("../audio/PGA2.wav"),
	int0   : new Audio("../audio/Shindo0.wav"),
	int1   : new Audio("../audio/Shindo1.wav"),
	int2   : new Audio("../audio/Shindo2.wav"),
	eew    : new Audio("../audio/EEW.wav"),
	note   : new Audio("../audio/Note.wav"),
	update : new Audio("../audio/Update.wav"),
	areav2 : new Audio("../audio/1/update.wav"),
};
TREM.AudioContext = new AudioContext({});
TREM.Constants = require(path.resolve(__dirname, "../Constants/Constants.js"));
TREM.Earthquake = new EventEmitter();
TREM.EEW = new Map();
TREM.Utils = require(path.resolve(__dirname, "../Utils/Utils.js"));
localStorage.dirname = __dirname;

const speecd_use = setting["audio.tts"] ?? false;

// #region 變數
const MapData = {};
const Timers = {};
let rts_remove_eew = false;
let UserLocationLat = 25.0421407;
let UserLocationLon = 121.5198716;
const audio = { main: [], minor: [], main_lock: false, minor_lock: false };
const EarthquakeList = {};
let marker = null;
let marker_report = null;

/**
 * @type {{main: L.Map, mini: L.Map, report: L.Map, intensity: L.Map}}
 */
const Maps = { main: null, mini: null, report: null, intensity: null };

/**
 * @type { {[key: string]: Map<string, maplibregl.StyleLayer>} }
 */
let MapBases = { main: new Map(), mini: new Map(), report: new Map(), intensity: new Map() };
const Station = {};
const detected_box_list = {};
const detected_list = {};
let Cancel = false;
let Canceltime = 0;
let RMT = 1;
let PGALimit = 0;
let PGAtag = -1;
let intensitytag = -1;
let MAXPGA = { pga: 0, station: "NA", level: 0 };
let IMAXdata = {};
let level_list = {};
let Info = { Notify: [], Warn: [], Focus: [] };
const Focus = [
	23.608428,
	121.699168,
	7.75,
];
let INFO = [];
let TINFO = 0;
let Report = 0;
let server_timestamp;

try {
	server_timestamp = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "server.json")).toString());
} catch (error) {
	server_timestamp = [];
}

let Location;
const station = {};
let station_data = {};
let palert_geojson = null;
let areav2_geojson = null;
let investigation = false;
let ReportTag = 0;
let EEWshot = 0;
let EEWshotC = 0;
let Response = {};
let replay = 0;
let replayT = 0;
let replayD = false;
let replayF = false;
let replayTemp = 0;
let replaydir = 0;
let replaytestEEW = 0;
TREM.toggleNavTime = 0;
let mapLock = false;
let eew = {};
const eewt = { id: 0, time: 0 };
let TSUNAMI = {};
let Ping = "N/A";
let EEWAlert = false;
let PGACancel = false;
let report_get_timestamp = Date.now();
let report_newest_check = Date.now();
let map_move_back = false;
TREM.set_report_overview = 0;
let rtstation1 = "";
TREM.win = BrowserWindow.fromId(process.env.window * 1);
let stationnow = 0;
let stationnowall = 0;
let RMTpgaTime = 0;
let type_Unit = "";
// 原本由 winserver.jar（已移除）宣告、仍被既有程式讀取的全域變數。
// 舊 WebSocket 與金鑰驗證已不存在，即時資料一律走 SSE。
const rts_ws2_timestamp = 0;
const rts_response_new = {};
let rts_ws_timestamp = 0;
let rts_response = {};

/**
 * P 波、S 波走時（秒），原本由 winserver.jar 提供，取自 TREM 公開原始碼的同一演算法。
 * @param {number} depth 震源深度（km）
 * @param {number} distance 震央距（km）
 * @returns {{ Ptime: number, Stime: number }}
 */
function _speed(depth, distance) {
	const Za = 1 * depth;
	let G0, G;
	const Xb = distance;

	if (depth <= 40) {
		G0 = 5.10298;
		G = 0.06659;
	} else {
		G0 = 7.804799;
		G = 0.004573;
	}

	const Zc = -1 * (G0 / G);
	const Xc = (Math.pow(Xb, 2) - 2 * (G0 / G) * Za - Math.pow(Za, 2)) / (2 * Xb);
	let Theta_A = Math.atan((Za - Zc) / Xc);

	if (Theta_A < 0) Theta_A = Theta_A + Math.PI;

	Theta_A = Math.PI - Theta_A;
	const Theta_B = Math.atan(-1 * Zc / (Xb - Xc));
	let Ptime = (1 / G) * Math.log(Math.tan((Theta_A / 2)) / Math.tan((Theta_B / 2)));
	const G0_ = G0 / 1.732;
	const G_ = G / 1.732;
	const Zc_ = -1 * (G0_ / G_);
	const Xc_ = (Math.pow(Xb, 2) - 2 * (G0_ / G_) * Za - Math.pow(Za, 2)) / (2 * Xb);
	let Theta_A_ = Math.atan((Za - Zc_) / Xc_);

	if (Theta_A_ < 0) Theta_A_ = Theta_A_ + Math.PI;

	Theta_A_ = Math.PI - Theta_A_;
	const Theta_B_ = Math.atan(-1 * Zc_ / (Xb - Xc_));
	let Stime = (1 / G_) * Math.log(Math.tan(Theta_A_ / 2) / Math.tan(Theta_B_ / 2));

	if (distance / Ptime > 7) Ptime = distance / 7;

	if (distance / Stime > 4) Stime = distance / 4;

	return { Ptime, Stime };
}

let HTTP = false;
let NewReportTag = "";
// #endregion

TREM.Detector = {
	canvas : !!window.CanvasRenderingContext2D,
	webgl  : (function() {
		try {
			const canvas = document.createElement("canvas");
			return !!(window.WebGLRenderingContext && (canvas.getContext("webgl") || canvas.getContext("experimental-webgl")));
		} catch (e) {
			return false;
		}
	})(),
};

// 先把新的色塊圖層畫好再移除舊的，換圖層時才不會出現一瞬間的空白（閃爍）
function replaceLayer(oldLayer, newLayer, map) {
	newLayer.addTo(map);

	if (!oldLayer) return;

	let removed = false;

	const remove = () => {
		if (removed) return;

		removed = true;
		oldLayer.remove();
	};

	newLayer.once("load", remove);
	setTimeout(remove, 1000);
}

TREM.MapIntensity = {
	isTriggered : false,
	trem        : false,
	alertTime   : 0,
	MaxI        : -1,
	intensities : new Map(),
	description : "",
	expected(expected) {
		const int = new Map();
		const PLoc = {};

		for (const [towncode, exp] of expected) {
			int.set(towncode, exp.intensity.value);
			PLoc[towncode] = exp.intensity.value;
		}

		if (palert_geojson != null)
			palert_geojson.remove();

		palert_geojson = vtLayer(MapData.tw_town, {
			minZoom   : 4,
			maxZoom   : 15,
			tolerance : 20,
			buffer    : 256,
			debug     : 0,
			zIndex    : 5,
			style     : (properties) => {
				const name = properties.TOWNCODE;

				if (PLoc[name] == 0 || PLoc[name] == undefined)
					return {
						color       : "transparent",
						weight      : 0,
						opacity     : 0,
						fillColor   : "transparent",
						fillOpacity : 0,
					};
				return {
					color       : TREM.Colors.secondary,
					weight      : 0.8,
					fillColor   : TREM.color(PLoc[name]),
					fillOpacity : 1,
				};
			},
		}).addTo(Maps.main);
	},
	clear() {
		log("Clearing P-Alert map", 1, "P-Alert", "palert");
		dump({ level: 0, message: "Clearing P-Alert map", origin: "P-Alert" });

		this.alertTime = 0;
		this.MaxI = -1;
		this.isTriggered = false;
		this.description = "";

		if (palert_geojson != null) {
			palert_geojson.remove();
			palert_geojson = null;
		}
	},
};

TREM.PWS = {
	cache: new Map(),
	addPWS(rawPWSData) {
		const id = rawPWSData.link.href.slice(15);

		if (!id.length) return;
		const pws = {
			id,
			title       : rawPWSData.title,
			sender      : rawPWSData.sender.value,
			description : rawPWSData.description.$t,
			area        : rawPWSData.area.areaDesc,
			areaCodes   : TREM.Utils.findRegions(rawPWSData.area.areaDesc),
			sentTime    : new Date(rawPWSData.sent.slice(0, rawPWSData.sent.length - 3)),
			expireTime  : new Date(rawPWSData.expires.slice(0, rawPWSData.expires.length - 3)),
			url         : rawPWSData.link.href,
			timer       : null,
			marker      : {},
			areav2      : {},
		};
		log(`${pws.description}`, 1, "PWS", "addPWS");
		dump({ level: 0, message: `${pws.description}`, origin: "PWS" });

		if (Date.now() > pws.expireTime.getTime()) return;

		let areaconst = 0;

		for (const area of pws.areaCodes)
			if (area.town) {
				pws.marker[areaconst] = L.marker([area.latitude, area.longitude], {
					icon     : L.divIcon({ html: "<img src=\"../image/warn.png\" height=\"32\" width=\"32\"></img>" }),
					keyboard : false,
				})
					.addTo(Maps.main)
					.bindPopup(`<div><strong>${pws.title}</strong>\n發報單位：${pws.sender}\n內文：${pws.description}\n發報時間：${timeconvert(pws.sentTime).format("YYYY/MM/DD HH:mm:ss")}\n失效時間：${timeconvert(pws.expireTime).format("YYYY/MM/DD HH:mm:ss")}\n\n<span class="url" onclick="openURL('${pws.url}')">報告連結</span></div>`, {
						offset    : [8, 0],
						permanent : false,
						className : "marker-popup pws-popup",
					});
				pws.areav2[areaconst] = vtLayer(MapData.tw_town, {
					minZoom   : 4,
					maxZoom   : 15,
					tolerance : 20,
					buffer    : 256,
					debug     : 0,
					zIndex    : 5,
					style     : (properties) => {
						const name = properties.TOWNCODE;

						if (area.code != name)
							return {
								color       : "transparent",
								weight      : 0,
								opacity     : 0,
								fillColor   : "transparent",
								fillOpacity : 0,
							};
						return {
							color       : "#efcc00",
							weight      : 3,
							fillColor   : "transparent",
							fillOpacity : 0,
						};
					},
				}).addTo(Maps.main);
				areaconst += 1;
			}

		pws.timer = setTimeout(TREM.PWS.clear, pws.expireTime.getTime() - Date.now(), id);

		TREM.PWS.cache.set(id, pws);
	},
	clear(pwsId) {
		if (pwsId) {
			const pws = TREM.PWS.cache.get(pwsId);

			if (!pws) return;
			log(`Clearing PWS id ${pwsId}`, 1, "PWS", "clear");
			dump({ level: 0, message: `Clearing PWS id ${pwsId}`, origin: "PWS" });
			let areaconst = 0;

			for (const area of pws.areaCodes)
				if (area.town && pws.marker) {
					pws.marker[areaconst].remove();
					delete pws.marker[areaconst];
					pws.areav2[areaconst].remove();
					delete pws.areav2[areaconst];
					areaconst += 1;
				}

			if (pws.timer) {
				clearTimeout(pws.timer);
				delete pws.timer;
			}

			TREM.PWS.cache.delete(pwsId);
		} else if (TREM.PWS.cache.size) {
			log("Clearing PWS map", 1, "PWS", "clear");
			dump({ level: 0, message: "Clearing PWS map", origin: "PWS" });

			for (const [id, pws] of TREM.PWS.cache)
				if (pws.timer) {
					clearTimeout(pws.timer);
					delete pws.timer;
				}

			TREM.PWS.cache = new Map();
		}
	},
};

TREM.MapArea = {
	cache      : new Map(),
	isVisible  : false,
	blinkTimer : null,
	setArea(id, intensity) {
		if (this.cache.get(id) == intensity) return;
		Maps.main.setFeatureState({
			source: "Source_area",
			id,
		}, { intensity });
		this.cache.set(id, intensity);
		this.show();

		if (!this.blinkTimer)
			this.blinkTimer = setInterval(() => {
				if (this.isVisible)
					this.hide();
				else
					this.show();
			}, 500);
	},
	clear(id) {
		if (id) {
			Maps.main.removeFeatureState({ source: "Source_area", id });
			this.cache.delete(id);
		} else {
			Maps.main.removeFeatureState({ source: "Source_area" });
			delete this.cache;
			this.cache = new Map();
		}

		if (!this.cache.size) {
			if (this.blinkTimer)
				clearTimeout(this.blinkTimer);
			delete this.blinkTimer;
			this.hide();
		}
	},
	show() {
		Maps.main.setLayoutProperty("Layer_area", "visibility", "visible");
		this.isVisible = true;
	},
	hide() {
		Maps.main.setLayoutProperty("Layer_area", "visibility", "none");
		this.isVisible = false;
	},
};

TREM.MapArea2 = {
	cache       : new Map(),
	isVisible   : false,
	isTriggered : false,
	blinkTimer  : null,
	timer       : null,
	PLoc        : {},
	setArea(Json) {
		// console.log(Json);

		const max_intensity_list = {};

		for (let index = 0, keys = Object.keys(station), n = keys.length; index < n; index++) {
			const uuid = keys[index];
			const current_station_data = station[uuid];
			const current_data = Json[uuid.split("-")[2]];
			const Alert = current_data?.alert ?? false;

			if (Alert) {
				max_intensity_list[current_station_data.area] ??= rtsIntensityLevel(current_data.i);

				if (max_intensity_list[current_station_data.area] < rtsIntensityLevel(current_data.i)) {
					max_intensity_list[current_station_data.area] = rtsIntensityLevel(current_data.i);
					this.cache.set(current_station_data.area, rtsIntensityLevel(current_data.i));
				} else if (!max_intensity_list[current_station_data.area]) {
					max_intensity_list[current_station_data.area] = rtsIntensityLevel(current_data.i);
					this.cache.set(current_station_data.area, rtsIntensityLevel(current_data.i));
				} else {
					this.cache.set(current_station_data.area, max_intensity_list[current_station_data.area]);
				}
			}
		}

		const PLoc = {};

		for (const areav2 of Json.area) {
			const intensity = this.cache.get(areav2) ?? 1;

			for (let id = 0; id < Object.keys(TREM.Resources.areav2).length; id++) {
				const key = Object.keys(TREM.Resources.areav2)[id];

				if (areav2 == key)
					for (let id1 = 0; id1 < Object.keys(TREM.Resources.areav2[key]).length; id1++)
						PLoc[TREM.Resources.areav2[key][id1]] = intensity;
			}
		}

		// 即時資料每 0.5 秒一筆，範圍與震度沒變就不重畫
		const signature = JSON.stringify(PLoc);

		if (areav2_geojson == null || signature != this.signature) {
			this.signature = signature;
			this.PLoc = PLoc;
			const old = areav2_geojson;

			areav2_geojson = vtLayer(MapData.tw_town, {
				minZoom   : 4,
				maxZoom   : 15,
				tolerance : 20,
				buffer    : 256,
				debug     : 0,
				zIndex    : 5,
				style     : (properties) => {
					const name = properties.TOWNCODE;

					if (PLoc[name] == 0 || PLoc[name] == undefined)
						return {
							color       : "transparent",
							weight      : 0,
							opacity     : 0,
							fillColor   : "transparent",
							fillOpacity : 0,
						};
					return {
						color       : TREM.Colors.secondary,
						weight      : 0.8,
						fillColor   : TREM.color(PLoc[name]),
						fillOpacity : 1,
					};
				},
			});
			replaceLayer(old, areav2_geojson, Maps.main);
		}

		this.isTriggered = true;

		if (this.timer)
			this.timer.refresh();
		else
			this.timer = setTimeout(() => this.clear(), 10_000);
	},
	clear(id) {
		if (id) {
			this.cache.delete(id);
		} else {
			delete this.cache;
			this.cache = new Map();
		}

		if (this.timer) {
			clearTimeout(this.timer);
			delete this.timer;
		}

		// if (!this.cache.size) {
		// 	if (this.blinkTimer)
		// 		clearTimeout(this.blinkTimer);
		// 	delete this.blinkTimer;
		// }

		if (areav2_geojson != null) {
			areav2_geojson.remove();
			areav2_geojson = null;
			this.PLoc = {};
			this.signature = null;
		}

		this.isTriggered = false;
		this.isVisible = false;
	},
	show() {
		this.isVisible = true;
	},
	hide() {
		this.isVisible = false;
	},
};

class EEW {
	constructor(data) {
		this.#fromJson(data);
	}

	get full() {
		return (
			this.id != undefined
			&& this.depth != undefined
			&& this.epicenter != undefined
			&& this.location != undefined
			&& this.magnitude != undefined
			&& this.source != undefined
			&& (this.location && this.location != "未知區域")
		) ? true : false;
	}

	get local() {
		return this._expected.get(this._local.code);
	}

	get arrivalTime() {
		return (this.local.distance - (Date.now() - this.eventTime.getTime() * this._wavespeed.s)) / this._wavespeed.s;
	}

	#fromJson(data) {
		this.id = data.id;
		this.depth = data.depth;
		this.epicenter = { latitude: data.lat, longitude: data.lon };
		this.location = data.location;
		this.magnitude = data.scale;
		this.source = data.Unit;

		if (data.number > (this.version || 0)) {
			this._expected = new Map();
			this.#evalExpected();
		}

		this.version = data.number;

		this.eventTime = new Date(data.time);
		this.apiTime = new Date(data.timeStamp);

		this._alert = data.Alert;
		this._from = data.data_unit;
		this._receiveTime = new Date(data.timestamp);
		this._replay = data.replay_time;
	}

	#evalExpected() {
		for (const city in TREM.Resources.region)
			for (const town in TREM.Resources.region[city]) {
				const l = TREM.Resources.region[city][town];
				const d = TREM.Utils.twoSideDistance(
					TREM.Utils.twoPointDistance(
						{ lat: l.latitude, lon: l.longitude },
						{ lat: this.epicenter.latitude, lon: this.epicenter.longitude },
					),
					this.depth,
				);
				const pga = TREM.Utils.pga(
					this.magnitude,
					d,
					setting["earthquake.siteEffect"] ? l.siteEffect : undefined,
				);
				const i = TREM.Utils.PGAToIntensity(pga);

				if (setting["location.city"] == city && setting["location.town"] == town)
					this._local = l;

				this._expected.set(l.code, { distance: d, intensity: i, pga });
			}
	}

	update(data) {
		this.#fromJson(data);
	}
}

// #region 初始化

const folder = path.join(app.getPath("userData"), "data");

if (!fs.existsSync(folder))
	fs.mkdirSync(folder);

const win = TREM.win;
const roll = document.getElementById("rolllist");
let rtsRollHidden = false;
win.setAlwaysOnTop(false);

/**
 * 依設定把主視窗叫到前面：顯示（不搶焦點）、蓋到最上層、工作列閃爍
 * 交給主程序一次做完；win.* 是 @electron/remote 的同步呼叫，每個都要等主程序回應，速報時會延後畫面與音效
 * @param {{ show?: boolean, cover?: boolean, flash?: boolean }} options
 */
function raiseMainWindow({ show = false, cover = false, flash = false }) {
	if (show || cover || flash) ipcRenderer.send("window:raise", { show, cover, flash });
}

// 內容沒變就不寫：即使字串相同，寫 innerText／className 也會換掉節點或重算樣式；時鐘、速報資訊每秒都會更新
function setText(el, text) {
	// 跟之前的 jQuery .text(undefined) 一樣：沒有值就不動
	if (text == null) return;

	text = String(text);

	if (el && el.textContent !== text) el.textContent = text;
}

function setClassName(el, className) {
	if (el && el.className !== className) el.className = className;
}

let fullscreenTipTimeout;
win.on("enter-full-screen", () => {
	$("#fullscreen-notice").addClass("show");

	if (fullscreenTipTimeout) clearTimeout(fullscreenTipTimeout);

	fullscreenTipTimeout = setTimeout(() => {
		$("#fullscreen-notice").removeClass("show");
	}, 3_000);
});

win.on("leave-full-screen", () => {
	$("#fullscreen-notice").removeClass("show");

	if (fullscreenTipTimeout) clearTimeout(fullscreenTipTimeout);
});

async function init() {
	const progressbar = document.getElementById("loading_progress");
	const progressStep = 5;
	// report_get_timestamp = 0;

	// TREM.MapRenderingEngine = setting["map.engine"];

	// 啟動時沒有網路也照常啟動，網路恢復後串流會自動連上
	if (!window.navigator.onLine)
		log("Starting offline, streams will connect when the network is back", 2, "Initialization", "init");

	// Connect to server
	try {
		$("#loading").text(TREM.Localization.getString("Application_Connecting"));
		log("Trying to connect to the server...", 1, "ResourceLoader", "init");
		dump({ level: 0, message: "Trying to connect to the server...", origin: "ResourceLoader" });
		progressbar.value = (1 / progressStep) * 1;
	} catch (e) {
		log(e, 3, "ResourceLoader", "init");
		dump({ level: 2, message: e });
	}

	// Timers
	(() => {
		$("#loading").text(TREM.Localization.getString("Application_Loading"));
		const time = document.getElementById("time");
		const time1 = document.getElementById("time1");

		const now_format = (time_now) => timeconvert(time_now).format("YYYY/MM/DD HH:mm:ss");

		// clock
		log("Initializing clock", 1, "Clock", "init");
		dump({ level: 0, message: "Initializing clock", origin: "Clock" });

		let lastIntensityLog = "";

		if (!Timers.clock)
			Timers.clock = setInterval(() => {
				if (isRtsDesynced() && replayTemp == 0 && replay == 0) {
					if (!time.classList.contains("desynced"))
						time.classList.add("desynced");
					// 停在最後收到即時資料的時間，一眼看出資料從何時中斷
					const now_f = now_format(rts_response?.time ? new Date(rts_response.time) : NOW());
					setText(time, now_f);
					setText(time1, now_f);
				} else if (replayTemp) {
					if (!time.classList.contains("replay"))
						time.classList.add("replay");
					setText(time, now_format(new Date(replayTemp)));

					// if (NOW().getTime() - replayT > 180_000 && !Object.keys(eew).length) {
					if ((replayTemp - replay) > 300_000) {
						replayTemp = 0;
						stopReplay();
					}
				} else if (replay) {
					if (!time.classList.contains("replay"))
						time.classList.add("replay");
					setText(time, now_format(new Date(replay + (NOW().getTime() - replayT))));

					// if (NOW().getTime() - replayT > 180_000 && !Object.keys(eew).length) {
					if (NOW().getTime() - replayT > 300_000) {
						replayT = 0;
						stopReplay();
					}
				} else {
					if (time.classList.contains("replay"))
						time.classList.remove("replay");

					if (time.classList.contains("desynced"))
						time.classList.remove("desynced");

					const now_f = now_format(NOW());
					setText(time, now_f);
					setText(time1, now_f);

					if (replaytestEEW != 0 && NOW().getTime() - replaytestEEW > 300_000) {
						replaytestEEW = 0;
						stopReplay();
					}

					if (TREM.toggleNavTime != 0 && NOW().getTime() - TREM.toggleNavTime > 5_000) {
						toggleNav(false);
						globalgc();
					}
				}

				let GetDataState = "";
				let Warn = "";

				// 0：地震速報串流中斷；1：即時資料串流中斷
				if (!eew_sse?.connected) Warn += "0";

				if (!trem_sse?.connected) Warn += "1";

				Warn = ((Warn == "") ? "" : ` | 📛 ${Warn}`);

				if (type_Unit == "http") GetDataState += "🟩 Http";

				else if (type_Unit == "p2p") GetDataState += "🟦 P2P";

				else if (type_Unit == "p2pv6") GetDataState += "🟦 P2Pv6";

				else if (type_Unit == "websocket_yayacat") GetDataState += "⬜ WSY";

				else if (type_Unit == "websocket") GetDataState += "⬜ WS";

				else if (type_Unit == "websocket_backup") GetDataState += "⬜ WSB";

				else if (type_Unit == "fcm") GetDataState += "🟥 FCM";

				else if (type_Unit == "cache") GetDataState += "🟩 Cache";

				type_Unit = "";

				if (setting["stream.mode"]) GetDataState += "⏺";

				// if (GetData_time) {
				// 	GetData_time = false;
				// 	GetDataState += "⏰";
				// }

				// win.on("show", () => sleep(false));
				// win.on("hide", () => sleep(true));
				// win.on("minimize", () => sleep(true));
				// win.on("restore", () => sleep(false));

				// const stationall = Object.keys(station).length;
				const stationPercentage = Math.round(stationnow / stationnowall * 1000) / 10;

				// const formatMemoryUsage = (data) => `${Math.round(data / 1024 / 1024 * 100) / 100} MB`;
				// rss() 只讀常駐記憶體，不像 memoryUsage() 還要統計整個 heap
				const rss = `${(process.memoryUsage.rss() / 1024 / 1024 / 1024).toFixed(2)} GB`;
				// const warn = (Warn) ? "⚠️" : "";
				// const unlock = (Unlock) ? "⚡" : "";
				const logLine = `${stationnow}/${stationnowall} | ${stationPercentage}% | ${rss}`;
				setText(document.getElementById("log"), logLine);
				setText(document.getElementById("log1"), logLine);
				const statusLine = `${APP_VERSION} by 小蔡 ${Ping} ${GetDataState} ${Warn}`;

				// 震度視窗的狀態列：內容變了才送
				const intensityLog = { time: now_format(NOW()), log: logLine, ver: statusLine };
				const intensityLogKey = `${intensityLog.time}|${logLine}|${statusLine}`;

				if (intensityLogKey != lastIntensityLog) {
					lastIntensityLog = intensityLogKey;
					ipcRenderer.send("TREMIntensitylog2", intensityLog);
				}

				setText(document.getElementById("app-version"), statusLine);
				setText(document.getElementById("app-version1"), statusLine);
			}, 500);

		if (!Timers.tsunami)
			Timers.tsunami = setInterval(() => {
				if (investigation) {
					if (NOW().getTime() - Report > 600_000) {
						investigation = false;
						roll.removeChild(roll.children[0]);

						if (!replay) {
							Report = 0;
							TREM.MapIntensity.MaxI = -1;
						}

						if (TREM.MapIntensity.isTriggered && TREM.MapIntensity.intensities.size != undefined)
							TREM.MapIntensity.clear();

						globalgc();
					}
				} else if (Date.now() - report_get_timestamp > 600_000) {
					ReportGET();
					globalgc();
				} else if (Date.now() - report_newest_check > REPORT_NEWEST_MS) {
					report_newest_check = Date.now();
					checkNewestReport();
				}

				if (ReportTag != 0 && NOW().getTime() - ReportTag > 30_000) {
					console.debug("ReportTag end: ", NOW().getTime());
					ReportTag = 0;
					console.debug("ReportTag: ", ReportTag);
					TREM.Report.setView("report-list");
					changeView("main", "#mainView_btn");
					stopReplay();
				}
			}, 1_000);

		progressbar.value = (1 / progressStep) * 2;
	})();

	// Audios
	(() => {
		const gainNode = TREM.AudioContext.createGain();

		for (const key in TREM.Audios) {
			const audioSource = TREM.AudioContext.createMediaElementSource(TREM.Audios[key]);
			audioSource.connect(gainNode).connect(TREM.AudioContext.destination);
		}

		progressbar.value = (1 / progressStep) * 3;
	})();

	// Colors and Map
	await (async () => {
		TREM.Colors = await getThemeColors(setting["theme.color"], setting["theme.dark"]);

		log("Loading Map Data...", 1, "ResourceLoader", "init");
		log("Starting timer...", 0, "Timer", "init");
		dump({ level: 0, message: "Loading Map Data...", origin: "ResourceLoader" });
		dump({ level: 3, message: "Starting timer...", origin: "Timer" });
		let perf_GEOJSON_LOAD = process.hrtime();
		fs.readdirSync(path.join(__dirname, "../Resources/GeoJSON")).forEach((file, i, arr) => {
			try {
				MapData[path.parse(file).name] = require(path.join(__dirname, "../Resources/GeoJSON", file));
				log(`Loaded ${file}`, 0, "ResourceLoader", "init");
				dump({ level: 3, message: `Loaded ${file}`, origin: "ResourceLoader" });
				progressbar.value = (1 / progressStep) * 3.6 + (((1 / progressStep) / arr.length) * (i + 1));
			} catch (error) {
				log(`An error occurred while loading file ${file}`, 3, "ResourceLoader", "init");
				log(error, 3, "ResourceLoader", "init");
				dump({ level: 2, message: `An error occurred while loading file ${file}`, origin: "ResourceLoader" });
				dump({ level: 2, message: error, origin: "ResourceLoader" });
				console.error(error);
				log(`Skipping ${file}`, 0, "ResourceLoader", "init");
				dump({ level: 3, message: `Skipping ${file}`, origin: "ResourceLoader" });
			}
		});
		perf_GEOJSON_LOAD = process.hrtime(perf_GEOJSON_LOAD);
		log(`ResourceLoader took ${perf_GEOJSON_LOAD[0]}.${perf_GEOJSON_LOAD[1]}s`, 0, "Timer", "init");
		dump({ level: 3, message: `ResourceLoader took ${perf_GEOJSON_LOAD[0]}.${perf_GEOJSON_LOAD[1]}s`, origin: "Timer" });

		// #region Maps

		TREM.MapData = MapData;

		log("Initializing map", 0, "Map", "init");
		dump({ level: 3, message: "Initializing map", origin: "Map" });

		if (!Maps.main) {
			Maps.main = L.map("map",
				{
					edgeBufferTiles    : 1,
					attributionControl : false,
					closePopupOnClick  : false,
					maxBounds          : [[60, 50], [10, 180]],
					preferCanvas       : true,
					zoomSnap           : 0.25,
					zoomDelta          : 0.5,
					zoomAnimation      : true,
					fadeAnimation      : setting["map.animation"],
					doubleClickZoom    : false,
					zoomControl        : false,
				})
				.on("click", () => {
					mapLock = false;
					Mapsmainfocus();
				})
				.on("contextmenu", () => {
					Mapsmainfocus();
				})
				.on("drag", () => mapLock = true)
				.on("zoomend", () => {
					// 放大到 13.5 以上常駐顯示測站提示框；只重綁狀態真的要變的（之前每次縮放都把全部測站拆掉重綁）
					const permanent = Maps.main.getZoom() >= 13.5;

					for (const key in Station) {
						const tooltip = Station[key].getTooltip();

						if (!tooltip || tooltip.options.permanent == permanent) continue;

						if (!permanent && Station[key].keepTooltipAlive) continue;

						Station[key].unbindTooltip();
						tooltip.options.permanent = permanent;
						Station[key].bindTooltip(tooltip);
					}
				});
			Maps.main._fadeAnimated = setting["map.animation"];
			Maps.main._zoomAnimated = setting["map.animation"];
		}

		if (!Maps.mini)
			Maps.mini = L.map("map-tw",
				{
					attributionControl : false,
					zoomControl        : false,
					closePopupOnClick  : false,
					preferCanvas       : true,
					zoomAnimation      : false,
					fadeAnimation      : false,
					dragging           : false,
					touchZoom          : false,
					doubleClickZoom    : false,
					scrollWheelZoom    : false,
					boxZoom            : false,
					keyboard           : false,
				})
				.setView([23.608428, 120.799168], 7)
				.on("zoom", () => Maps.mini.setView([23.608428, 120.799168], 7));

		if (!Maps.report) {
			Maps.report = L.map("map-report",
				{
					attributionControl : false,
					closePopupOnClick  : false,
					// maxBounds          : [[30, 130], [10, 100]],
					preferCanvas       : true,
					zoomSnap           : 0.25,
					zoomDelta          : 0.5,
					zoomAnimation      : true,
					fadeAnimation      : setting["map.animation"],
					zoomControl        : false,
					doubleClickZoom    : false,
					keyboard           : false,
					worldCopyJump      : true,
				})
				.fitBounds([[25.35, 119.4], [21.9, 122.22]], {
					paddingTopLeft: [document.getElementById("map-report").offsetWidth / 2, 0],
				})
				.on("contextmenu", () => TREM.Report._focusMap())
				.on("click", () => TREM.Report._focusMap());
			Maps.report._fadeAnimated = setting["map.animation"];
			Maps.report._zoomAnimated = setting["map.animation"];
		}

		MapBases = { main: [], mini: [], report: [], intensity: [] };

		if (!MapBases.main.length) {
			for (const mapName of [
				"cn",
				"jp",
				"sk",
				"nk",
				"ph",
			])
				if (setting["map." + mapName])
					MapBases.main.push(`${mapName}`, L.geoJson.vt(MapData[mapName], {
						edgeBufferTiles : 2,
						minZoom         : 4,
						maxZoom         : 15,
						tolerance       : 20,
						buffer          : 256,
						debug           : 0,
						style           : {
							weight      : 0.8,
							color       : TREM.Colors.secondary,
							fillColor   : TREM.Colors.surfaceVariant,
							fillOpacity : 0.5,
						},
					}).addTo(Maps.main));
			MapBases.main.push("tw_county", L.geoJson.vt(MapData.tw_county, {
				edgeBufferTiles : 2,
				minZoom         : 4,
				maxZoom         : 15,
				tolerance       : 20,
				buffer          : 256,
				debug           : 0,
				style           : {
					weight      : 0.8,
					color       : TREM.Colors.secondary,
					fillColor   : TREM.Colors.surfaceVariant,
					fillOpacity : 0.5,
				},
			}).addTo(Maps.main));

			if (setting["map.tw_fault"])
				MapBases.main.push("tw_fault",
					L.geoJson.vt(MapData.tw_fault, {
						edgeBufferTiles : 2,
						minZoom         : 4,
						maxZoom         : 15,
						tolerance       : 20,
						buffer          : 256,
						debug           : 0,
						style           : {
							weight      : 1.8,
							color       : "red",
							fillColor   : TREM.Colors.surfaceVariant,
							fillOpacity : 3,
						},
					}).addTo(Maps.main));
		}

		if (!MapBases.mini.length)
			MapBases.mini.push("tw_county",
				L.geoJson.vt(MapData.tw_county, {
					minZoom   : 7,
					maxZoom   : 7,
					tolerance : 20,
					buffer    : 256,
					debug     : 0,
					zIndex    : 10,
					style     : {
						weight      : 0.8,
						color       : TREM.Colors.primary,
						fillColor   : "transparent",
						fillOpacity : 0,
					},
				}).addTo(Maps.mini));

		if (!MapBases.report.length) {
			for (const mapName of [
				"cn",
				"jp",
				"sk",
				"nk",
				"ph",
				"NZ",
				"in",
				"TU",
				"ta",
				"papua",
				"panama",
				"va",
				"ec",
				"af",
				"ru",
				"cl",
				"ar",
				"gu",
			])
				if (setting["map." + mapName])
					MapBases.report.push(`${mapName}`, L.geoJson.vt(MapData[mapName], {
						minZoom   : 1,
						maxZoom   : 12,
						tolerance : 20,
						buffer    : 256,
						debug     : 0,
						style     : {
							weight      : 0.8,
							color       : TREM.Colors.primary,
							fillColor   : TREM.Colors.surfaceVariant,
							fillOpacity : 1,
						},
					}).addTo(Maps.report));
			MapBases.report.push("tw_county",
				L.geoJson.vt(MapData.tw_county, {
					minZoom   : 1,
					maxZoom   : 12,
					tolerance : 20,
					buffer    : 256,
					debug     : 0,
					style     : {
						weight      : 0.8,
						color       : TREM.Colors.primary,
						fillColor   : TREM.Colors.surfaceVariant,
						fillOpacity : 1,
					},
				}).addTo(Maps.report));

			if (setting["map.tw_fault"])
				MapBases.report.push("tw_fault",
					L.geoJson.vt(MapData.tw_fault, {
						minZoom   : 1,
						maxZoom   : 12,
						tolerance : 20,
						buffer    : 256,
						debug     : 0,
						style     : {
							weight      : 1.8,
							color       : "red",
							fillColor   : TREM.Colors.surfaceVariant,
							fillOpacity : 3,
						},
					}).addTo(Maps.report));
		}
	})().catch(e => {
		log(e, 3, "Colors&Map", "init");
		dump({ level: 2, message: e });
	});
	progressbar.value = (1 / progressStep) * 4;

	// Files
	await (async () => {
		await fetchFiles();

		if (!Timers.fetchFiles)
			Timers.fetchFiles = setInterval(fetchFiles, 5 * 60 * 1000);
	})().catch(e => {
		log(e, 3, "Files", "init");
		dump({ level: 2, message: e });
	});

	progressbar.value = 1;
	startServices();

	setUserLocationMarker(setting["location.town"]);
	$("#loading").text(TREM.Localization.getString("Application_Welcome"));
	$("#load").delay(1000).fadeOut(1000);
	Mapsmainfocus();
	setInterval(() => {
		if (mapLock || !setting["map.autoZoom"]) return;

		if (Object.keys(eew).length != 0) {
			for (let index = 0; index < Object.keys(eew).length; index++)
				if (eewt.id == 0 || eewt.id == eew[Object.keys(eew)[index]].id || NOW().getTime() - eew[Object.keys(eew)[index]].time >= 10000) {
					eewt.id = eew[Object.keys(eew)[index]].id;
					let Zoom = 9;
					// const X = 0;
					const km = (NOW().getTime() - eew[Object.keys(eew)[index]].Time) * 4;

					if (km > 50000)
						Zoom = 8.5;

					if (km > 100000)
						Zoom = 8;

					if (km > 150000)
						Zoom = 7.75;

					if (km > 200000)
						Zoom = 7.5;

					if (km > 250000)
						Zoom = 7.25;

					if (km > 300000)
						Zoom = 7;
					const num = Math.sqrt(Math.pow(23.608428 - eew[Object.keys(eew)[index]].lat, 2) + Math.pow(120.799168 - eew[Object.keys(eew)[index]].lon, 2));

					if (num >= 5)
						TREM.Earthquake.emit("focus", { center: [eew[Object.keys(eew)[index]].lat, eew[Object.keys(eew)[index]].lon], zoom: Zoom });
					else
						TREM.Earthquake.emit("focus", { center: [eew[Object.keys(eew)[index]].lat, eew[Object.keys(eew)[index]].lon], zoom: Zoom });
					eew[Object.keys(eew)[index]].time = NOW().getTime();
				}

		} else if (Object.keys(detected_box_list).length >= 1) {
			if (Object.keys(detected_box_list).length == 1) {
				const X1 = (TREM.Resources.area[Object.keys(detected_list)[0].toString()][0][0] + (TREM.Resources.area[Object.keys(detected_list)[0].toString()][2][0] - TREM.Resources.area[Object.keys(detected_list)[0].toString()][0][0]) / 2);
				const Y1 = (TREM.Resources.area[Object.keys(detected_list)[0].toString()][0][1] + (TREM.Resources.area[Object.keys(detected_list)[0].toString()][1][1] - TREM.Resources.area[Object.keys(detected_list)[0].toString()][0][1]) / 2);
				TREM.Earthquake.emit("focus", { center: [X1, Y1], zoom: 9.5 });
			} else if (Object.keys(detected_box_list).length >= 2) {
				let detected_list_length = 0;
				let xl = 0;
				let yl = 1;
				let focusScale = 9;

				let X1 = (TREM.Resources.area[Object.keys(detected_list)[xl].toString()][0][0] + (TREM.Resources.area[Object.keys(detected_list)[xl].toString()][2][0] - TREM.Resources.area[Object.keys(detected_list)[xl].toString()][0][0]) / 2);
				let Y1 = (TREM.Resources.area[Object.keys(detected_list)[xl].toString()][0][1] + (TREM.Resources.area[Object.keys(detected_list)[xl].toString()][1][1] - TREM.Resources.area[Object.keys(detected_list)[xl].toString()][0][1]) / 2);
				let X2 = (TREM.Resources.area[Object.keys(detected_list)[yl].toString()][0][0] + (TREM.Resources.area[Object.keys(detected_list)[yl].toString()][2][0] - TREM.Resources.area[Object.keys(detected_list)[yl].toString()][0][0]) / 2);
				let Y2 = (TREM.Resources.area[Object.keys(detected_list)[yl].toString()][0][1] + (TREM.Resources.area[Object.keys(detected_list)[yl].toString()][1][1] - TREM.Resources.area[Object.keys(detected_list)[yl].toString()][0][1]) / 2);

				if (Object.keys(detected_box_list).length == 2) {
					const num = Math.sqrt(Math.pow(X1 - X2, 2) + Math.pow(Y1 - Y2, 2));

					if (num > 0.6) focusScale = 9;

					if (num > 1) focusScale = 8.5;

					if (num > 1.5) focusScale = 8;

					if (num > 2.8) focusScale = 7;
				} else {
					if (Object.keys(detected_box_list).length >= 4) focusScale = 8;

					if (Object.keys(detected_box_list).length >= 6) focusScale = 7.5;

					if (Object.keys(detected_box_list).length >= 8) focusScale = 7;
				}

				for (let index = 0; index < Object.keys(detected_list).length; index++)
					if (Object.keys(detected_list)[index].toString() == "7363648") {
						focusScale = 5;
						xl = index;
					} else if (Object.keys(detected_list)[index].toString() == "13379360") {
						focusScale = 5;
						yl = index;
					} else {
						detected_list_length += 1;
					}

				if (xl != 0 || yl != 1) {
					X1 = (TREM.Resources.area[Object.keys(detected_list)[xl].toString()][0][0] + (TREM.Resources.area[Object.keys(detected_list)[xl].toString()][2][0] - TREM.Resources.area[Object.keys(detected_list)[xl].toString()][0][0]) / 2);
					Y1 = (TREM.Resources.area[Object.keys(detected_list)[xl].toString()][0][1] + (TREM.Resources.area[Object.keys(detected_list)[xl].toString()][1][1] - TREM.Resources.area[Object.keys(detected_list)[xl].toString()][0][1]) / 2);
					X2 = (TREM.Resources.area[Object.keys(detected_list)[yl].toString()][0][0] + (TREM.Resources.area[Object.keys(detected_list)[yl].toString()][2][0] - TREM.Resources.area[Object.keys(detected_list)[yl].toString()][0][0]) / 2);
					Y2 = (TREM.Resources.area[Object.keys(detected_list)[yl].toString()][0][1] + (TREM.Resources.area[Object.keys(detected_list)[yl].toString()][1][1] - TREM.Resources.area[Object.keys(detected_list)[yl].toString()][0][1]) / 2);
				}

				if (detected_list_length === 43) Mapsmainfocus();
				else TREM.Earthquake.emit("focus", { center: [(X1 + X2) / 2, (Y1 + Y2) / 2], zoom: focusScale });
			}

			map_move_back = true;
		} else
			if (map_move_back) {
				map_move_back = false;
				Mapsmainfocus();
			}
	}, 500);

	document.getElementById("rt-station-local").addEventListener("click", () => {
		navigator.clipboard.writeText(document.getElementById("rt-station-local-id").innerText).then(() => {
			console.debug(document.getElementById("rt-station-local-id").innerText);
			console.debug("複製成功");
		});
	});

	if (localStorage.cwb_to_cwa == undefined) {
		localStorage.cwb_to_cwa = true;
		ipcRenderer.send("config:value", "accept.eew.CWA", setting["accept.eew.CWB"]);
		ipcRenderer.send("config:value", "report.onlycwachangeView", setting["report.onlycwbchangeView"]);
		ipcRenderer.send("config:value", "intensity.cwa", setting["intensity.cwb"]);
	}

	const loadDiv = document.getElementById("load");

	if (loadDiv)
		loadDiv.remove();

	globalgc();
}
// #endregion

function PGAMain() {
	log("Starting PGA timer", 1, "PGATimer", "PGAMain");
	dump({ level: 0, message: "Starting PGA timer", origin: "PGATimer" });

	if (Timers.rts_clock) clearInterval(Timers.rts_clock);

	if (Timers.eew_clock) clearInterval(Timers.eew_clock);

	if (replayD) {
		Timers.rts_clock = setInterval(() => {
			try {
				const ReplayTimed = replayTemp += 1000;
				const ReplayTimeD = ReplayTimed - 1000;
				const gettime = ReplayTimeD / 1000;
				const userJSON = ReplayData.readSecond(replaydir, gettime);

				// 沒有這一秒的資料（伺服器缺資料或已超過下載範圍）就略過
				if (!userJSON) return;

				const ans_eew = Array.isArray(userJSON.eew) ? { eew: userJSON.eew } : userJSON.eew;
				Ping = "🔁 cache";

				if (userJSON.rts) handler(toRtsV2(userJSON.rts));

				for (let i = 0; i < ans_eew.eew.length; i++) {
					console.debug(ans_eew.eew[i]);
					ans_eew.eew[i].replay_timestamp = ans_eew.eew[i].timestamp;
					ans_eew.eew[i].replay_time = ans_eew.eew[i].time;
					ans_eew.eew[i].time = NOW().getTime() - (ans_eew.eew[i].timestamp - ans_eew.eew[i].time);
					ans_eew.eew[i].timestamp = NOW().getTime();
					FCMdata(ans_eew.eew[i], "cache");
				}
			} catch (err) {
				console.log(err);
				// TimerDesynced = true;
				PGAMainbkup();
			}
		}, 1_000);
	} else if (!replayF) {
		Timers.eew_clock = setInterval(() => {
			const ReplayTime = (replay == 0) ? 0 : replay + (NOW().getTime() - replayT);

			if (ReplayTime != 0 && TREM.Report.replayHttp) {
				const controller1 = new AbortController();
				setTimeout(() => {
					controller1.abort();
				}, 2500);
				fetch(route.eewReplay(1, ReplayTime), { signal: controller1.signal }).then((res2) => {
					if (res2.ok) {
						res2.json().then(res3 => {
							if (controller1.signal.aborted || res3 == undefined)
								console.debug("api_eq_undefined");
							else
								for (let i = 0; i < res3.length; i++) {
									if (!EarthquakeList[res3[i].id]) {
										res3[i].replay_timestamp = ReplayTime;
										res3[i].replay_time = res3[i].time;
										res3[i].time = NOW().getTime() - (ReplayTime - res3[i].eq.time);
										res3[i].timestamp = NOW().getTime();
										res3[i].type = "eew";
									} else {
										res3[i].replay_timestamp = ReplayTime;
										res3[i].replay_time = res3[i].time;
										res3[i].time = EarthquakeList[res3[i].id].Time;
										res3[i].timestamp = NOW().getTime();
										res3[i].type = "eew";
									}

									FCMdata(res3[i], "http");
								}
						});
					} else {
						console.error(res2);

						switch (res2.status) {
							case 429: {
								Ping = `❌ ${res2.status}`;
								break;
							}

							case 404: {
								Ping = `❌ ${res2.status}`;
								break;
							}

							case 500: {
								Ping = `❌ ${res2.status}`;
								break;
							}

							default: {
								Ping = `❌ ${res2.status}`;
								break;
							}
						}
					}
				}).catch((err) => {
					log(err, 3, "PGATimer", "PGAMain");
					dump({ level: 2, message: err });
				});
			}
		}, 1_000);
		Timers.rts_clock = setInterval(() => {
			setTimeout(() => {
				try {
					const _t = NOW().getTime();
					const ReplayTime = (replay == 0) ? 0 : replay + (NOW().getTime() - replayT);

					if (ReplayTime == 0) {
						if (rts_ws_timestamp) {
							// 即時資料只剩 SSE：依資料新鮮度顯示，背景模式（只收觸發資料）顯示 🌙
							const age = (Date.now() - rts_ws_timestamp) / 1000;
							Ping = rts_background ? "🌙" : `${age < 1.5 ? "⚡" : age < 7.5 ? "📶" : "⚠️"} ${rtsAge()}s`;
							Response = rts_response;
						} else {
							for (const removedKey of Object.keys(Station)) {
								Station[removedKey].remove();
								delete Station[removedKey];
							}

							if (setting["sleep.mode"])
								Ping = "💤";
							else
								Ping = "🔒";
						}
					} else if (!replayD) {
						const url = route.rtsReplay(1, ReplayTime);
						// + "&key=" + setting["exptech.key"]
						const controller = new AbortController();
						setTimeout(() => {
							controller.abort();
						}, 5000);
						fetch(url, { signal: controller.signal }).then((res) => {
							if (res.ok) {
								res.json().then(res1 => {
									if (controller.signal.aborted || res1 == undefined) {
										Ping = "🔒";
									} else {
										Ping = `🔁 ${(Math.abs(NOW().getTime() - _t) / 1000).toFixed(1)}s`;
										Response = toRtsV2(res1);
									}
								});
							} else {
								console.error(res);

								switch (res.status) {
									case 429: {
										Ping = `❌ ${res.status}`;
										break;
									}

									case 404: {
										Ping = `❌ ${res.status}`;
										break;
									}

									case 500: {
										Ping = `❌ ${res.status}`;
										break;
									}

									default: {
										Ping = `❌ ${res.status}`;
										break;
									}
								}

								PGAMainbkup();
							}
						}).catch((err) => {
							log(err, 3, "PGATimer", "PGAMain");
							dump({ level: 2, message: err });
							PGAMainbkup();
						});
					}

					handleRtsOnce(Response);
				} catch (err) {
					console.log(err);
					// TimerDesynced = true;
					PGAMainbkup();
				}
			}, (NOW().getMilliseconds() > 500) ? 1000 - NOW().getMilliseconds() : 500 - NOW().getMilliseconds());
		}, 500);
	}
}

// 即時資料約每秒一筆，計時器每 0.5 秒跑一次：同一筆資料 1 秒內不重跑整個測站迴圈與 DOM 更新
let lastRts = { data: null, at: 0 };

function handleRtsOnce(data) {
	const now = Date.now();

	if (data === lastRts.data && now - lastRts.at < 1_000) return;

	lastRts = { data, at: now };
	handler(data);
}

function PGAMainbkup() {
	log("Starting PGA timer backup", 1, "PGATimer", "PGAMainbkup");
	dump({ level: 0, message: "Starting PGA timer backup", origin: "PGATimer" });

	if (Timers.rts_clock) clearInterval(Timers.rts_clock);

	if (Timers.eew_clock) clearInterval(Timers.eew_clock);

	if (replayD) {
		Timers.rts_clock = setInterval(() => {
			try {
				const ReplayTimed = replayTemp += 1000;
				const ReplayTimeD = ReplayTimed - 1000;
				const gettime = ReplayTimeD / 1000;
				const userJSON = ReplayData.readSecond(replaydir, gettime);

				// 沒有這一秒的資料（伺服器缺資料或已超過下載範圍）就略過
				if (!userJSON) return;

				const ans_eew = Array.isArray(userJSON.eew) ? { eew: userJSON.eew } : userJSON.eew;
				Ping = "🔁 cache";

				if (userJSON.rts) handler(toRtsV2(userJSON.rts));

				for (let i = 0; i < ans_eew.eew.length; i++) {
					console.debug(ans_eew.eew[i]);
					ans_eew.eew[i].replay_timestamp = ans_eew.eew[i].timestamp;
					ans_eew.eew[i].replay_time = ans_eew.eew[i].time;
					ans_eew.eew[i].time = NOW().getTime() - (ans_eew.eew[i].timestamp - ans_eew.eew[i].time);
					ans_eew.eew[i].timestamp = NOW().getTime();
					FCMdata(ans_eew.eew[i], "cache");
				}
			} catch (err) {
				console.log(err);
				// TimerDesynced = true;
				PGAMain();
			}
		}, 1_000);
	} else if (!replayF) {
		Timers.eew_clock = setInterval(() => {
			const ReplayTime = (replay == 0) ? 0 : replay + (NOW().getTime() - replayT);

			if (ReplayTime != 0 && TREM.Report.replayHttp) {
				// 舊版 axios 的 EEW 重播已移除，備援計時器不重播 EEW
			}
		}, 1_000);
		Timers.rts_clock = setInterval(() => {
			setTimeout(() => {
				try {
					const _t = NOW().getTime();
					const ReplayTime = (replay == 0) ? 0 : replay + (NOW().getTime() - replayT);

					if (ReplayTime == 0)
						if (rts_ws_timestamp) {
							// 即時資料只剩 SSE：依資料新鮮度顯示，背景模式（只收觸發資料）顯示 🌙
							const age = (Date.now() - rts_ws_timestamp) / 1000;
							Ping = rts_background ? "🌙" : `${age < 1.5 ? "⚡" : age < 7.5 ? "📶" : "⚠️"} ${rtsAge()}s`;
							Response = rts_response;
						} else {
							for (const removedKey of Object.keys(Station)) {
								Station[removedKey].remove();
								delete Station[removedKey];
							}

							if (setting["sleep.mode"])
								Ping = "💤";
							else
								Ping = "🔒";
						}
					 else if (!replayD)
						PGAMain();

					handleRtsOnce(Response);
				} catch (err) {
					console.log(err);
					// TimerDesynced = true;
					PGAMain();
				}
			}, (NOW().getMilliseconds() > 500) ? 1000 - NOW().getMilliseconds() : 500 - NOW().getMilliseconds());
		}, 500);
	}
}

/**
 * 換測站圖示的等級與大小
 * 不用 setIcon：它會把圖示的 DOM 和事件整個刪掉重建，地震時大量測站同時變色會卡
 */
function updateStationIcon(stationMarker, className, size) {
	const icon = stationMarker.options.icon;

	if (icon.options.className == className && icon.options.iconSize?.[0] == size) return;

	const el = stationMarker.getElement();

	if (el) {
		el.classList.remove(...icon.options.className.split(" ").filter(Boolean));
		el.classList.add(...className.split(" ").filter(Boolean));
		// 同 Leaflet 的 _setIconStyles：寬高等於 iconSize，錨點在中心
		el.style.width = el.style.height = `${size}px`;
		el.style.marginLeft = el.style.marginTop = `${-size / 2}px`;
	}

	// 之後重新加到地圖（例如縮放、重新顯示）時會照這些選項建圖示
	icon.options.className = className;
	icon.options.iconSize = [size, size];
}

// 測站最近離線時間：每秒都會更新，放在記憶體，每分鐘和關閉前才寫回 localStorage
const stationOfflineTime = JSON.parse(localStorage.stationtime ?? "{}");
const saveStationOfflineTime = () => localStorage.stationtime = JSON.stringify(stationOfflineTime);
setInterval(saveStationOfflineTime, 60_000);
window.addEventListener("beforeunload", saveStationOfflineTime);

function handler(Json) {
	// console.log(Json);
	// console.log(station);

	stationnow = 0;
	stationnowall = 0;
	Response = {};
	MAXPGA = { pga: 0, station: "NA", level: 0 };

	// Station 的 key 是 UUID（L-704-11E1600），即時資料的 key 是測站 ID（11E1600），需取 ID 比對
	const Station_rm = (Json_rm) => Object.keys(Station).filter(key => !(key.split("-")[2] in Json_rm));

	// 沒資料、但下面馬上會以「無資料」加回的測站不用移除，不然每秒都在刪掉重建圖示
	const showAsNa = (key) => (station[key]?.work || replay != 0) && (!setting["sleep.mode"] || replay != 0) && !rts_remove_eew;

	const removed = (Json.station ? Station_rm(Json.station) : Station_rm(Json)).filter((key) => !showAsNa(key));

	for (const removedKey of removed) {
		Station[removedKey].remove();
		delete Station[removedKey];
	}

	if (Object.keys(eew).length && !rts_remove_eew) {
		rts_remove_eew = true;

		for (const removedKey of Object.keys(Station)) {
			Station[removedKey].remove();
			delete Station[removedKey];
		}
	}

	const station_time_json = stationOfflineTime;
	let max_intensity = -1;
	let stationnowindex = 0;
	let target_count = 0;
	const detection_location = Json.area ?? [];
	const detection_list = Json.box ?? {};
	const Json_temp = Json.station ? Json.station : Json;
	const Json_Time = Json.Time ?? Json.time;

	const now_format = (time) => timeconvert(time).format("HH:mm:ss");

	const now = new Date(Json_Time);
	let now_f = now_format(now);
	const now_time = NOW().getTime();
	Json_temp.area = detection_location;

	if (detection_location.length) TREM.MapArea2.setArea(Json_temp);

	// if (Object.keys(detection_list).length) console.log(detection_list);

	// 迴圈外算一次；之前每個測站都在 keys 裡找一遍
	const realtimeStationListed = Object.hasOwn(station, setting["Real-time.station"]);

	for (let index = 0, keys = Object.keys(station), n = keys.length; index < n; index++) {
		const uuid = keys[index];
		const id = uuid.split("-")[2];
		const current_station_data = station[uuid];
		const current_data = Json.station ? Json.station[id] : Json[id];

		if (!current_station_data.work && replay == 0) continue;

		stationnowall++;

		if (replay != 0) {
			const station_ = station_data[id];

			if (station_.info.length > 1) {
				let latest = station_.info[0];

				for (let i = 0; i < station_.info.length; i++) {
					const currentTime = new Date(station_.info[i].time);

					if (now > currentTime)
						latest = station_.info[i];
				}

				for (let i = 0, ks = Object.keys(TREM.Resources.regionv2), j = ks.length; i < j; i++) {
					const reg_id = ks[i];
					const reg = TREM.Resources.regionv2[reg_id];

					for (let r = 0, r_ks = Object.keys(reg), l = r_ks.length; r < l; r++) {
						const ion_id = r_ks[r];
						const ion = reg[ion_id];

						if (ion.code === latest.code) {
							current_station_data.Loc = `${reg_id} ${ion_id}`;
							current_station_data.Lat = latest.lat;
							current_station_data.Long = latest.lon;
						}
					}
				}
			}
		}

		// if (uuid == "H-979-11336952-11")
		// 	console.log(current_data);

		let level_class = "";
		let station_tooltip = "";
		let size = 8;
		let amount = 0;
		let intensity = 0;
		let intensitytest = 0;
		const Alert = current_data?.alert ?? false;

		if (current_data == undefined) {
			level_class = "na";

			if (station_time_json[uuid] == undefined && replay == 0)
				station_time_json[uuid] = Date.now();
			else if (station_time_json[uuid] == 0 && replay == 0)
				station_time_json[uuid] = Date.now();
			else if (station_time_json[uuid] == undefined && replay != 0)
				station_time_json[uuid] = 0;

			const off_now = new Date(station_time_json[uuid]);
			station_tooltip = `<div>${keys[index]}(${current_station_data.Loc})無資料</div><div>最近離線時間: ${timeconvert(off_now).format("YYYY/MM/DD HH:mm:ss")}</div>`;
			size = 8;
			amount = "--";
			intensity = "-";

			if (rtstation1 == "") {
				if (realtimeStationListed) {
					if (keys[index] == setting["Real-time.station"]) {
						if (document.getElementById("rt-station").classList.contains("hide"))
							document.getElementById("rt-station").classList.remove("hide");
						setClassName(document.getElementById("rt-station-local-intensity"), `rt-station-intensity ${(amount < 999 && intensity != "NA") ? IntensityToClassString(intensity) : "na"}`);
						setText(document.getElementById("rt-station-local-id"), keys[index]);
						setText(document.getElementById("rt-station-local-name"), current_station_data.Loc);
						setText(document.getElementById("rt-station-local-time"), now_format(off_now));
						setText(document.getElementById("rt-station-local-pga"), amount);
					}
				} else {
					setClassName(document.getElementById("rt-station-local-intensity"), "rt-station-intensity na");
					setText(document.getElementById("rt-station-local-id"), TREM.Localization.getString("Realtime_No_Data"));
					setText(document.getElementById("rt-station-local-name"), TREM.Localization.getString("Realtime_No_Data"));
					setText(document.getElementById("rt-station-local-time"), "--:--:--");
					setText(document.getElementById("rt-station-local-pga"), "--");
				}
			} else if (rtstation1 == keys[index]) {
				setClassName(document.getElementById("rt-station-local-intensity"), `rt-station-intensity ${(amount < 999 && intensity != "NA") ? IntensityToClassString(intensity) : "na"}`);
				setText(document.getElementById("rt-station-local-id"), keys[index]);
				setText(document.getElementById("rt-station-local-name"), current_station_data.Loc);
				setText(document.getElementById("rt-station-local-time"), now_format(off_now));
				setText(document.getElementById("rt-station-local-pga"), amount);
			}
		} else {
			station_time_json[uuid] = 0;

			if (current_data.a) amount = +current_data.a;
			else amount = +current_data.pga;

			// if (amount > current_station_data.MaxPGA) current_station_data.MaxPGA = amount;
			now_f = now_format(now);
			intensity = (Alert && current_data.I != null) ? rtsIntensityLevel(current_data.I)
				: (current_data.i >= 0) ? rtsIntensityLevel(current_data.i)
					: (now_time - current_data.TS * 1000 > 5000) ? "NA"
						: 0;
			// : (amount >= 800) ? 9
			// 	: (amount >= 440) ? 8
			// 		: (amount >= 250) ? 7
			// 			: (amount >= 140) ? 6
			// 				: (amount >= 80) ? 5
			// 					: (amount >= 25) ? 4
			// 						: (amount >= 8) ? 3
			// 							: (amount >= 5) ? 2
			// 								: (amount >= 2.2) ? 1
			// 									: 0;
			intensitytest = (current_data.i) ? rtsIntensityLevel(current_data.i) : -5;
			size = (intensity == 0 || intensity == "NA" || amount == 999 || !Alert) ? 8 : 16;
			level_class = (intensity != 0 && Alert) ? IntensityToClassString(intensity)
				: (intensity == 0 && Alert) ? "pga0"
					: (amount == 999) ? "pga6"
						: (amount > 4.5) ? "pga5"
							: (amount > 4) ? "pga4"
								: (amount > 3.5) ? "pga3"
									: (amount > 3) ? "pga2"
										: "pga1";

			if (setting["Real-time.websocket"] === "yayacat" && Alert && setting["dev.mode"]) {
				intensity = rtsIntensityLevel(current_data.i);
				level_class = IntensityToClassString(intensity);
			}

			if (intensity != "NA") {
				stationnowindex += 1;
				stationnow = stationnowindex;
			}

			if (!current_data.alert) delete level_list[uuid];

			if (current_data.alert) {
				if (current_data.a) if ((level_list[uuid] ?? 0) < current_data.a) level_list[uuid] = current_data.a;

				if (current_data.pga) if ((level_list[uuid] ?? 0) < current_data.pga) level_list[uuid] = current_data.pga;
				target_count++;
			}

			const pgv = current_data.v ?? current_data.pgv;

			// 新的即時資料沒有 PGV，有才顯示
			station_tooltip = `<div>${keys[index]}</div><div>${current_station_data.Loc}</div><div>PGA ${amount} gal</div>${pgv != null ? `<div>PGV ${pgv} kine</div>` : ""}<div>計測震度 ${current_data.i}</div>`;

			if (rtstation1 == "") {
				if (realtimeStationListed) {
					if (keys[index] == setting["Real-time.station"]) {
						if (document.getElementById("rt-station").classList.contains("hide"))
							document.getElementById("rt-station").classList.remove("hide");
						setClassName(document.getElementById("rt-station-local-intensity"), `rt-station-intensity ${(amount < 999 && intensity != "NA") ? IntensityToClassString(intensity) : "na"}`);
						setText(document.getElementById("rt-station-local-id"), keys[index]);
						setText(document.getElementById("rt-station-local-name"), current_station_data.Loc);
						setText(document.getElementById("rt-station-local-time"), now_f);
						setText(document.getElementById("rt-station-local-pga"), amount);
					}
				} else {
					setClassName(document.getElementById("rt-station-local-intensity"), "rt-station-intensity na");
					setText(document.getElementById("rt-station-local-id"), TREM.Localization.getString("Realtime_No_Data"));
					setText(document.getElementById("rt-station-local-name"), TREM.Localization.getString("Realtime_No_Data"));
					setText(document.getElementById("rt-station-local-time"), "--:--:--");
					setText(document.getElementById("rt-station-local-pga"), "--");
				}
			} else if (rtstation1 == keys[index]) {
				setClassName(document.getElementById("rt-station-local-intensity"), `rt-station-intensity ${(amount < 999 && intensity != "NA") ? IntensityToClassString(intensity) : "na"}`);
				setText(document.getElementById("rt-station-local-id"), keys[index]);
				setText(document.getElementById("rt-station-local-name"), current_station_data.Loc);
				setText(document.getElementById("rt-station-local-time"), now_f);
				setText(document.getElementById("rt-station-local-pga"), amount);
			}
		}

		if (current_data != undefined || !setting["sleep.mode"] || replay != 0) {
			if (!Station[keys[index]] && (!rts_remove_eew || Alert))
				Station[keys[index]] = L.marker(
					[current_station_data.Lat, keys[index].startsWith("H") ? current_station_data.Long + 0.0001 : current_station_data.Long],
					{
						icon: L.divIcon({
							iconSize  : [size, size],
							className : `map-intensity-icon rt-icon ${level_class}`,
						}),
						keyboard: false,
					})
					.addTo(Maps.main)
					.bindTooltip(station_tooltip, {
						offset    : [8, 0],
						permanent : false,
						className : current_data == undefined ? "rt-station-tooltip-na" : "rt-station-tooltip",
					})
					.on("click", () => {
						// Station[keys[index]].keepTooltipAlive = !Station[keys[index]].keepTooltipAlive;

						// if (Maps.main.getZoom() < 11) {
						// 	const tooltip = Station[keys[index]].getTooltip();
						// 	Station[keys[index]].unbindTooltip();

						// 	if (Station[keys[index]].keepTooltipAlive)
						// 		tooltip.options.permanent = true;
						// 	else
						// 		tooltip.options.permanent = false;
						// 	Station[keys[index]].bindTooltip(tooltip);
						// }

						if (rtstation1 == "") {
							rtstation1 = keys[index];
							app.Configuration.data["Real-time.station"] = keys[index];
						} else if (rtstation1 == keys[index]) {
							rtstation1 = "";
							app.Configuration.data["Real-time.station"] = setting["Real-time.station"];
						} else if (rtstation1 != keys[index]) {
							rtstation1 = keys[index];
							app.Configuration.data["Real-time.station"] = keys[index];
						}
					});

			if (Station[keys[index]]) {
				const stationMarker = Station[keys[index]];
				const zIndex = 2000 + ~~(amount * 10) + intensity * 500;

				updateStationIcon(stationMarker, `map-intensity-icon rt-icon ${level_class}`, size);

				// 測站有資料／沒資料切換時，提示框樣式也要跟著換
				const tooltip = stationMarker.getTooltip();
				const tooltipClass = current_data == undefined ? "rt-station-tooltip-na" : "rt-station-tooltip";

				if (tooltip && tooltip.options.className != tooltipClass) {
					tooltip.getElement()?.classList.replace(tooltip.options.className, tooltipClass);
					tooltip.options.className = tooltipClass;
				}

				// 沒變就不設，setZIndexOffset 每次都會重算位置
				if (stationMarker.options.zIndexOffset !== zIndex) stationMarker.setZIndexOffset(zIndex);

				stationMarker.setTooltipContent(station_tooltip);
			}
		}

		const Level = IntensityI(intensity);

		// if (intensity != "NA" && (intensity >= 0 && Alert) && amount < 999 && (target_count > 1 || Object.keys(eew).length != 0)) {
		// detected_list[current_station_data.PGA] ??= {
		// 	intensity : intensity,
		// 	time      : 0,
		// };

		// if ((detected_list[current_station_data.PGA].intensity ?? 0) < intensity)
		// 	detected_list[current_station_data.PGA].intensity = intensity;

		if (Json.Alert)
			if (setting["audio.realtime"])
				if (amount > 8 && PGALimit == 0) {
					PGALimit = 1;
					log("Playing Audio > pga1", 1, "Audio", "handler");
					dump({ level: 0, message: "Playing Audio > pga1", origin: "Audio" });
					TREM.Audios.pga1.play();
				} else if (amount > 250 && PGALimit == 1) {
					PGALimit = 2;
					log("Playing Audio > pga2", 1, "Audio", "handler");
					dump({ level: 0, message: "Playing Audio > pga2", origin: "Audio" });
					TREM.Audios.pga2.play();
				}

		// detected_list[current_station_data.PGA].time = NOW().getTime();
		// } else
		if (Object.keys(detection_list).length) {
			for (let i = 0; i < Object.keys(detection_list).length; i++) {
				const key = Object.keys(detection_list)[i];

				if (max_intensity < detection_list[key]) max_intensity = detection_list[key];

				detected_list[key] ??= {
					intensity : detection_list[key],
					time      : NOW().getTime(),
				};

				if (detection_list[key] != detected_list[key].intensity) detected_list[key] = {
					intensity : detection_list[key],
					time      : NOW().getTime(),
				};
			}

			if (max_intensity > intensitytag) {
				if (setting["audio.realtime"]) {
					const loc = detection_location[0] ?? "未知區域";

					if (max_intensity > 4 || intensitytag > 4) {
						if (speecd_use) TREM.speech.speak({ text: `強震檢測，${loc}` });
						log("Playing Audio > int2", 1, "Audio", "handler");
						dump({ level: 0, message: "Playing Audio > int2", origin: "Audio" });
						TREM.Audios.int2.play();
						new Notification("🟥 強震檢測", {
							body   : `${loc}`,
							icon   : "../TREM.ico",
							silent : document.hasFocus(),
						});
					} else if (max_intensity > 1 || intensitytag > 1) {
						if (speecd_use) TREM.speech.speak({ text: `震動檢測，${loc}` });
						log("Playing Audio > int1", 1, "Audio", "handler");
						dump({ level: 0, message: "Playing Audio > int1", origin: "Audio" });
						TREM.Audios.int1.play();
						new Notification("🟨 震動檢測", {
							body   : `${loc}`,
							icon   : "../TREM.ico",
							silent : document.hasFocus(),
						});
					} else if (intensitytag == -1) {
						if (speecd_use) TREM.speech.speak({ text: `弱反應，${loc}` });
						log("Playing Audio > int0", 1, "Audio", "handler");
						dump({ level: 0, message: "Playing Audio > int0", origin: "Audio" });
						TREM.Audios.int0.play();
						new Notification("🟩 弱反應", {
							body   : `${loc}`,
							icon   : "../TREM.ico",
							silent : document.hasFocus(),
						});
					}

					const _intensity = `${IntensityI(max_intensity)}級`;

					if (speecd_use) TREM.speech.speak({ text: `觀測最大震度，${_intensity.replace("-級", "弱").replace("+級", "強")}` });
				}

				setTimeout(() => {
					ipcRenderer.send("screenshotEEW", {
						Function : "station",
						ID       : 1,
						Version  : 1,
						Time     : NOW().getTime(),
						Shot     : 1,
					});
				}, 1250);

				raiseMainWindow({ show: setting["Real-time.show"], cover: setting["Real-time.cover"], flash: true });

				// TREM.MapIntensity.trem = false;
				// TREM.MapIntensity.MaxI = max_intensity;
				// Report = Json_Time;
				// Report_GET();
				intensitytag = max_intensity;
			}
		}

		if (MAXPGA.pga < amount && amount < 999 && Level != "NA") {
			MAXPGA.pga = amount;
			MAXPGA.station = keys[index];
			MAXPGA.level = Level;
			MAXPGA.lat = current_station_data.Lat;
			MAXPGA.long = current_station_data.Long;
			MAXPGA.loc = current_station_data.Loc;
			MAXPGA.intensity = intensity;
			MAXPGA.time = now;
		}
	}

	if (target_count != 0) {
		let level = 0;

		for (let i = 0; i < Object.keys(level_list).length; i++) {
			const uuid = Object.keys(level_list)[i];
			level += Math.round(level_list[uuid]);
		}

		$("#level").text(`level: ${level}`);
		$("#target").text(`target: ${target_count}`);

		// if (MaxIntensity2 > TREM.MapIntensity.MaxI)
		// 	if (setting["Real-time.alert"] && alert_key_verify && setting["Real-time.websocket"] === "yayacat")
		// 		if (replay == 0) {
		// 			TREM.MapIntensity.trem = true;
		// 			TREM.MapIntensity.MaxI = MaxIntensity2;

		// 			changeView("main", "#mainView_btn");

		// 			if (Report === 0) Report = NOW().getTime();
		// 			Report_GET();

		// 			if (setting["Real-time.show"]) win.showInactive();

		// 			if (setting["Real-time.cover"])
		// 				if (!win.isFullScreen()) {
		// 					win.setAlwaysOnTop(true);
		// 					win.focus();
		// 					win.setAlwaysOnTop(false);
		// 				}

		// 			if (!win.isFocused()) win.flashFrame(true);

		// 			setTimeout(() => {
		// 				ipcRenderer.send("screenshotEEW", {
		// 					Function : "station",
		// 					ID       : 1,
		// 					Version  : 1,
		// 					Time     : NOW().getTime(),
		// 					Shot     : 1,
		// 				});
		// 			}, 300);
		// 		}
	} else {
		level_list = {};
		$("#level").text("");
		$("#target").text("");
	}

	if (MAXPGA.station != "NA") {
		setClassName(document.getElementById("rt-station-max-intensity"), `rt-station-intensity ${(MAXPGA.pga < 999) ? IntensityToClassString(MAXPGA.intensity) : "na"}`);
		setText(document.getElementById("rt-station-max-id"), MAXPGA.station);
		setText(document.getElementById("rt-station-max-name"), MAXPGA.loc);
		setText(document.getElementById("rt-station-max-time"), now_format(MAXPGA.time));
		setText(document.getElementById("rt-station-max-pga"), MAXPGA.pga);
	} else {
		setClassName(document.getElementById("rt-station-max-intensity"), "rt-station-intensity na");
		setText(document.getElementById("rt-station-max-id"), TREM.Localization.getString("Realtime_No_Data"));
		setText(document.getElementById("rt-station-max-name"), TREM.Localization.getString("Realtime_No_Data"));
		setText(document.getElementById("rt-station-max-time"), "--:--:--");
		setText(document.getElementById("rt-station-max-pga"), "--");
		setClassName(document.getElementById("rt-station-local-intensity"), "rt-station-intensity na");
		setText(document.getElementById("rt-station-local-id"), TREM.Localization.getString("Realtime_No_Data"));
		setText(document.getElementById("rt-station-local-name"), TREM.Localization.getString("Realtime_No_Data"));
		setText(document.getElementById("rt-station-local-time"), "--:--:--");
		setText(document.getElementById("rt-station-local-pga"), "--");
	}

	if (Object.keys(detected_box_list).length)
		for (let index = 0; index < Object.keys(detected_box_list).length; index++) {
			if (RMT == 0) Maps.main.removeLayer(detected_box_list[Object.keys(detected_box_list)[index]]);
			delete detected_box_list[Object.keys(detected_box_list)[index]];
			index--;
		}

	if (NOW().getTime() - RMTpgaTime > 30_000)
		RMT = 0;
	else
		RMT++;

	if (Object.keys(detected_list).length)
		for (let index = 0; index < Object.keys(detected_list).length; index++) {
			const Intensity = detected_list[Object.keys(detected_list)[index]].intensity;
			const time = detected_list[Object.keys(detected_list)[index]].time;

			if (RMTpgaTime == 0) {
				RMTpgaTime = NOW().getTime();
				console.debug("檢知框框開始時間:", RMTpgaTime);
			}

			if (time != 0 && NOW().getTime() - time > 30_000 || PGACancel) {
				delete detected_list[Object.keys(detected_list)[index]];
				index--;
			} else if (NOW().getTime() - RMTpgaTime > 30_000 || time === 0) {
				delete detected_list[Object.keys(detected_list)[index]];
				RMTpgaTime = 0;
				console.debug("檢知框框結束時間:", NOW().getTime());
				index--;
			} else {
				detected_box_list[Object.keys(detected_list)[index]] = L.polygon(TREM.Resources.area[Object.keys(detected_list)[index].toString()], {
					color     : TREM.color(Intensity),
					fillColor : "transparent",
				});
				let skip = false;

				if (Object.keys(eew).length != 0)
					for (let Index = 0; Index < Object.keys(eew).length; Index++) {
						let SKIP = 0;

						for (let i = 0; i < 4; i++) {
							const dis = Math.sqrt(Math.pow((TREM.Resources.area[Object.keys(detected_list)[index].toString()][i][0] - eew[Object.keys(eew)[Index]].lat) * 111, 2) + Math.pow((TREM.Resources.area[Object.keys(detected_list)[index].toString()][i][1] - eew[Object.keys(eew)[Index]].lon) * 101, 2));

							if (eew[Object.keys(eew)[Index]].km / 1000 > dis) SKIP++;
						}

						if (SKIP >= 4) {
							skip = true;
							break;
						}
					}

				if (skip) continue;

				if (RMT >= 2) Maps.main.addLayer(detected_box_list[Object.keys(detected_list)[index]]);
			}
		}

	if (!Object.keys(detected_list).length) PGACancel = false;

	if (RMT >= 2) RMT = 0;

	const All = (Json.Alert && Json.I && Json.I.length) ? Json.I : [];
	const list = [];

	// 震動檢測期間和速報一樣隱藏右側的地震報告；結束時若還有速報就維持隱藏
	if (All.length && !rtsRollHidden) {
		rtsRollHidden = true;
		$(roll).fadeOut(200);
	} else if (!All.length && rtsRollHidden) {
		rtsRollHidden = false;

		if (!Object.keys(eew).length) $(roll).fadeIn(200);
	}

	if (!All.length) {
		if (rtsWebhookEvent) rtsWebhookEvent.ended = true;

		PGAtag = -1;
		PGALimit = 0;
		IMAXdata = {};
	} else {
		for (let index = 0; index < All.length; index++) {
			if (station[All[index].uuid] == undefined) continue;
			All[index].loc = station[All[index].uuid].Loc;
		}

		if (All[0].intensity > PGAtag) {
			rtsWebhook(Json, All);

			if (setting["audio.realtime"])
				if (All[0].intensity >= 5 && PGAtag < 5) {
					log("Playing Audio > int2", 1, "Audio", "handler");
					dump({ level: 0, message: "Playing Audio > int2", origin: "Audio" });
					TREM.Audios.int2.play();
				} else if (All[0].intensity >= 2 && PGAtag < 2) {
					log("Playing Audio > int1", 1, "Audio", "handler");
					dump({ level: 0, message: "Playing Audio > int1", origin: "Audio" });
					TREM.Audios.int1.play();
				} else if (PGAtag == -1) {
					log("Playing Audio > int0", 1, "Audio", "handler");
					dump({ level: 0, message: "Playing Audio > int0", origin: "Audio" });
					TREM.Audios.int0.play();
				}

			setTimeout(() => {
				ipcRenderer.send("screenshotEEW", {
					Function : "station",
					ID       : 1,
					Version  : 1,
					Time     : NOW().getTime(),
					Shot     : 1,
				});
			}, 1250);
			changeView("main", "#mainView_btn");

			raiseMainWindow({ show: setting["Real-time.show"], cover: setting["Real-time.cover"], flash: true });
			PGAtag = All[0].intensity;
		}

		let count = 0;

		if (All.length <= 8) {
			for (let Index = 0; Index < All.length; Index++, count++) {
				if (All[Index].loc == undefined) continue;

				if (count >= 8) break;

				const id = All[Index].uuid.split("-")[2];

				if (!IMAXdata[id]) IMAXdata[id] = {};

				const Json_station = Json.station ? Json.station[id] : Json[id];
				const Json_station_v = Json_station.a ?? Json_station.pga;

				if (!IMAXdata[id].pga) IMAXdata[id].pga = Json_station_v;
				else if (IMAXdata[id].pga < Json_station_v) IMAXdata[id].pga = Json_station_v;
				const container = document.createElement("DIV");
				container.className = IntensityToClassString(All[Index].intensity);
				const location = document.createElement("span");
				location.innerText = `${All[Index].loc}\n${IMAXdata[id].pga} gal`;
				container.appendChild(document.createElement("span"));
				container.appendChild(location);
				list.push(container);
			}
		} else {
			const Idata = {};

			for (let Index = 0; Index < All.length; Index++, count++) {
				if (All[Index].loc == undefined) continue;

				if (Object.keys(Idata).length >= 8) break;
				const city = All[Index].loc.split(" ")[0];
				const id = All[Index].uuid.split("-")[2];
				const CPGA = (Idata[city] == undefined) ? 0 : Idata[city];
				const Json_station = Json.station ? Json.station[id] : Json[id];
				const Json_station_v = Json_station.a ?? Json_station.pga;

				if (Json_station_v > CPGA) {
					if (Idata[city] == undefined) Idata[city] = {};

					if (!IMAXdata[city]) IMAXdata[city] = {};

					if (!IMAXdata[city].pga) IMAXdata[city].pga = Json_station_v;
					else if (IMAXdata[city].pga < Json_station_v) IMAXdata[city].pga = Json_station_v;
					Idata[city].intensity = All[Index].intensity;
				}
			}

			for (let index = 0; index < Object.keys(Idata).length; index++) {
				const container = document.createElement("DIV");
				container.className = IntensityToClassString(Idata[Object.keys(Idata)[index]].intensity);
				const location = document.createElement("span");
				location.innerText = `${Object.keys(Idata)[index]}\n${IMAXdata[Object.keys(Idata)[index]].pga} gal`;
				container.appendChild(document.createElement("span"));
				container.appendChild(location);
				list.push(container);
			}
		}
	}

	document.getElementById("rt-list").replaceChildren(...list);
}

async function fetchStationData() {
	const { data, source, changed, error } = await fetchStationList();

	if (error) {
		log(error, 3, "Location", "fetchStationData");
		dump({ level: 2, message: error, origin: "Location" });
	}

	if (source && (changed || !station_loaded)) {
		log(`Get Station File from ${source}`, 1, "Location", "fetchStationData");
		dump({ level: 0, message: `Get Station File from ${source}`, origin: "Location" });
	}

	return { data, changed };
}

// 設定裡的測站若是舊網路的 ID，改成新網路裡距離最近的測站
async function migrateRealtimeStation() {
	const keys = [
		"Real-time.station",
		"Real-time.station.1",
		"Real-time.station.2",
		"Real-time.station.3",
		"Real-time.station.4",
		"Real-time.station.5",
	]
		.filter((key) => setting[key] && !station[setting[key]]);

	if (!keys.length) return;

	const legacy = await fetchLegacyStationList();

	for (const key of keys) {
		const chosen = setting[key];
		const old = legacy[String(chosen).split("-")[2]]?.info;

		if (!old?.length) continue;

		const at = old.reduce((a, b) => (new Date(b.time) > new Date(a.time) ? b : a));
		let nearest = "";
		let best = Infinity;

		for (const uuid of Object.keys(station)) {
			const km = Math.hypot((station[uuid].Lat - at.lat) * 111, (station[uuid].Long - at.lon) * 101);

			if (km < best) {
				best = km;
				nearest = uuid;
			}
		}

		if (!nearest) continue;

		log(`${key} ${chosen} is not in the new list, using nearest ${nearest} (${best.toFixed(1)} km)`, 1, "Location", "migrateRealtimeStation");
		setting[key] = nearest;
		ipcRenderer.send("config:value", key, nearest);
	}
}

// 測站清單每 5 分鐘更新（同 TREM-Lite），內容沒變就不處理
let station_loaded = false;

async function fetchFiles() {
	try {
		Location = require(path.resolve(__dirname, "../Resources/locations.json"));
		log("Get Location File", 1, "Location", "fetchFiles");
		dump({ level: 0, message: "Get Location File", origin: "Location" });

		const { data, changed } = await fetchStationData();

		if (Object.keys(data).length === 0) {
			// 抓不到時保留現有的測站資料，避免卡在載入畫面
			log("All station sources failed", 3, "Location", "fetchFiles");
			dump({ level: 2, message: "All station sources failed", origin: "Location" });
			return;
		}

		if (station_loaded && !changed) return;

		station_data = data;
		station_v2_run(station_data);

		if (!station_loaded) PGAMain();

		station_loaded = true;
		migrateRealtimeStation().catch((err) => log(err, 3, "Location", "migrateRealtimeStation"));
	} catch (err) {
		log(err, 3, "Location", "fetchFiles");
		dump({ level: 2, message: err, origin: "Location" });
	}
}

function station_v2_run(station_temp) {
	for (let k = 0, k_ks = Object.keys(station_temp), n = k_ks.length; k < n; k++) {
		const station_id = k_ks[k];
		const station_ = station_temp[station_id];

		//	if (!station_.work) continue;

		const station_net = station_.net === "MS-Net" ? "H" : "L";
		const work = station_.work;

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

		station[station_new_id] = { Lat, Long, Loc, area, work };
	}
}

// #region 用戶所在位置
/**
 * 設定用戶所在位置
 * @param {string} town 鄉鎮
 */
function setUserLocationMarker(town) {
	if (!Location)
		try {
			Location = require(path.resolve(__dirname, "../Resources/locations.json"));
			log("Get Location File 0", 1, "Location", "setUserLocationMarker");
			dump({ level: 0, message: "Get Location File 0", origin: "Location" });
		} catch (err) {
			console.log(err);
			log(err, 3, "Location", "setUserLocationMarker");
			dump({ level: 2, message: err, origin: "Location" });
		}

	if (setting["location.lat"] != "" && setting["location.lon"] != "")
		[
			, UserLocationLat,
			UserLocationLon,
		] = [
			null,
			setting["location.lat"],
			setting["location.lon"],
		];
	else
		[
			, UserLocationLat,
			UserLocationLon,
		] = Location[setting["location.city"]][town];

	if (!marker)
		marker = L.marker([UserLocationLat, UserLocationLon], {
			icon     : L.divIcon({ html: "<img id=\"here-marker\" src=\"../image/here.png\" height=\"20\" width=\"20\" style=\"z-index: 5000;\"></img>" }),
			keyboard : false,
		}).addTo(Maps.main);
	else marker.setLatLng([UserLocationLat, UserLocationLon]);

	if (!marker_report)
		marker_report = L.marker([UserLocationLat, UserLocationLon], {
			icon     : L.divIcon({ html: "<img id=\"here-marker\" src=\"../image/here.png\" height=\"20\" width=\"20\" style=\"z-index: 5000;\"></img>" }),
			keyboard : false,
		}).addTo(Maps.report);
	else marker_report.setLatLng([UserLocationLat, UserLocationLon]);

	log(`User location set to ${setting["location.city"]} ${town} (${UserLocationLat}, ${UserLocationLon})`, 1, "Location", "setUserLocationMarker");
	dump({ level: 0, message: `User location set to ${setting["location.city"]} ${town} (${UserLocationLat}, ${UserLocationLon})`, origin: "Location" });

	// Maps.main.fitBounds([[25.35, 119.65], [21.85, 124.05]]);
	Maps.main.setView([23.608428, 120.799168], 7.75);
}
// #endregion

// #region 聚焦
TREM.Earthquake.on("focus", ({ center, zoom } = {}) => {
	if (center) {
		let X = 0;

		if (zoom >= 6) X = 2.5;

		if (zoom >= 6.5) X = 1.6;

		if (zoom >= 7) X = 1.5;

		if (zoom >= 7.5) X = 0.9;

		if (zoom >= 8) X = 0.6;

		if (zoom >= 8.5) X = 0.4;

		if (zoom >= 9) X = 0.35;

		if (zoom >= 9.5) X = 0.2;

		Focus[0] = center[0];
		Focus[1] = center[1] + X;
		Focus[2] = zoom;

		// 要跟實際 setView 的中心比；之前比的是加了 X 的經度，永遠不相等，每 0.5 秒就整張地圖重畫一次
		if (Maps.main.getCenter().lat.toFixed(2) != center[0].toFixed(2) || Maps.main.getCenter().lng.toFixed(2) != center[1].toFixed(2) || zoom != Maps.main.getZoom())
			Maps.main.setView([center[0], center[1]], zoom);
	} else if (Focus.length != 0) {
		if (Maps.main.getBounds().getCenter().lat.toFixed(2) != Focus[0].toFixed(2) || Maps.main.getBounds().getCenter().lng.toFixed(2) != Focus[1].toFixed(2) || Focus[2] != Maps.main.getZoom())
			Maps.main.setView([Focus[0], Focus[1]], Focus[2]);
	}
});

function Mapsmainfocus() {
	TREM.Earthquake.emit("focus", { center: [23.608428, 120.799168], zoom: 7.75 });
}

// #endregion

// #region 音頻播放
/**
 * 依序播放的音效佇列：一段播完（或播放失敗、被略過）才播下一段
 * 之前用 0 ms 的 setInterval 輪詢鎖，播放期間每秒空轉幾百次；play() 失敗時鎖也不會解開，整個佇列卡到下一報
 * audio[lockKey] 為 true 表示正在播（速報倒數用它判斷要不要排下一個數字）
 */
function createAudioQueue(queueKey, lockKey, label, playbackRate = 1) {
	const dom = new Audio();

	const next = () => {
		const src = audio[queueKey].shift();

		if (src == undefined) {
			audio[lockKey] = false;
			return;
		}

		audio[lockKey] = true;

		// audio/1/ 是速報語音，關掉速報音效時略過
		if (src.startsWith("../audio/1/") && !setting["audio.eew"]) return next();

		log(`Playing ${label} > ${src}`, 1, "Audio", "audioQueue");
		dump({ level: 0, message: `Playing ${label} > ${src}`, origin: "Audio" });
		dom.src = src;
		dom.playbackRate = playbackRate;
		dom.play().catch((err) => {
			log(`${label} failed > ${src}: ${err}`, 2, "Audio", "audioQueue");
			next();
		});
	};

	dom.addEventListener("ended", next);

	return (src) => {
		audio[queueKey].push(src);

		if (!audio[lockKey]) next();
	};
}

const audioPlay = createAudioQueue("main", "main_lock", "Audio");
const audioPlay1 = createAudioQueue("minor", "minor_lock", "Audio 1", 1.1);
// #endregion

// #region Report Data
// 每 60 秒只查最新一筆（與 TREM-Lite 相同，ETag 驗證，沒變時只回 304），有新報告才重抓完整列表
const REPORT_NEWEST_MS = 60_000;

const isReportCached = (id) => {
	const cached = storage.getItem("report_data");

	return Array.isArray(cached) && cached.some((r) => r?.id === id);
};

// 抓完整列表後確認新報告真的存進來，沒有就重抓（最多 3 次），不必等下一輪
function fetchNewReport(id, attempt = 1) {
	ReportGET();
	setTimeout(() => {
		if (isReportCached(id)) return;

		log(`New report ${id} not stored after attempt ${attempt}`, 2, "EQReportFetcher", "fetchNewReport");

		if (attempt < 3) fetchNewReport(id, attempt + 1);
	}, 5_000);
}

async function checkNewestReport() {
	try {
		const res = await apiFetch("https://api.core.exptech.dev/api/v2/eq/report", { timeout: 5_000 });

		if (!res.ok) return;

		const [newest] = await res.json();

		if (newest && !isReportCached(newest.id)) {
			log(`New report ${newest.id}`, 1, "EQReportFetcher", "checkNewestReport");
			fetchNewReport(newest.id);
		}
	} catch (err) {
		log(err, 3, "EQReportFetcher", "checkNewestReport");
	}
}

// 目前的報告格式：id 形如 115075-2026-1101-162007；舊格式（identifier、CWB-EQ/CWA-EQ 等）不再支援
const REPORT_ID = /^\d+-\d{4}-\d{4}-\d{6}$/;

const isCurrentReport = (report) => !!report && !report.identifier && typeof report.id == "string" && REPORT_ID.test(report.id);

const formatReportTime = (time) => timeconvert(new Date(time)).format("YYYY/MM/DD HH:mm:ss");

function loadCachedReports() {
	const cached = storage.getItem("report_data");

	return Array.isArray(cached) ? cached.filter(isCurrentReport) : [];
}

// 清掉快取裡的舊格式報告（舊版殘留，或從設定匯入的舊檔案）
function migrateReportCache() {
	const cached = storage.getItem("report_data");

	if (!Array.isArray(cached)) {
		storage.setItem("report_data", []);
		return;
	}

	const reports = cached.filter(isCurrentReport);

	if (reports.length != cached.length) {
		log(`Dropped ${cached.length - reports.length} old-format cached reports`, 1, "EQReportFetcher", "migrateReportCache");
		storage.setItem("report_data", reports);
	}
}

// 新列表與快取合併：同一筆沿用快取的各地震度等資料，快取中不在新列表的報告也保留，依時間新到舊排序
function mergeReports(fresh, cached) {
	const cachedById = new Map(cached.map((report) => [report.id, report]));

	const merged = fresh.map((item) => {
		const report = { ...item, no: item.id.split("-")[0], originTime: formatReportTime(item.time) };
		const old = cachedById.get(item.id);

		if (old) {
			cachedById.delete(item.id);

			if (old.list) {
				report.list = old.list;
				report.Max_Level = old.Max_Level;
				report.Max_Level_areaName = old.Max_Level_areaName;
				report.Max_Level_stationName = old.Max_Level_stationName;
			}

			if (old.trem) {
				report.trem = old.trem;
				report.trem_list = old.trem_list;
			}

			if (old.show) report.show = old.show;
		}

		return report;
	});

	for (const report of cachedById.values()) {
		report.no ??= report.id.split("-")[0];
		report.originTime ??= formatReportTime(report.time);
		merged.push(report);
	}

	return merged.sort((a, b) => b.time - a.time);
}

// 新報告沒有各地震度時先抓詳細資料再顯示
function showNewReportWithDetail(report) {
	if (report.list) return showNewReport(report);

	apiFetch(`https://api.core.exptech.dev/api/v2/eq/report/${report.id}`, { timeout: 10_000 })
		.then((res) => {
			if (!res.ok) {
				console.error(res);
				log(res.status, 3, "report_list_info", "ReportGET");
				dump({ level: 2, message: res.status });
				return;
			}

			return res.json().then((detail) => {
				report.list = detail.list;
				showNewReport(report);
			});
		})
		.catch((err) => {
			console.log(err.message);
			log(err, 3, "report_list", "ReportGET");
			dump({ level: 2, message: err });
		});
}

function handleReportList(list, cached) {
	let reports = cached;

	if (list.length != 0) {
		reports = mergeReports(list, cached);

		const newest = reports[0];

		// 啟動後第一次抓到的最新報告不算新報告，避免每次開啟都跳通知
		if (!NewReportTag) NewReportTag = newest.id;

		if ((NOW().getTime() - newest.time) > 0 && NewReportTag != newest.id) {
			if (replay != 0) {
				log(`Skip new report ${newest.id}: replay in progress`, 2, "EQReportFetcher", "ReportGET");
				return;
			}

			NewReportTag = newest.id;

			// 不切換畫面時仍要把報告存起來，否則每次檢查都會把它當成新報告
			if (!setting["report.changeView"])
				log(`New report ${newest.id}: report.changeView off, not displayed`, 1, "EQReportFetcher", "ReportGET");
			else
				showNewReportWithDetail(newest);

			newest.show = true;
		}

		storage.setItem("report_data", reports);
	}

	log("Reports fetched", 1, "EQReportFetcher", "ReportGET");
	dump({ level: 0, message: "Reports fetched", origin: "EQReportFetcher" });
	cacheReport(reports);
}

function ReportGET(retried = false) {
	try {
		migrateReportCache();

		const cached = loadCachedReports();

		apiFetch(`https://api.core.exptech.dev/api/v2/eq/report?limit=${setting["cache.report"]}`, { timeout: 5_000 })
			.then((res) => {
				if (!res.ok) {
					console.error(res);
					log(`Error fetching reports (fetch) ${res.status}`, 3, "EQReportFetcher", "ReportGET");
					log(res, 3, "EQReportFetcher", "ReportGET");
					dump({ level: 2, message: `Error fetching reports (fetch) ${res.status}`, origin: "EQReportFetcher" });
					dump({ level: 2, message: res, origin: "EQReportFetcher" });
					cacheReport(cached);
					return;
				}

				return res.json()
					.then((list) => handleReportList(list.filter(isCurrentReport), cached))
					.catch((err) => {
						log("Error fetching reports (fetch) json", 3, "EQReportFetcher", "ReportGET");
						log(err, 3, "EQReportFetcher", "ReportGET");
						dump({ level: 2, message: "Error fetching reports (fetch) json", origin: "EQReportFetcher" });
						dump({ level: 2, message: err, origin: "EQReportFetcher" });
						cacheReport(cached);
					});
			})
			.catch((err) => {
				log("Error fetching reports (fetch)", 3, "EQReportFetcher", "ReportGET");
				log(err, 3, "EQReportFetcher", "ReportGET");
				dump({ level: 2, message: "Error fetching reports (fetch)", origin: "EQReportFetcher" });
				dump({ level: 2, message: err, origin: "EQReportFetcher" });
				cacheReport(cached);

				// 連線失敗時 30 秒後再試一次
				if (!retried) setTimeout(() => ReportGET(true), 30_000);
			});

		report_get_timestamp = Date.now();
	} catch (error) {
		log("Error fetching reports (try)", 3, "EQReportFetcher", "ReportGET");
		log(error, 3, "EQReportFetcher", "ReportGET");
		dump({ level: 2, message: "Error fetching reports (try)", origin: "EQReportFetcher" });
		dump({ level: 2, message: error, origin: "EQReportFetcher" });

		cacheReport(loadCachedReports());

		return setTimeout(() => {
			ReportGET();
		}, 60_000);
	}
}

function Report_GET_Max(report) {
	let Max_Level = 0;
	let Max_Level_areaName = "";
	let Max_Level_stationName = "";
	let Max_Level_distance = Number.POSITIVE_INFINITY;

	if (report.list) {
		for (let index = 0, keys = Object.keys(report.list), n = keys.length; index < n; index++) {
			const areaName = keys[index];

			if (Max_Level < report.list[areaName].int) {
				Max_Level = report.list[areaName].int;
				Max_Level_areaName = areaName;
				Max_Level_distance = Number.POSITIVE_INFINITY;
			}

			for (let station_index = 0, station_keys = Object.keys(report.list[areaName].town), o = station_keys.length; station_index < o; station_index++) {
				const station_name = station_keys[station_index];
				const station_temp = report.list[areaName].town[station_name];
				const distance = TREM.Utils.twoPointDistance(
					{ lat: report.lat, lon: report.lon },
					{ lat: station_temp.lat, lon: station_temp.lon },
				).toFixed(2);
				report.list[areaName].town[station_name].distance = distance;

				if (Max_Level_distance > parseFloat(distance))
					if (Max_Level_areaName === areaName) {
						if (Max_Level === station_temp.int) {
							Max_Level_stationName = station_name;
							Max_Level_distance = parseFloat(distance);
						}
					} else if (Max_Level === station_temp.int) {
						Max_Level_areaName = areaName;
						Max_Level_stationName = station_name;
						Max_Level_distance = parseFloat(distance);
					}

			}
		}

		report.Max_Level = Max_Level;
		report.Max_Level_areaName = Max_Level_areaName;
		report.Max_Level_stationName = Max_Level_stationName;
	}

	return report;
}

// 新報告自動切換到報告畫面（原本要先對應 TREM 自家報告才會切換，該 API 已下線）
function showNewReport(report) {
	report = Report_GET_Max(report);
	Report_GET_cwa(report);
	TREM.set_report_overview = 1;
	TREM.Report.report_trem = setting["report.trem"];
	TREM.Report.report_tremeew = setting["report.tremeew"];
	TREM.Report.setView("eq-report-overview", report);
	changeView("report", "#reportView_btn");
}

function Report_GET_cwa(report) {
	const location = report.loc.match(/(?<=位於).+(?=\))/);
	new Notification("地震報告",
		{
			body   : `${location}發生規模 ${report.mag.toFixed(1)} 有感地震，最大震度${report.Max_Level_areaName}${report.Max_Level_stationName}${TREM.Constants.intensities[report.list[report.Max_Level_areaName].town[report.Max_Level_stationName].int].text}。`,
			icon   : "../TREM.ico",
			silent : document.hasFocus(),
		});

	setTimeout(() => {
		ipcRenderer.send("screenshotEEW", {
			Function : "report",
			ID       : report.id,
			Version  : 1,
			Time     : NOW().getTime(),
			Shot     : 1,
		});
	}, 5000);

	if (TREM.MapIntensity.isTriggered)
		TREM.MapIntensity.clear();

	if (TREM.MapArea2.isTriggered)
		TREM.MapArea2.clear();

	if (setting["audio.report"]) audioPlay("../audio/Report.wav");

	raiseMainWindow({ show: setting["report.show"], cover: setting["report.cover"] });
}

ipcRenderer.on("ReportGET", () => {
	Report_GET();
});

function Report_GET() {
	const reports = loadCachedReports();

	if (reports.length != 0) cacheReport(reports);
}

ipcRenderer.on("ReportTREM", () => {
	TREM.Report.report_trem = setting["report.trem"];
	TREM.Report.report_tremeew = setting["report.tremeew"];

	if (TREM.Report.view == "report-overview" || TREM.Report.view == "eq-report-overview")
		if (TREM.Report.report_trem && TREM.Report._markersGroup) {
			TREM.Report._setuptremget(TREM.Report._report_Temp);
		} else if (!TREM.Report.report_trem && TREM.Report._markersGroup) {
			TREM.Report._markersGroup.removeFrom(Maps.report);

			let Station_i0 = 0;

			if (TREM.Report._markers.length) {
				for (const marker1 of TREM.Report._markers)
					marker1.remove();
				TREM.Report._markers = [];
			}

			TREM.Report.epicenterIcon.addTo(Maps.report);
			TREM.Report._markers.push(TREM.Report.epicenterIcon);

			for (let index = 0, keys = Object.keys(TREM.Report.report_station), n = keys.length; index < n; index++) {
				TREM.Report._markers.push(TREM.Report.report_station[Station_i0]);
				Station_i0 += 1;
			}

			TREM.Report._markersGroup = L.featureGroup(TREM.Report._markers).addTo(Maps.report);
			TREM.Report._setupzoomPredict();
		}
});

function cacheReport(reports) {
	const shown = reports.slice(0, setting["cache.report"]);

	TREM.Report.cache = new Map(shown.map((v) => [v.id, v]));

	if (Report != 0)
		ReportList(shown, {
			Max  : TREM.MapIntensity.MaxI,
			Time : formatReportTime(Report),
			time : Report,
		});
	else
		ReportList(shown);
}
// #endregion

// #region Report 點擊
// eslint-disable-next-line no-shadow
const openURL = url => {
	ipcRenderer.send("openURL", url);
};
// #endregion

// #region Report list
function ReportList(earthquakeReportArr, palert) {
	roll.replaceChildren();

	if (palert != undefined)
		addReport({ Max: palert.Max, Time: palert.Time, time: palert.time }, false, 0, true);

	for (let index = 0; index < earthquakeReportArr.length; index++)
		addReport(earthquakeReportArr[index], false, index + 1);

	setLocale(setting["general.locale"]);
}

function addReport(report, prepend = false, index = 0, palert = false) {
	if (!report) {
		log(`earthquake addReport >> ${report}`, 1, "addReport", "earthquake");
		return;
	}

	const OriginTime = report.time;

	if (replay != 0 && OriginTime > new Date(replay + (NOW().getTime() - replayT)).getTime()) return;

	const Level = IntensityI(report.int);
	let msg = "";
	let star = "";

	if (!palert) {
		if (report.loc.includes("("))
			msg = report.loc.substring(report.loc.indexOf("(") + 1, report.loc.indexOf(")")).replace("位於", "");
		else
			msg = report.loc;

		if (report.trem && report.trem != 1000) star += "↺ ";

		if (report.no && report.no % 1000 != 0) star += "✩ ";
	}

	const Div = document.createElement("div");
	Div.className = "md3-ripple ";

	if (report.Time != undefined && report.Max != undefined) {
		const report_container = document.createElement("div");
		report_container.className = "report-container locating";
		const report_intensity_container = document.createElement("div");
		report_intensity_container.className = "report-intensity-container";

		const report_intensity_title_container = document.createElement("div");
		report_intensity_title_container.className = "report-intensity-title-container";

		const report_intensity_title_en = document.createElement("span");
		report_intensity_title_en.lang = "en";
		report_intensity_title_en.className = "report-intensity-title";
		report_intensity_title_en.innerText = "Max Int.";
		const report_intensity_title_ja = document.createElement("span");
		report_intensity_title_ja.lang = "ja";
		report_intensity_title_ja.className = "report-intensity-title";
		report_intensity_title_ja.innerText = "最大震度";
		const report_intensity_title_kr = document.createElement("span");
		report_intensity_title_kr.lang = "kr";
		report_intensity_title_kr.className = "report-intensity-title";
		report_intensity_title_kr.innerText = "최대진도";
		const report_intensity_title_ru = document.createElement("span");
		report_intensity_title_ru.lang = "ru";
		report_intensity_title_ru.className = "report-intensity-title";
		report_intensity_title_ru.innerText = "Макс интенси";
		report_intensity_title_ru.style = "font-size: 14px;line-height: 14px";
		const report_intensity_title_zh_tw = document.createElement("span");
		report_intensity_title_zh_tw.lang = "zh-TW";
		report_intensity_title_zh_tw.className = "report-intensity-title";
		report_intensity_title_zh_tw.innerText = "最大震度";
		const report_intensity_title_zh_cn = document.createElement("span");
		report_intensity_title_zh_cn.lang = "zh-CN";
		report_intensity_title_zh_cn.className = "report-intensity-title";
		report_intensity_title_zh_cn.innerText = "最大震度";

		report_intensity_title_container.append(report_intensity_title_en, report_intensity_title_ja, report_intensity_title_kr, report_intensity_title_ru, report_intensity_title_zh_tw, report_intensity_title_zh_cn);
		report_intensity_title_container.childNodes.forEach((node) => node.style.display = node.lang == setting["general.locale"] ? "unset" : "none");

		const report_intensity_value = document.createElement("span");
		report_intensity_value.className = "report-intensity-value";
		report_intensity_value.innerText = IntensityI(report.Max);
		report_intensity_container.append(report_intensity_title_container, report_intensity_value);

		const report_detail_container = document.createElement("div");
		report_detail_container.className = "report-detail-container";

		const report_PAlert = document.createElement("span");

		if (TREM.MapIntensity.trem) {
			report_PAlert.className = "report-PAlert";
			report_PAlert.innerText = "來源 TREM";
		} else {
			report_PAlert.className = "report-PAlert";
			report_PAlert.innerText = "來源 P-Alert";
		}

		const report_location = document.createElement("span");
		report_location.className = "report-location";
		report_location.innerText = "震源 調查中";
		const report_time = document.createElement("span");
		report_time.className = "report-time";
		report_time.innerText = report.Time.replace(/-/g, "/");
		report_detail_container.append(report_PAlert, report_location, report_time);

		report_container.append(report_intensity_container, report_detail_container);
		Div.prepend(report_container);
		Div.className += IntensityToClassString(report.Max);
		ripple(Div);
		roll.prepend(Div);
		investigation = true;
	} else {
		const report_container = document.createElement("div");
		report_container.className = "report-container";

		const report_intensity_container = document.createElement("div");
		report_intensity_container.className = "report-intensity-container";

		const report_intensity_title_container = document.createElement("div");
		report_intensity_title_container.className = "report-intensity-title-container";

		const report_intensity_title_en = document.createElement("span");
		report_intensity_title_en.lang = "en";
		report_intensity_title_en.className = "report-intensity-title";
		report_intensity_title_en.innerText = "Max Int.";
		const report_intensity_title_ja = document.createElement("span");
		report_intensity_title_ja.lang = "ja";
		report_intensity_title_ja.className = "report-intensity-title";
		report_intensity_title_ja.innerText = "最大震度";
		const report_intensity_title_kr = document.createElement("span");
		report_intensity_title_kr.lang = "kr";
		report_intensity_title_kr.className = "report-intensity-title";
		report_intensity_title_kr.innerText = "최대진도";
		const report_intensity_title_ru = document.createElement("span");
		report_intensity_title_ru.lang = "ru";
		report_intensity_title_ru.className = "report-intensity-title";
		report_intensity_title_ru.innerText = "Макс интенси";
		report_intensity_title_ru.style = "font-size: 14px;line-height: 14px";
		const report_intensity_title_zh_tw = document.createElement("span");
		report_intensity_title_zh_tw.lang = "zh-TW";
		report_intensity_title_zh_tw.className = "report-intensity-title";
		report_intensity_title_zh_tw.innerText = "最大震度";
		const report_intensity_title_zh_cn = document.createElement("span");
		report_intensity_title_zh_cn.lang = "zh-CN";
		report_intensity_title_zh_cn.className = "report-intensity-title";
		report_intensity_title_zh_cn.innerText = "最大震度";

		report_intensity_title_container.append(report_intensity_title_en, report_intensity_title_ja, report_intensity_title_kr, report_intensity_title_ru, report_intensity_title_zh_tw, report_intensity_title_zh_cn);
		report_intensity_title_container.childNodes.forEach((node) => node.style.display = node.lang == setting["general.locale"] ? "unset" : "none");

		const report_intensity_value = document.createElement("span");
		report_intensity_value.className = "report-intensity-value";
		report_intensity_value.innerText = Level;
		report_intensity_container.append(report_intensity_title_container, report_intensity_value);

		const report_detail_container = document.createElement("div");
		report_detail_container.className = "report-detail-container";

		const report_location = document.createElement("span");
		report_location.className = "report-location";
		report_location.innerText = `${star}${msg}`;

		if (msg.length > 9 && index != 0) report_location.style = "font-size: 16px;";

		if (msg.length > 10 && index != 0) report_location.style = "font-size: 14px;";

		if (msg.length > 12 && index != 0) report_location.style = "font-size: 12px;";

		if (msg.length > 9 && index == 0) report_location.style = "font-size: 20px;";

		if (msg.length > 10 && index == 0) report_location.style = "font-size: 18px;";

		if (msg.length > 12 && index == 0) report_location.style = "font-size: 16px;";
		const report_time = document.createElement("span");
		report_time.className = "report-time";
		report_time.innerText = timeconvert(new Date(OriginTime)).format("YYYY/MM/DD HH:mm:ss");
		const report_magnitude = document.createElement("span");
		report_magnitude.className = "report-magnitude";

		if (report.mag) report_magnitude.innerText = report.mag.toFixed(1);

		const report_depth = document.createElement("span");
		report_depth.className = "report-depth";
		report_depth.innerText = report.depth;
		report_detail_container.append(report_location, report_time, report_magnitude, report_depth);

		report_container.append(report_intensity_container, report_detail_container);
		ripple(Div);
		Div.append(report_container);
		Div.className += IntensityToClassString(report.int);
		Div.addEventListener("click", () => {
			if (replay != 0) return;
			TREM.set_report_overview = 1;
			TREM.Report.setView("eq-report-overview", report);
			changeView("report", "#reportView_btn");
			// ReportTag = NOW().getTime();
			// console.debug("ReportTag: ", ReportTag);
		});
		Div.addEventListener("contextmenu", () => {
			if (replay != 0) return;

			TREM.Report.replay(report.id);
		});

		if (prepend) {
			const locating = document.querySelector(".report-detail-container.locating");

			if (locating) {
				locating.replaceWith(Div.children[0]);
			} else {
				if (investigation) {
					investigation = false;
					roll.removeChild(roll.children[0]);
				}

				roll.prepend(Div);
			}

			if (Report != 0) {
				Report = 0;
				TREM.MapIntensity.MaxI = -1;
			}

			report.no ??= report.id.split("-")[0];
			report.originTime ??= formatReportTime(report.time);

			const _report_data = loadCachedReports().filter((v) => v.id !== report.id);
			_report_data.push(report);
			_report_data.sort((a, b) => b.time - a.time);
			storage.setItem("report_data", _report_data);

			TREM.Report.cache.set(report.id, report);
			TREM.Report.setView("eq-report-overview", report);
			changeView("report", "#reportView_btn");
		} else {
			roll.append(Div);
		}
	}
}

// #endregion

ipcRenderer.on("Olddatabase_report", (event, json) => {
	TREM.set_report_overview = 1;
	TREM.Report.setView("eq-report-overview", json);
	changeView("report", "#reportView_btn");
});

// #region 檔案
function openFileWindow() {
	ipcRenderer.send("openFileWindow");
	toggleNav(false);
}

ipcRenderer.on("readReplayFile", (event, filePaths) => {
	try {
		fs.readFile(filePaths[0], async (err, deta) => {
			if (err) throw err;
			await JSZip.loadAsync(deta).then(async (zip) => {
				const replayData = [];

				for (let i = 0, k = Object.keys(zip.files), n = k.length; i < n; i++) {
					const filename = k[i];
					const content = await zip.files[filename].async("string");
					const data = JSON.parse(content);
					data.rts.replay = true;
					data.eew.forEach((e) => (e.replay = true));
					data.time = +filename;
					replayData.push(data);
				}

				const replayLength = replayData.length;
				let replayPercentage = 0;
				console.log(`[Replay] Loaded ${replayLength} frames.`);

				let replay_time = NOW().getTime();

				const emitEvents = () => {
					const current = replayData.shift();
					current.rts = toRtsV2(current.rts);

					replayTemp = current.rts.time;
					handler(current.rts);
					current.eew.forEach((e) => {
						if (e.serial == 1) replay_time = NOW().getTime() - 3000;

						e.replay_time = e.eq.time;
						e.replay_timestamp = replayTemp;
						e.time = replay_time;
						e.timestamp = NOW().getTime();
						e.Unit = (e.scale == 1) ? "PLUM(局部無阻尼運動傳播法)"
							: (e.author == "scdzj") ? "四川省地震局 (SCDZJ)"
								: (e.author == "nied") ? "防災科学技術研究所 (NIED)"
									: (e.author == "kma") ? "기상청(KMA)"
										: (e.author == "jma") ? "気象庁(JMA)"
											: (e.author == "cwa") ? "中央氣象署 (CWA)"
												: (e.author == "fjdzj") ? "福建省地震局 (FJDZJ)"
													: (e.author == "trem" && e.serial > 3) ? "TREM(實驗功能僅供參考)"
														: (e.author == "trem" && e.serial <= 3) ? "NSSPE(無震源參數推算)"
															: (e.Unit) ? e.Unit : "";
						FCMdata(e, "cache");
					});

					const newReplayPercentage = ~~(
						(1 - replayData.length / replayLength) * 10
					);

					if (newReplayPercentage > replayPercentage)
						console.log(`[Replay] ${`${newReplayPercentage * 10}`.padStart(3, " ")}% [${"#".repeat(newReplayPercentage).padEnd(10, ".")}] | Frame ${replayLength - replayData.length}`);

					replayPercentage = newReplayPercentage;

					Timers.replay = setTimeout(
						emitEvents,
						replayData[0] ? replayData[0].time - current.time : 1_000,
					);
				};

				replayD = false;
				replayF = true;
				replay = replayData[0].time;
				replayTemp = replay;
				replayT = NOW().getTime();
				ReportTag = 0;
				console.debug("ReportTag: ", ReportTag);
				Report_GET();
				stopReplaybtn();
				PGAMain();
				emitEvents();
			});
		});
	} catch (error) {
		console.error("[Replay] Exception thrown while loading replay.", error);
	}
});


// #region 設定
function openSettingWindow() {
	// document.getElementById("setting_btn").classList.add("hide");
	win.setAlwaysOnTop(false);
	ipcRenderer.send("openChildWindow");
	toggleNav(false);
}

// #region RTS
function openRTSWindow() {
	win.setAlwaysOnTop(false);
	ipcRenderer.send("openRTSWindow");
	toggleNav(false);
}

// #region RTS
function openIntensityWindow() {
	win.setAlwaysOnTop(false);
	ipcRenderer.send("openIntensityWindow");
	toggleNav(false);
}
// #endregion

// #region Number >> Intensity
function IntensityI(Intensity) {
	return Intensity == 5 ? "5-"
		: Intensity == 6 ? "5+"
			: Intensity == 7 ? "6-"
				: Intensity == 8 ? "6+"
					: Intensity == 9 ? "7"
						: Intensity ?? "--";
}
// #endregion

// #region Intensity >> Number
function IntensityN(level) {
	return level == "5-" ? 5
		: level == "5+" ? 6
			: level == "6-" ? 7
				: level == "6+" ? 8
					: level == "7" ? 9
						: Number(level);
}
// #endregion

// #region Intensity >> Class String
// 顏色亮度的結果記起來：每個觸發中的測站每秒都會呼叫，tinycolor 解析顏色不便宜
const lightColorCache = new Map();

function isLightColor(color) {
	if (!lightColorCache.has(color)) lightColorCache.set(color, tinycolor(color).getLuminance() > 0.575);
	return lightColorCache.get(color);
}

function IntensityToClassString(level) {
	let classname = (level == 9) ? "seven"
		: (level == 8) ? "six strong"
			: (level == 7) ? "six"
				: (level == 6) ? "five strong"
					: (level == 5) ? "five"
						: (level == 4) ? "four"
							: (level == 3) ? "three"
								: (level == 2) ? "two"
									: (level == 1) ? "one"
										: (level == "na") ? "na"
											: "zero";

	if (isLightColor(setting["theme.customColor"] ? setting[`theme.int.${level}`] : [
		"#757575",
		"#757575",
		"#2774C2",
		"#7BA822",
		"#E8D630",
		"#E68439",
		"#DB641F",
		"#F55647",
		"#DB1F1F",
		"#862DB3",
	][level]))
		classname += " darkText";

	return classname;
}
// #endregion

// #region color
TREM.color = function color(Intensity) {
	return setting["theme.customColor"] ? setting[`theme.int.${Intensity}`]
		: [
			"#757575",
			"#757575",
			"#2774C2",
			"#7BA822",
			"#E8D630",
			"#E68439",
			"#DB641F",
			"#F55647",
			"#DB1F1F",
			"#862DB3",
		][Intensity];
	// return ["#666666", "#0165CC", "#01BB02", "#EBC000", "#FF8400", "#E06300", "#FF0000", "#B50000", "#68009E"][Intensity ? Intensity - 1 : Intensity];
};
// #endregion


// #region IPC
// 海嘯資訊（原本由舊 WebSocket 推送）：每 60 秒查詢氣象署海嘯報告列表，有新報告時轉成舊格式送進 FCMdata
const TSUNAMI_LIST_URL = "https://api.core.exptech.dev/api/v1/cwa/tsunami";
const TSUNAMI_POLL_MS = 60_000;
const TSUNAMI_MAX_AGE_MS = 6 * 3600_000;
const tsunami_predict = {};

// API 的預估浪高（<1、1~3、3~6、>6，單位公尺）轉成 tsunami_color 使用的字串
function tsunamiWaveLevel(height) {
	const h = String(height).replace(/\s/g, "");

	if (/^>6|大於6/.test(h)) return "大於6公尺";

	if (/^3[~至-]6/.test(h)) return "3至6公尺";

	if (/^1[~至-]3/.test(h)) return "1至3公尺";

	return "小於1公尺";
}

/**
 * 海嘯報告轉成舊格式 { type, number, cancel, lat, lon, time, area: [{ areaName, waveHeight, arrivalTime }] }。
 * 預報（predict）的 area 是沿海分區；實測（observe）的是觀測站，沿用同一地震最後的預報分區上色。
 */
function toLegacyTsunami(detail) {
	if (detail.data?.type === "predict")
		tsunami_predict[detail.no] = detail.data.area.map(([
			areaName, , waveHeight,
			arrivalTime,
		]) => ({
			areaName,
			waveHeight  : tsunamiWaveLevel(waveHeight),
			arrivalTime : arrivalTime,
		}));

	return {
		type      : "tsunami",
		id        : detail.id,
		number    : parseInt(String(detail.rep).replace(/\D/g, "")) || 1,
		cancel    : detail.msgType === "Cancel",
		lat       : detail.eq.lat,
		lon       : detail.eq.lon,
		time      : detail.eq.t,
		area      : tsunami_predict[detail.no] ?? [],
		timestamp : realNow(),
	};
}

async function checkTsunami() {
	try {
		const res = await apiFetch(TSUNAMI_LIST_URL, { timeout: 5_000 });

		if (!res.ok) return;

		const { reports = [] } = await res.json();
		const seen = new Set(JSON.parse(localStorage.tsunami_seen ?? "null") ?? []);
		const firstRun = localStorage.tsunami_seen == undefined;
		const fresh = reports
			.filter((r) => !seen.has(r.id))
			.sort((a, b) => a.sent - b.sent);

		for (const r of fresh) {
			seen.add(r.id);

			// 第一次啟動只記錄既有報告，不提醒；也不提醒太舊的報告
			if (firstRun || realNow() - r.sent > TSUNAMI_MAX_AGE_MS) continue;

			const detailRes = await apiFetch(`${TSUNAMI_LIST_URL}/${r.id}`, { timeout: 5_000 });

			if (!detailRes.ok) {
				seen.delete(r.id);
				continue;
			}

			const tsunami = toLegacyTsunami(await detailRes.json());
			log(`Tsunami ${r.id} ${r.rep} ${r.type}`, 1, "Tsunami", "checkTsunami");
			FCMdata(tsunami, "http");
		}

		localStorage.tsunami_seen = JSON.stringify([...seen].slice(-200));
	} catch (err) {
		log(err, 3, "Tsunami", "checkTsunami");
	}
}

// 啟動即時資料、速報與校時（原本要等 winserver.jar 發出 start 才會執行）
function startServices() {
	try {
		if (localStorage.rts_alert_false == undefined) {
			localStorage.rts_alert_false = true;
			ipcRenderer.send("config:value", "Real-time.alert", false);
		}

		freertsget();
		fetch_eew();
		fetch_ntp();
		// 地震報告列表（原本由 winserver.jar 在啟動時呼叫）
		ReportGET();
		checkTsunami();
		setInterval(checkTsunami, TSUNAMI_POLL_MS);

		log("Services started", 1, "Initialization", "start");
		dump({ level: 0, message: "Services started", origin: "Initialization" });
	} catch (error) {
		showDialog("error", "發生錯誤", `初始化過程中發生錯誤，您可以繼續使用此應用程式，但無法保證所有功能皆能繼續正常運作。\n\n如果這是您第一次看到這個訊息，請嘗試重新啟動應用程式。\n如果這個錯誤持續出現，請到 TREM Discord 伺服器回報問題。\n\n錯誤訊息：${error}`);
		$("#load").delay(1000).fadeOut(1000);
		log(error, 3, "Initialization", "start");
		dump({ level: 2, message: error, origin: "Initialization" });
	}
}

// 舊的 /trem/rts HTTP 輪詢已下線，改用 SSE 即時推送（資料為 gzip + base64 的 JSON）

function decodeSSEText(data) {
	if (/^\s*[{[<]/.test(data)) return data;

	return require("node:zlib").gunzipSync(Buffer.from(data.replace(/\s+/g, ""), "base64")).toString();
}

function decodeSSEData(data) {
	return JSON.parse(decodeSSEText(data));
}

// trem.intensity.v1 為 TREM XML（參考 TREM-Lite intensityV1.ts readIntensityXml），轉成舊版震度速報格式
function readIntensityXml(xml) {
	const LEVEL_CODES = [
		"0",
		"1",
		"2",
		"3",
		"4",
		"5-",
		"5+",
		"6-",
		"6+",
		"7",
	];
	const STATUS = { 發表: "issued", 更新: "updated", 最終: "final", 取消: "cancel" };
	const head = (xml.match(/<Head>([\s\S]*?)<\/Head>/)?.[1] ?? "").replace(/<RelatedEewEvents>[\s\S]*?<\/RelatedEewEvents>/, "");
	const stamp = head.match(/<EventID>(\d{14})<\/EventID>/)?.[1];
	const serial = Number(head.match(/<Serial>(\d+)<\/Serial>/)?.[1]);

	if (!stamp || !Number.isFinite(serial)) return null;

	// EventID 為 +08:00 的 YYYYMMDDHHMMSS
	const [
		y,
		mo,
		d,
		h,
		mi,
		s,
	] = [
		0,
		4,
		6,
		8,
		10,
		12,
	].map((at, n) => Number(stamp.slice(at, n ? at + 2 : 4)));
	const area = {};

	for (const [
		, code,
		towns,
	] of xml.matchAll(/<Area level="([^"]+)">([\s\S]*?)<\/Area>/g)) {
		const level = LEVEL_CODES.indexOf(code);

		if (level < 1) continue;

		area[level] = [...towns.matchAll(/<Town code="(\d+)"/g)].map((m) => Number(m[1]));
	}

	const infoType = head.match(/<InfoType>([^<]*)<\/InfoType>/)?.[1] ?? "";

	return {
		type      : "intensity",
		author    : "trem",
		id        : Date.UTC(y, mo - 1, d, h - 8, mi, s),
		serial,
		status    : STATUS[infoType] ?? infoType,
		final     : infoType === "最終",
		area,
		max       : Math.max(0, ...Object.keys(area).map(Number)),
		timestamp : realNow(),
	};
}

// 浮點震度轉 0~9 級（同 TREM-Lite intensity_float_to_int）
const rtsIntensityLevel = (i) => (i < 0 ? 0 : i < 4.5 ? Math.round(i) : i < 6.5 ? Math.floor(i * 2) - 4 : 9);

function rtsBoxOf(lat, lon) {
	for (const [key, corners] of Object.entries(TREM.Resources.area)) {
		const lats = corners.map((c) => c[0]);
		const lons = corners.map((c) => c[1]);

		if (lat >= Math.min(...lats) && lat <= Math.max(...lats) && lon >= Math.min(...lons) && lon <= Math.max(...lons))
			return key;
	}

	return null;
}

// rts.v1 只給每站的 i/pga/alert；舊版 v2 由伺服器算的 box、I、area 改在這裡用 alert 測站算出
function rtsV1ToV2(ans) {
	const stations = ans.stations ?? ans.station ?? {};
	const uuidOf = {};

	for (const uuid of Object.keys(station)) uuidOf[uuid.split("-")[2]] = uuid;

	const box = {};
	const I = [];
	const area = new Set();

	for (const id of Object.keys(stations)) {
		const s = stations[id];
		s.alert = s.alert === 1 || s.alert === "1" || s.alert === true;

		if (!s.alert || typeof s.i !== "number") continue;

		const uuid = uuidOf[id];

		if (!uuid) continue;

		const level = rtsIntensityLevel(s.i);
		const key = rtsBoxOf(station[uuid].Lat, station[uuid].Long);

		if (key !== null && (box[key] ?? -1) < level) box[key] = level;

		I.push({ uuid, intensity: level });

		if (station[uuid].area) area.add(station[uuid].area);
	}

	I.sort((a, b) => b.intensity - a.intensity);

	return {
		station : stations,
		time    : ans.ts ?? ans.time,
		Alert   : I.length > 0,
		box,
		I,
		area    : [...area],
	};
}

// 重播資料可能是新的 rts.v1 或舊的 v2 格式
const toRtsV2 = (rts) => (rts?.stations ? rtsV1ToV2(rts) : rts);

// 兩條 SSE 即時串流（同 TREM-Lite）：
// * trem：RTS 與 TREM 震度速報，視窗隱藏時拿掉 mode=live，伺服器只送有觸發測站的資料
// * eew：各機關的地震速報（目前生效中的列表）
const TREM_SSE_TOPICS = "trem.intensity.v1,trem.rts.v1";
// 本專案關閉了 backgroundThrottling，document.visibilityState 不會變，改看視窗本身
const isMainWindowHidden = () => !win.isVisible() || win.isMinimized();
let rts_background = isMainWindowHidden();
let trem_sse = null;
let eew_sse = null;

// 速報與震度速報的去重（參考 TREM-Lite features/data/data.ts）：
// 記住每個 id 收到過的最大報數，結束後仍保留一段時間，避免重連或串流重送時被當成新的再觸發一次
const EEW_EXPIRY_MS = 240_000;
const INTENSITY_EXPIRY_MS = 600_000;
const eew_last = new Map();
const intensity_last = new Map();

/** 速報是否該處理：發震超過 240 秒、或同一報已處理過的略過。 */
function acceptEew(e) {
	const now = realNow();

	if (!e.eq?.time || now - e.eq.time > EEW_EXPIRY_MS) {
		// 伺服器仍當成生效中（發布時距發震 240 秒內），本機卻判為過期：時鐘可能不準
		if (e.time && e.eq?.time && e.time - e.eq.time <= EEW_EXPIRY_MS)
			log(`Skip EEW ${e.id} #${e.serial}: local clock is ${Math.round((now - e.time) / 1000)}s behind its issue time, clock may be wrong`, 2, "server", "eew-sse");

		return false;
	}

	const last = eew_last.get(e.id);

	if (last && last.serial >= e.serial) return false;

	eew_last.set(e.id, { serial: e.serial, time: now });
	return true;
}

/** 震度速報是否該處理：超過 10 分鐘、同一報、或新報數但範圍沒變的略過。 */
function acceptIntensity(report) {
	const now = realNow();

	if (now - report.id > INTENSITY_EXPIRY_MS) return false;

	const areaKey = JSON.stringify(Object.keys(report.area).sort().map((level) => [level, [...report.area[level]].sort()]));
	const last = intensity_last.get(report.id);

	if (last && last.serial >= report.serial) return false;

	intensity_last.set(report.id, { serial: report.serial, areaKey, time: now });

	return !last || last.areaKey !== areaKey;
}

setInterval(() => {
	const now = realNow();

	for (const [id, v] of eew_last) if (now - v.time > EEW_EXPIRY_MS * 2) eew_last.delete(id);

	for (const [id, v] of intensity_last) if (now - v.time > INTENSITY_EXPIRY_MS * 2) intensity_last.delete(id);
}, 60_000);

// 斷線或睡眠喚醒後自動恢復：網路回來時立即重開串流（新連線就緒後才關舊的），不再要求重新啟動
window.addEventListener("offline", () => log("Network offline, streams will reconnect when it is back", 2, "server", "network"));
window.addEventListener("online", () => {
	log("Network online, reconnecting streams", 1, "server", "network");
	trem_sse?.switchUrl();
	eew_sse?.switchUrl();
	checkNewestReport();
});

// 距離上一筆即時資料的秒數（本機收到時間），尚未收到時顯示 --
const rtsAge = () => (rts_response?.Time ? ((Date.now() - rts_response.Time) / 1000).toFixed(1) : "--");

/**
 * 即時資料是否中斷（參考 TREM-Lite）：即時模式超過 3 秒沒有新資料，
 * 或串流連線中斷超過 3 秒（背景模式平常就沒有資料，只看連線）。
 */
let rts_disconnected_since = 0;

function isRtsDesynced() {
	if (!trem_sse || trem_sse.stopped) return false;

	if (trem_sse.connected) rts_disconnected_since = 0;
	else rts_disconnected_since ||= Date.now();

	if (rts_disconnected_since && Date.now() - rts_disconnected_since > 3_000) return true;

	return !rts_background && rts_ws_timestamp > 0 && Date.now() - rts_ws_timestamp > 3_000;
}

function onSSEHeartbeat(text) {
	const ts = text.match(/^ping (\d+)/)?.[1];

	if (ts) adoptServerTime(Number(ts) * 1000);
}

function freertsget() {
	trem_sse ??= new SSEStream({
		label   : "trem",
		url     : () => `https://api.lb.exptech.dev/api/v1/trem/sse?topics=${TREM_SSE_TOPICS}${rts_background ? "" : "&mode=live"}`,
		// live 模式每秒都有即時資料，15 秒沒收到就重連；背景模式只有觸發資料與心跳、或從沒收到過資料（例如沒有權限）時用預設值，
		// 不然會一直斷線重連
		staleMs : () => (rts_background || !rts_ws_timestamp ? 90_000 : 15_000),
		onEvent : (event, data) => {
			if (event === "info") {
				log(`trem SSE connected ${data}`, 1, "server", "rts-sse");
			} else if (event === "trem.rts.v1") {
				const ans = rtsV1ToV2(decodeSSEData(data));
				rts_ws_timestamp = Date.now();
				ans.Time = rts_ws_timestamp;
				rts_response = ans;
			} else if (event === "trem.intensity.v1") {
				const report = readIntensityXml(decodeSSEText(data));

				if (report && acceptIntensity(report)) FCMdata(report, "sse");
			}
		},
		onComment : onSSEHeartbeat,
		log       : (message, level) => log(message, level, "server", "rts-sse"),
	});
	trem_sse.start();
}

// 背景模式只在有觸發時才有資料；觸發結束後不會再送，需自行清掉最後一筆的觸發狀態
setInterval(() => {
	if (!rts_background || !rts_response?.Alert || Date.now() - rts_ws_timestamp < 3_000) return;

	const station_cleared = {};

	for (const [id, s] of Object.entries(rts_response.station ?? {})) station_cleared[id] = { ...s, alert: false };

	rts_response = { ...rts_response, station: station_cleared, Alert: false, box: {}, I: [], area: [] };
}, 1_000);

function updateRtsBackground() {
	const hidden = isMainWindowHidden();

	if (hidden === rts_background) return;

	rts_background = hidden;
	log(`trem SSE -> ${hidden ? "background (triggered frames only)" : "live"}`, 1, "server", "rts-sse");
	trem_sse?.switchUrl();
}

for (const event of [
	"show",
	"hide",
	"minimize",
	"restore",
]) win.on(event, updateRtsBackground);

function fetch_eew() {
	eew_sse ??= new SSEStream({
		label   : "eew",
		url     : () => "https://api.lb.exptech.dev/api/v2/eq/eew?sse=1",
		onEvent : (event, data) => {
			if (event === "info") {
				log(`eew SSE connected ${data}`, 1, "server", "eew-sse");
				return;
			}

			if (event !== "message") return;

			HTTP = true;

			// 每筆各自處理，一筆出錯不影響同一批的其他速報
			for (const e of JSON.parse(data))
				try {
					if (!acceptEew(e)) continue;

					e.type = "eew";
					e.timestamp = realNow();
					FCMdata(e, "http");
				} catch (err) {
					log(`EEW ${e?.id} failed: ${err}`, 3, "server", "eew-sse");
				}
		},
		onComment : onSSEHeartbeat,
		log       : (message, level) => {
			if (level === 3) HTTP = false;

			log(message, level, "server", "eew-sse");
		},
	});
	eew_sse.start();
}

// 校時與區域節點探測（每 10 分鐘校時、每 30 秒探測，同 TREM-Lite）
function fetch_ntp() {
	setEndpointLogger((message) => log(message, 1, "server", "endpoints"));
	startProbing();
	startClock((message, level) => log(message, level, "server", "clock"));
}

const stopReplay = function() {
	// 只有重播中才結束速報與檢知框；一般回到主畫面時不能把即時的速報一起結束
	const replaying = replay != 0 || replayTemp != 0 || replayT != 0 || replaydir != 0 || replayD || replayF || replaytestEEW != 0;

	if (replaying && Object.keys(EarthquakeList).length != 0) Cancel = true;

	if (replaying && Object.keys(detected_list).length != 0) PGACancel = true;

	replaytestEEW = 0;

	if (replay != 0 || Report != 0 || replayTemp != 0 || replayT != 0 || replaydir != 0 || replayD || replayF) {
		intensitytag = -1;
		replay = 0;
		Report = 0;
		TREM.MapIntensity.MaxI = -1;
		replayTemp = 0;
		replayT = 0;
		replaydir = 0;
		replayD = false;
		replayF = false;

		if (Timers.rts_clock) clearInterval(Timers.rts_clock);

		if (Timers.eew_clock) clearInterval(Timers.eew_clock);

		if (Timers.replay) clearInterval(Timers.replay);

		TREM.Report.replayHttp = false;
		PGAMain();
		Report_GET();
	}

	if (TREM.MapIntensity.isTriggered)
		TREM.MapIntensity.clear();

	if (TREM.MapArea2.isTriggered)
		TREM.MapArea2.clear();

	WarnAudio = Date.now() + 3000;

	stationnow = 0;
	stationnowall = 0;

	if (TREM.speech.speaking()) TREM.speech.cancel();

	Mapsmainfocus();
	unstopReplaybtn();
	globalgc();
};

function unstopReplaybtn() {
	document.getElementById("togglenav_btn").classList.remove("hide");
	document.getElementById("stopReplay").classList.add("hide");
}

function stopReplaybtn() {
	changeView("main", "#mainView_btn");
	document.getElementById("togglenav_btn").classList.add("hide");
	document.getElementById("stopReplay").classList.remove("hide");
}

TREM.backindexButton = () => {
	TREM.set_report_overview = 0;
	ReportTag = 0;
	console.debug("ReportTag: ", ReportTag);
	changeView("main", "#mainView_btn");
};

ipcRenderer.on("testoldEEW", () => {
	const report_data = loadCachedReports();
	TREM.Report.replayHttp = true;
	replay = report_data[0].time - 5000;
	replayT = NOW().getTime();
	Report_GET();
	stopReplaybtn();
});

ipcRenderer.on("testoldtimeEEW", (event, oldtime) => {
	TREM.Report.replayHttp = true;
	replay = oldtime - 5000;
	replayT = NOW().getTime();
	Report_GET();
	stopReplaybtn();
});

ipcRenderer.on("testoldtremEEW", (event, oldtrem) => {
	let list = [];
	list = list.concat(oldtrem);
	ipcRenderer.send("testEEW", list);
});

ipcRenderer.on("testoldtime", (event, oldtime) => {
	replayD = true;
	replay = oldtime - 5000;
	replayTemp = replay;
	replayT = NOW().getTime();
	replaydir = replay / 1000;
	ReportTag = 0;
	console.debug("ReportTag: ", ReportTag);
	Report_GET();
	stopReplaybtn();
	PGAMain();
});

ipcRenderer.on("testreplaytime", (event, oldtime) => {
	console.debug(oldtime);
	replayD = true;
	replay = oldtime;
	replayTemp = oldtime;
	replayT = NOW().getTime();
	replaydir = replay / 1000;
	ReportTag = 0;
	console.debug("ReportTag: ", ReportTag);
	Report_GET();
	stopReplaybtn();
	PGAMain();
});

ipcRenderer.on("sleep", (event, mode) => {
	if (mode)
		sleep(mode);
	else
		sleep(mode);
});

ipcRenderer.on("report-Notification", (event, report) => {
	if (setting["webhook.url"] != "" && setting["report.Notification"]) {
		// console.debug(report);
		log("Posting Notification report Webhook", 1, "Webhook", "report-Notification");
		dump({ level: 0, message: "Posting Notification report Webhook", origin: "Webhook" });
		let msg = {};

		if (report.list) {
			const report_list_length = Object.keys(report.list).length;
			msg = {
				username   : "TREMV | 臺灣即時地震監測變體",
				avatar_url : "https://avatars.githubusercontent.com/u/91672109?s=128",
				content    : setting["tts.Notification"] ? ("地震報告"
				+ ((report_list_length != 0) ? "發生規模" + report.mag + "有感地震，最大震度" + report.Max_Level_areaName + report.Max_Level_stationName + IntensityI(report.Max_Level) + "級。" : "發生規模" + report.mag + "有感地震 ")
				+ "編號"
				+ (report.loc.startsWith("地震資訊") ? "無（地震資訊）" : report.no % 1000 ? report.no : "無（小區域有感地震）")
				+ "時間"
				+ timeconvert(new Date(report.time)).format("YYYY/MM/DD HH:mm:ss")
				+ "深度"
				+ report.depth + " 公里"
				+ "震央位置"
				+ "經度 東經 " + report.lon + "緯度 北緯 " + report.lat + "即在" + report.loc
				+ ((report_list_length != 0) ? "最大震度" + IntensityI(report.Max_Level) + "級地區" : "")
				+ ((report_list_length != 0) ? report.Max_Level_areaName : "")) : "地震報告",
				tts    : setting["tts.Notification"],
				embeds : [
					{
						author: {
							name     : "地震報告",
							url      : undefined,
							icon_url : undefined,
						},
						description : (report_list_length != 0) ? "發生規模" + report.mag + "有感地震，最大震度" + report.Max_Level_areaName + report.Max_Level_stationName + IntensityI(report.Max_Level) + "級。" : "發生規模" + report.mag + "有感地震",
						fields      : [
							{
								name   : "編號",
								value  : report.loc.startsWith("地震資訊") ? "無（地震資訊）" : report.no % 1000 ? report.no : "無（小區域有感地震）",
								inline : true,
							},
							{
								name   : "時間",
								value  : timeconvert(new Date(report.time)).format("YYYY/MM/DD HH:mm:ss"),
								inline : true,
							},
							{
								name   : "深度",
								value  : report.depth + " 公里",
								inline : true,
							},
							{
								name   : "震央位置",
								value  : "> 經度 **東經 " + report.lon + "**\n> 緯度 **北緯 " + report.lat + "**\n> 即在 **" + report.loc + "**",
								inline : false,
							},
							{
								name   : (report_list_length != 0) ? "最大震度" + IntensityI(report.Max_Level) + "級地區" : "",
								value  : (report_list_length != 0) ? report.Max_Level_areaName : "",
								inline : false,
							},
							{
								name   : "地圖",
								value  : "https://www.google.com/maps/search/?api=1&query=" + report.lat + "," + report.lon,
								inline : true,
							},
						],
						color: report.loc.startsWith("地震資訊") ? 9807270 : report.no % 1000 ? 15158332 : 3066993,
					},
				],
			};
		}

		sendWebhook(setting["webhook.url"], msg).catch((error) => {
			log(error, 3, "Webhook", "report-Notification");
			dump({ level: 2, message: error, origin: "Webhook" });
		});
	}

	if (report.list) {
		const location = report.loc.match(/(?<=位於).+(?=\))/);

		if (Object.keys(report.list).length != 0 && speecd_use) {
			const areaIntensity = `${IntensityI(report.Max_Level)}級`;
			TREM.speech.speak({ text: `${location}發生規模 ${report.mag.toFixed(1).replace(".", "點")}，最大震度${report.Max_Level_areaName + report.Max_Level_stationName + areaIntensity.replace("-級", "弱").replace("+級", "強")}，深度 ${report.depth.toFixed(1).replace(".", "點")} 公里` });
		} else if (speecd_use) {
			TREM.speech.speak({ text: `${location}發生規模 ${report.mag.toFixed(1).replace(".", "點")}，深度 ${report.depth.toFixed(1).replace(".", "點")} 公里` });
		}
	}
});

ipcRenderer.on("intensity-Notification", (event, intensity) => {
	const info = intensity;
	// 新的震度速報沒有對應的地震資料（eq），以速報本身的時間（id）代替
	info.eq ??= { time: info.id ?? 0 };
	info.max ??= Math.max(0, ...Object.keys(info.area ?? {}).map(Number));
	const intensity1 = info.area;
	let description = "";
	let city0 = "";
	const intensity1r = Object.keys(intensity1).reverse();
	const intensity1rkeys = Object.keys(intensity1).reverse();

	for (let index = 0; index < intensity1rkeys.length; index++) {
		const intensity2 = Number(Object.keys(intensity1)[(intensity1rkeys.length - (1 + index))]);
		const ids = intensity1[intensity1rkeys[index]];
		const intensity3 = `${IntensityI(intensity2)}級`;

		description += `${intensity3.replace("-級", "弱").replace("+級", "強")}\n`;

		for (const city in TREM.Resources.regionv2)
			for (const town in TREM.Resources.regionv2[city]) {
				const loc = TREM.Resources.regionv2[city][town];

				for (const id of ids)
					if (loc.code == id && city0 == city) {
						description += ` ${town}`;
					} else if (loc.code == id && city0 == "") {
						description += `${city} ${town}`;
						city0 = city;
					} else if (loc.code == id && city0 != city) {
						description += `\n${city} ${town}`;
						city0 = city;
					}
			}

		if (city0 == "") continue;
		city0 = "";
		description += "\n";
	}

	description += "\n";

	if (speecd_use && info.author != "palert") {
		const now = timeconvert(new Date(info.eq.time != 0 ? info.eq.time : info.timestamp)).format("YYYY/MM/DD HH:mm:ss");
		let description0 = "";
		const city1 = {};

		for (let index = 0, keys = Object.keys(intensity1r), n = keys.length; index < n; index++) {
			const intensity2 = Number(intensity1r[index]);
			const ids = intensity1[intensity2];
			const intensity3 = `${IntensityI(intensity2)}級`;

			for (const city in TREM.Resources.regionv2)
				for (const town in TREM.Resources.regionv2[city]) {
					const loc = TREM.Resources.regionv2[city][town];

					for (const id of ids)
						if (city1[city] == city) {
							continue;
						} else if (loc.code == id && city0 == city) {
							continue;
						} else if (loc.code == id && city0 == "") {
							description0 += `${city}`;
							description0 += `${intensity3.replace("-級", "弱").replace("+級", "強")}\n`;
							city0 = city;
							city1[city] = city;
						} else if (loc.code == id && city0 != city) {
							description0 += `${city}`;
							description0 += `${intensity3.replace("-級", "弱").replace("+級", "強")}\n`;
							city0 = city;
							city1[city] = city;
						}
				}

			if (city0 == "") continue;
			city0 = "";
		}

		console.error(description0);

		TREM.speech.speak({ text: "震度速報"
		+ "資料來源" + info.author
		+ (info.eq.time != 0 ? "發震時間" : "接收時間") + now
		+ "震度分布" + description0 });
	}

	if (setting["webhook.url"] != "" && setting["intensity.Notification"]) {
		log("Posting Notification intensity Webhook", 1, "Webhook", "intensity-Notification");
		dump({ level: 0, message: "Posting Notification intensity Webhook", origin: "Webhook" });
		const max_intensity = `${IntensityI(info.max)}級`;
		const msg = {
			username   : "TREMV | 臺灣即時地震監測變體",
			avatar_url : "https://avatars.githubusercontent.com/u/91672109?s=128",
			content    : setting["tts.Notification"] ? ("震度速報"
			+ "資料來源" + info.author
			+ (info.id != 0 ? "發震時間" : "接收時間") + (info.eq.time != 0 ? timeconvert(new Date(info.eq.time)).format("YYYY/MM/DD HH:mm:ss") : timeconvert(new Date(info.timestamp)).format("YYYY/MM/DD HH:mm:ss"))
			+ "第" + `${info.serial ?? "1"}報`
			+ ((info.final) ? "最終報" : "")
			+ "最大震度" + max_intensity.replace("-級", "弱").replace("+級", "強")) : "震度速報",
			tts    : setting["tts.Notification"],
			embeds : [
				{
					author: {
						name     : "震度速報",
						url      : undefined,
						icon_url : undefined,
					},
					fields: [
						{
							name   : "資料來源",
							value  : info.author,
							inline : true,
						},
						{
							name   : info.eq.time != 0 ? "發震時間" : "接收時間",
							value  : info.eq.time != 0 ? timeconvert(new Date(info.eq.time)).format("YYYY/MM/DD HH:mm:ss") : timeconvert(new Date(info.timestamp)).format("YYYY/MM/DD HH:mm:ss"),
							inline : true,
						},
						{
							name   : `第${info.serial ?? "1"}報`,
							value  : "",
							inline : false,
						},
						{
							name   : (info.final) ? "最終報" : "",
							value  : "",
							inline : true,
						},
						{
							name   : "最大震度",
							value  : max_intensity.replace("-級", "弱").replace("+級", "強"),
							inline : false,
						},
						{
							name   : "震度分布",
							value  : description,
							inline : true,
						},
					],
				},
			],
		};
		sendWebhook(setting["webhook.url"], msg).catch((error) => {
			log(error, 3, "Webhook", "intensity-Notification");
			dump({ level: 2, message: error, origin: "Webhook" });
		});
	}
});

ipcRenderer.on("update-available-Notification", (event, version, getVersion, info) => {
	if (setting["webhook.url"] != undefined)
		if (setting["webhook.url"] != "" && setting["checkForUpdates.Notification"]) {
			log("Posting Notification Update Webhook", 1, "Webhook", "update-available-Notification");
			dump({ level: 0, message: "Posting Notification Update Webhook", origin: "Webhook" });
			const getVersionbody = TREM.Localization.getString("Notification_Update_Body").format(getVersion, version) + `\nhttps://github.com/davgo0103/TREM/releases/tag/v${version}`;
			const msg = {
				username   : "TREMV | 臺灣即時地震監測變體",
				avatar_url : "https://avatars.githubusercontent.com/u/91672109?s=128",
				embeds     : [
					{
						author      : { name: "TREMV | 臺灣即時地震監測變體" },
						title       : "",
						description : "",
						color       : 4629503,
					},
				] };
			msg.embeds[0].title = TREM.Localization.getString("Notification_Update_Title");
			msg.embeds[0].description = getVersionbody;
			sendWebhook(setting["webhook.url"], msg).catch((error) => {
				log(error, 3, "Webhook", "update-available-Notification");
				dump({ level: 2, message: error, origin: "Webhook" });
			});
		}

	showDialog("success", `有可用的${info?.releaseName ?? version}版本更新`, `<div class="release-notes">${info?.releaseNotes ?? ""}</div>`,
		1, "update", () => {
			openURL(`https://github.com/davgo0103/TREM/releases/tag/v${version}`);
		}, "前往更新", "暫緩更新", () => void 0, 60);
});

ipcRenderer.on("update-not-available-Notification", (event, version, getVersion) => {
	if (setting["webhook.url"] != undefined)
		if (setting["webhook.url"] != "" && setting["checkForUpdates.Notification"]) {
			log("Posting Notification No Update Webhook", 1, "Webhook", "update-not-available-Notification");
			dump({ level: 0, message: "Posting Notification No Update Webhook", origin: "Webhook" });
			const getVersionbody = TREM.Localization.getString("Notification_No_Update_Body").format(getVersion, version);
			const msg = {
				username   : "TREMV | 臺灣即時地震監測變體",
				avatar_url : "https://avatars.githubusercontent.com/u/91672109?s=128",
				embeds     : [
					{
						author      : { name: "TREMV | 臺灣即時地震監測變體" },
						title       : "",
						description : "",
						color       : 4629503,
					},
				] };
			msg.embeds[0].title = TREM.Localization.getString("Notification_No_Update_Title");
			msg.embeds[0].description = getVersionbody;
			sendWebhook(setting["webhook.url"], msg).catch((error) => {
				log(error, 3, "Webhook", "update-not-available-Notification");
				dump({ level: 2, message: error, origin: "Webhook" });
			});
		}
});

ipcRenderer.on("testEEW", (event, list = []) => {
	toggleNav(false);
	stopReplaybtn();
	replaytestEEW = NOW().getTime();
	ReportTag = 0;
	console.debug("ReportTag: ", ReportTag);

	if (TREM.MapIntensity.isTriggered)
		TREM.MapIntensity.clear();

	if (TREM.MapArea2.isTriggered)
		TREM.MapArea2.clear();
});

ipcRenderer.on("settingError", (event, error) => {
	is_setting_disabled = error;
});

const updateMapColors = async (event, value) => {
	let accent, dark;

	if (typeof value == "boolean") {
		accent = setting["theme.color"];
		dark = value;
	} else {
		accent = value;
		dark = setting["theme.dark"];
	}

	TREM.Colors = await getThemeColors(accent, dark);
};

ipcRenderer.on("config:theme", updateMapColors);
ipcRenderer.on("config:dark", updateMapColors);
ipcRenderer.on("config:color", (event, key, value) => {
	if (typeof event == "boolean") key = event;

	if (typeof key == "boolean") {
		for (let i = 0; i < 10; i++) {
			document.body.style[key ? "setProperty" : "removeProperty"](`--custom-int-${i}`, setting[`theme.int.${i}`]);

			if (tinycolor(key ? setting[`theme.int.${i}`] : [
				"#757575",
				"#757575",
				"#2774C2",
				"#7BA822",
				"#E8D630",
				"#E68439",
				"#DB641F",
				"#F55647",
				"#DB1F1F",
				"#862DB3",
			][i]).getLuminance() > 0.575)
				$(`.${IntensityToClassString(i).replace(" darkText", "").split(" ").join(".")}`).addClass("darkText");
			else
				$(`.${IntensityToClassString(i).replace(" darkText", "").split(" ").join(".")}`).removeClass("darkText");
		}
	} else if (setting["theme.customColor"]) {
		document.body.style.setProperty(`--${key.replace(/\./g, "-").replace("theme", "custom")}`, value);

		if (tinycolor(value).getLuminance() > 0.575)
			$(`.${IntensityToClassString(IntensityN(key.replace("theme.int.", ""))).replace(" darkText", "").split(" ").join(".")}`).addClass("darkText");
		else
			$(`.${IntensityToClassString(IntensityN(key.replace("theme.int.", ""))).replace(" darkText", "").split(" ").join(".")}`).removeClass("darkText");
	}
});
ipcRenderer.on("config:location", (event, value) => {
	setUserLocationMarker(value);
});
ipcRenderer.on("config:mapanimation", (event, value) => {
	Maps.main._fadeAnimated = value;
	Maps.main._zoomAnimated = value;
	Maps.report._fadeAnimated = value;
	Maps.report._zoomAnimated = value;
});
ipcRenderer.on("config:maplayer", (event, mapName, state) => {
	Maps.main.setLayoutProperty(`Layer_${mapName}`, "visibility", state ? "visible" : "none");
});
// #endregion

// #region EEW
function FCMdata(json, Unit) {
	// const json = JSON.parse(JSON.stringify(data));
	// const json = JSON.parse(data);
	console.log(json);

	if (json.type == "eew")
		if (EarthquakeList[json.id])
			if (EarthquakeList[json.id].number == json.serial) return;
			else if (EarthquakeList[json.id].number > json.serial) return;

	if (server_timestamp.includes(json.timestamp) || NOW().getTime() - json.timestamp > 180_000) return;
	server_timestamp.push(json.timestamp);

	if (server_timestamp.length > 30) server_timestamp.splice(0, 1);
	// eslint-disable-next-line no-empty-function
	fs.writeFile(path.join(app.getPath("userData"), "server.json"), JSON.stringify(server_timestamp), () => {});
	// GetData = true;
	const filename = NOW().getTime();

	if (json.response != "You have successfully subscribed to earthquake information") {
		json.data_unit = Unit;
		json.delay = NOW().getTime() - json.timestamp;
		fs.writeFile(path.join(folder, `${filename}.tmp`), JSON.stringify(json), (err) => {
			fs.rename(path.join(folder, `${filename}.tmp`), path.join(folder, `${filename}.json`), () => void 0);
		});
	}

	type_Unit = Unit;
	log(`Latency: ${NOW().getTime() - json.timestamp}ms | Form: ${Unit} | Type: ${json.type}`, 1, "API", "FCMdata");
	dump({ level: 0, message: `Latency: ${NOW().getTime() - json.timestamp}ms | Form: ${Unit} | Type: ${json.type}`, origin: "API" });
	console.debug(json);

	if (json.type == undefined) return;

	if (json.type == "tsunami-info") {
		const now = new Date(json.time);
		const Now0 = now.getFullYear()
			+ "/" + (now.getMonth() + 1)
			+ "/" + now.getDate()
			+ " " + now.getHours()
			+ ":" + now.getMinutes();
		log("Got Tsunami Warning", 1, "API", "FCMdata");
		dump({ level: 0, message: "Got Tsunami Warning", origin: "API" });
		new Notification("海嘯資訊", { body: `${Now0}\n${json.location} 發生 ${json.scale} 地震\n東經: ${json.lon} 度 北緯: ${json.lat} 度`, icon: "../TREM.ico" });

		if (speecd_use) TREM.speech.speak({ text: `海嘯資訊${Now0} ${json.location} 發生 ${json.scale.replace(".", "點")} 地震` });
	} else if (json.type == "tsunami") {
		TREM.Earthquake.emit("tsunami", json);
	// } else if (json.type == "palert-app") {
	// 	console.debug(json);
	} else if (json.type == "pws") {
		TREM.PWS.addPWS(json.raw);
	} else if (json.type == "intensity") {
		log("Got Earthquake intensity", 1, "API", "FCMdata");
		dump({ level: 0, message: "Got Earthquake intensity", origin: "API" });

		if (EarthquakeList[json.id]) json.eq = EarthquakeList[json.id].eq;

		setTimeout(() => {
			ipcRenderer.send("screenshotEEWI", {
				Function : "intensity",
				ID       : 1,
				Version  : 1,
				Time     : NOW().getTime(),
				Shot     : 1,
			});
		}, 1250);

		if (json.author == "cwa")
			ipcRenderer.send("config:value", "intensity.cwa", filename.toString());
		else if (json.author == "trem")
			ipcRenderer.send("config:value", "intensity.trem", filename.toString());

		ipcRenderer.send("TREMIntensityhandle", json);
		ipcRenderer.send("intensity-Notification", json);
	} else if (json.type == "replay") {
		log("Got Earthquake replay", 1, "API", "FCMdata");
		dump({ level: 0, message: "Got Earthquake replay", origin: "API" });

		if (!replayD) {
			replay = json.replay_timestamp;
			replayT = NOW().getTime();
		}

		Report_GET();
		stopReplaybtn();
	} else if (json.type == "report") {
		const report = json.data;
		// const report = json.raw;
		const location = report.loc.match(/(?<=位於).+(?=\))/);
		const MaxareaName = Object.keys(report.list)[0];
		const MaxstationName = Object.keys(report.list[MaxareaName].town)[0];
		report.int = report.list[MaxareaName].int;
		report.no = report.id.split("-")[0];
		NewReportTag = report.id;

		if (report.id.match(/-/g).length === 3 && setting["report.onlycwachangeView"]) {
			if (!document.hasFocus())
				new Notification("地震報告",
					{
						body   : `${location}發生規模 ${report.mag.toFixed(1)} 有感地震，最大震度${MaxareaName}${MaxstationName}${TREM.Constants.intensities[report.list[MaxareaName].town[MaxstationName].int].text}。`,
						icon   : "../TREM.ico",
						silent : document.hasFocus(),
					});

			addReport(report, true);

			setTimeout(() => {
				ipcRenderer.send("screenshotEEW", {
					Function : "report",
					ID       : report.id,
					Version  : 1,
					Time     : NOW().getTime(),
					Shot     : 1,
				});
			}, 5000);

			if (TREM.MapIntensity.isTriggered)
				TREM.MapIntensity.clear();

			if (TREM.MapArea2.isTriggered)
				TREM.MapArea2.clear();

			if (setting["audio.report"]) audioPlay("../audio/Report.wav");

			raiseMainWindow({ show: setting["report.show"], cover: setting["report.cover"] });
		} else if (!setting["report.onlycwachangeView"]) {
			if (report.loc.startsWith("地震資訊")) {
				if (setting["report.getInfo"]) {
					// if (!document.hasFocus())
					// 	new Notification("地震報告",
					// 		{
					// 			body   : `${location}發生規模 ${report.magnitudeValue.toFixed(1)} 有感地震，最大震度${report.data[0].areaName}${report.data[0].eqStation[0].stationName}${TREM.Constants.intensities[report.data[0].eqStation[0].stationIntensity].text}。`,
					// 			icon   : "../TREM.ico",
					// 			silent : document.hasFocus(),
					// 		});

					setTimeout(() => {
						ipcRenderer.send("screenshotEEW", {
							Function : "report",
							ID       : report.id,
							Version  : 1,
							Time     : NOW().getTime(),
							Shot     : 1,
						});
					}, 5000);

					if (TREM.MapIntensity.isTriggered)
						TREM.MapIntensity.clear();

					if (TREM.MapArea2.isTriggered)
						TREM.MapArea2.clear();

					if (setting["audio.report"]) audioPlay("../audio/Report.wav");

					raiseMainWindow({ show: setting["report.show"], cover: setting["report.cover"] });

					addReport(report, true);
				}
			} else if (report.id.match(/-/g).length === 3) {
				if (!document.hasFocus())
					new Notification("地震報告",
						{
							body   : `${location}發生規模 ${report.mag.toFixed(1)} 有感地震，最大震度${MaxareaName}${MaxstationName}${TREM.Constants.intensities[report.list[MaxareaName].town[MaxstationName].int].text}。`,
							icon   : "../TREM.ico",
							silent : document.hasFocus(),
						});

				setTimeout(() => {
					ipcRenderer.send("screenshotEEW", {
						Function : "report",
						ID       : report.id,
						Version  : 1,
						Time     : NOW().getTime(),
						Shot     : 1,
					});
				}, 5000);

				if (TREM.MapIntensity.isTriggered)
					TREM.MapIntensity.clear();

				if (TREM.MapArea2.isTriggered)
					TREM.MapArea2.clear();

				if (setting["audio.report"]) audioPlay("../audio/Report.wav");

				raiseMainWindow({ show: setting["report.show"], cover: setting["report.cover"] });

				addReport(report, true);
			}
		}

		log("Got Earthquake Report", 1, "API", "FCMdata");
		dump({ level: 0, message: "Got Earthquake Report", origin: "API" });
	} else if (json.type.startsWith("eew") || json.type == "eew") {
		if (replay != 0 && !json.replay_timestamp) return;

		if (NOW().getTime() - json.time > 300_000) return;


		if (json.author) {
			// NIED、四川、福建已不再提供，一律不收
			if (
				json.author == "scdzj"
				|| json.author == "nied"
				|| (json.author == "jma" && !setting["accept.eew.JMA"])
				|| (json.author == "kma" && !setting["accept.eew.KMA"])
				|| ((json.author == "cwa" || json.author == "cwb") && !setting["accept.eew.CWA"])
				|| json.author == "fjdzj"
				|| (json.author == "trem" && !setting["accept.eew.trem"])
			) return;

			json.Unit = (json.scale == 1) ? "PLUM(局部無阻尼運動傳播法)"
				: (json.author == "scdzj") ? "四川省地震局 (SCDZJ)"
					: (json.author == "nied") ? "防災科学技術研究所 (NIED)"
						: (json.author == "kma") ? "기상청(KMA)"
							: (json.author == "jma") ? "気象庁(JMA)"
								: (json.author == "cwa") ? "中央氣象署 (CWA)"
									: (json.author == "fjdzj") ? "福建省地震局 (FJDZJ)"
										: (json.author == "trem" && json.serial > 3) ? "TREM(實驗功能僅供參考)"
											: (json.author == "trem" && json.serial <= 3) ? "NSSPE(無震源參數推算)"
												: (json.Unit) ? json.Unit : "";
		} else {
			if (
				json.type == "eew-scdzj"
				|| json.type == "eew-nied"
				|| (json.type == "eew-jma" && !setting["accept.eew.JMA"])
				|| (json.type == "eew-kma" && !setting["accept.eew.KMA"])
				|| (json.type == "eew-cwb" && !setting["accept.eew.CWA"])
				|| json.type == "eew-fjdzj"
				|| (json.type == "trem-eew" && !setting["accept.eew.trem"])
			) return;

			json.Unit = (json.scale == 1) ? "PLUM(局部無阻尼運動傳播法)"
				: (json.type == "eew-scdzj") ? "四川省地震局 (SCDZJ)"
					: (json.type == "eew-nied") ? "防災科学技術研究所 (NIED)"
						: (json.type == "eew-kma") ? "기상청(KMA)"
							: (json.type == "eew-jma") ? "気象庁(JMA)"
								: (json.type == "eew-cwb") ? "中央氣象署 (CWA)"
									: (json.type == "eew-fjdzj") ? "福建省地震局 (FJDZJ)"
										: (json.type == "trem-eew" && json.number > 3) ? "TREM(實驗功能僅供參考)"
											: (json.type == "trem-eew" && json.number <= 3) ? "NSSPE(無震源參數推算)"
												: (json.Unit) ? json.Unit : "";
		}

		stopReplaybtn();
		TREM.Earthquake.emit("eew", json);
	}
}
// #endregion

ipcRenderer.on("Olddatabase_eew", (event, json) => {
	if (json.eq) {
		json.replay_time = json.eq.time;
		json.replay_timestamp = json.eq.time;
		json.time = NOW().getTime();
		json.timestamp = NOW().getTime();
	} else {
		json.replay_time = json.time;
		json.replay_timestamp = json.time;
		json.time = NOW().getTime();
		json.timestamp = NOW().getTime();
	}

	if (json.author)
		json.Unit = (json.scale == 1) ? "PLUM(局部無阻尼運動傳播法)"
			: (json.author == "scdzj") ? "四川省地震局 (SCDZJ)"
				: (json.author == "nied") ? "防災科学技術研究所 (NIED)"
					: (json.author == "kma") ? "기상청(KMA)"
						: (json.author == "jma") ? "気象庁(JMA)"
							: (json.author == "cwa") ? "中央氣象署 (CWA)"
								: (json.author == "fjdzj") ? "福建省地震局 (FJDZJ)"
									: (json.author == "trem" && json.serial > 3) ? "TREM(實驗功能僅供參考)"
										: (json.author == "trem" && json.serial <= 3) ? "NSSPE(無震源參數推算)"
											: (json.Unit) ? json.Unit : "";
	else
		json.Unit = (json.scale == 1) ? "PLUM(局部無阻尼運動傳播法)"
			: (json.type == "eew-scdzj") ? "四川省地震局 (SCDZJ)"
				: (json.type == "eew-nied") ? "防災科学技術研究所 (NIED)"
					: (json.type == "eew-kma") ? "기상청(KMA)"
						: (json.type == "eew-jma") ? "気象庁(JMA)"
							: (json.type == "eew-cwb") ? "中央氣象署 (CWA)"
								: (json.type == "eew-fjdzj") ? "福建省地震局 (FJDZJ)"
									: (json.type == "trem-eew" && json.number > 3) ? "TREM(實驗功能僅供參考)"
										: (json.type == "trem-eew" && json.number <= 3) ? "NSSPE(無震源參數推算)"
											: (json.Unit) ? json.Unit : "";

	replaytestEEW = NOW().getTime();
	stopReplaybtn();
	TREM.Earthquake.emit("eew", json);
});

ipcRenderer.on("test_eew", (event, json) => {
	// json.time = NOW().getTime();
	// json.timestamp = NOW().getTime();
	json.Unit = (json.scale == 1) ? "PLUM(局部無阻尼運動傳播法)"
		: (json.author == "scdzj") ? "四川省地震局 (SCDZJ)"
			: (json.author == "nied") ? "防災科学技術研究所 (NIED)"
				: (json.author == "kma") ? "기상청(KMA)"
					: (json.author == "jma") ? "気象庁(JMA)"
						: (json.author == "cwa") ? "中央氣象署 (CWA)"
							: (json.author == "fjdzj") ? "福建省地震局 (FJDZJ)"
								: (json.author == "trem" && json.serial > 3) ? "TREM(實驗功能僅供參考)"
									: (json.author == "trem" && json.serial <= 3) ? "NSSPE(無震源參數推算)"
										: (json.Unit) ? json.Unit : "";

	replaytestEEW = NOW().getTime();
	stopReplaybtn();
	TREM.Earthquake.emit("eew", json);
});

// #region Event: eew
TREM.Earthquake.on("eew", (data) => {
	log("Got EEW", 1, "API", "eew");
	dump({ level: 0, message: "Got EEW", origin: "API" });
	console.debug(data);
	let Timer_run;

	if (data.status == 3) data.cancel = true;

	if (data.status == 2) data.Test = true;

	if (data.status == 1) data.Alert = true;

	if (data.status == 0) data.Alert = false;

	if (data.serial > 0) data.number = data.serial;

	if (data.eq) {
		if (data.eq.lon) data.lon = data.eq.lon;

		if (data.eq.lat) data.lat = data.eq.lat;

		if (data.eq.depth) data.depth = data.eq.depth;

		if (data.eq.mag) data.scale = data.eq.mag;

		if (data.eq.loc) data.location = data.eq.loc;

		if (data.eq.time && replay == 0) data.time = data.eq.time;
	}

	if ((data.type == "trem-eew" || data.author == "trem") && (data.lat == null && data.lon == null)) return;

	// 已經結束的速報再重播一次時要重新建立，不然會沿用上次的取消狀態，震波圓不會動
	if (data.replay_time && TREM.EEW.has(data.id) && !EarthquakeList[data.id])
		TREM.EEW.delete(data.id);

	if (!TREM.EEW.has(data.id))
		TREM.EEW.set(data.id, new EEW(data));
	else
		TREM.EEW.get(data.id).update(data);

	// handler
	if (!EarthquakeList[data.id]) EarthquakeList[data.id] = {
		epicenter       : [],
		Time            : 0,
		ID              : "",
		number          : "",
		Timer           : Timer_run,
		distance        : [],
		epicenterIcon   : null,
		epicenterIconTW : null,
		eq              : {},
	};
	else if (EarthquakeList[data.id].number == data.number) return;
	else if (EarthquakeList[data.id].number > data.number) return;

	EarthquakeList[data.id].epicenter = [+data.lon, +data.lat];
	EarthquakeList[data.id].Time = data.time;
	EarthquakeList[data.id].ID = data.id;

	if (data.eq) EarthquakeList[data.id].eq = data.eq;

	let value = 0;
	let distance = 0;

	const GC = {};
	let level;
	let MaxIntensity = { label: "", value: -1 };
	const NSSPE = data.intensity ?? {};

	for (const city in TREM.Resources.region)
		for (const town in TREM.Resources.region[city]) {
			const loc = TREM.Resources.region[city][town];
			const d = TREM.Utils.twoSideDistance(
				TREM.Utils.twoPointDistance(
					{ lat: loc.latitude, lon: loc.longitude },
					{ lat: data.lat, lon: data.lon },
				),
				data.depth,
			);
			let int = TREM.Utils.PGAToIntensity(
				TREM.Utils.pga(
					data.scale,
					d,
					setting["earthquake.siteEffect"] ? loc.siteEffect : undefined,
				),
			);

			if (data.depth == null) int = NSSPE[loc[0]] ?? { value: 0, label: "0", get text() {
				return TREM.Localization.getString("Intensity_Zero");
			} };

			if (setting["location.city"] == city && setting["location.town"] == town) {
				level = int;
				distance = d;
				value = Math.floor(_speed(data.depth, distance).Stime - (NOW().getTime() - data.time) / 1000) - 2;
			}

			if (int.value > MaxIntensity.value)
				MaxIntensity = int;
			GC[loc.code] = int.value;
		}

	if (setting["location.lat"] != "" && setting["location.lon"] != "") {
		const d = TREM.Utils.twoSideDistance(
			TREM.Utils.twoPointDistance(
				{ lat: setting["location.lat"], lon: setting["location.lon"] },
				{ lat: data.lat, lon: data.lon },
			),
			data.depth,
		);
		let int = TREM.Utils.PGAToIntensity(
			TREM.Utils.pga(
				data.scale,
				d,
				undefined,
			),
		);

		for (const city in TREM.Resources.region)
			for (const town in TREM.Resources.region[city]) {
				const loc = TREM.Resources.region[city][town];

				if (data.depth == null) int = NSSPE[loc[0]] ?? { value: 0, label: "0", get text() {
					return TREM.Localization.getString("Intensity_Zero");
				} };
			}

		level = int;
		distance = d;
		value = Math.floor(_speed(data.depth, distance).Stime - (NOW().getTime() - data.time) / 1000) - 2;

		if (int.value > MaxIntensity.value)
			MaxIntensity = int;
	}

	if (data.type == "trem-eew" && data.number < 3) {
		data.scale = null;
		data.depth = null;
	}

	if (data.author == "trem" && data.serial < 3) {
		data.scale = null;
		data.depth = null;
	}

	let dev_p = 0;
	let dev_s = 0;

	if (data.depth) {
		const get_speed = _speed(data.depth, distance);
		dev_p = get_speed.Ptime;
		dev_s = get_speed.Stime;
		dev_p *= 1000;
		dev_s *= 1000;

		let kmP = 0;
		let km = 0;

		const km_time = (NOW().getTime() - data.time) / 1000;

		const _time_table = TREM.Resources.time[findClosest(TREM.Resources.time_list, data.depth)];
		let prev_table = null;

		for (const table of _time_table) {
			if (!kmP && table.P > km_time)
				if (prev_table) {
					const t_diff = table.P - prev_table.P;
					const r_diff = table.R - prev_table.R;
					const t_offset = km_time - prev_table.P;
					const r_offset = (t_offset / t_diff) * r_diff;
					kmP = prev_table.R + r_offset;
				} else {
					kmP = table.R;
				}

			if (!km && table.S > km_time)
				if (prev_table) {
					const t_diff = table.S - prev_table.S;
					const r_diff = table.R - prev_table.R;
					const t_offset = km_time - prev_table.S;
					const r_offset = (t_offset / t_diff) * r_diff;
					km = prev_table.R + r_offset;
				} else {
					km = table.R;
				}

			if (kmP && km) break;

			prev_table = table;
		}

		let temp_p = km / 2;
		let temp_s = kmP / 2;

		if (distance / temp_p > 7) temp_p = distance / 7;

		if (distance / temp_s > 4) temp_s = distance / 4;

		temp_p *= 1000;
		temp_s *= 1000;

		if (temp_p < dev_p && temp_p > 0) {
			dev_p = km / 2;
			dev_p *= 1000;
		}

		if (temp_s < dev_s && temp_s > 0) {
			dev_s = kmP / 2;
			dev_s *= 1000;
		}
	}

	if (setting["dev.mode"])
		if ((data.type == "trem-eew" || data.author == "trem") || data.type == "eew-cwb" || data.type == "eew-fjdzj") {
			console.debug(MaxIntensity);
		} else {
			const int = TREM.Utils.PGAToIntensity(
				TREM.Utils.pga(
					data.scale,
					data.depth,
					1,
				),
			);

			if (int.value > MaxIntensity.value)
				MaxIntensity = int;
		}

	if (data.eq && data.eq.max) MaxIntensity = { label: TREM.Constants.intensities[data.eq.max].label, value: data.eq.max };

	// TREM.MapIntensity.expected(GC);

	let Alert = true;

	if (level.value < Number(setting["eew.Intensity"])) Alert = false;

	let Nmsg = "";

	audio.main_lock = false;
	audio.minor_lock = false;
	audio.main = [];
	audio.minor = [];

	if (value > 0)
		Nmsg = `${value}秒後抵達`;
	else
		Nmsg = "已抵達 (預警盲區)";

	const notify = (level.label.includes("+") || level.label.includes("-")) ? level.label.replace("+", "強").replace("-", "弱") : level.label + "級";
	let body = `${notify ?? "未知"}地震，${Nmsg}\nM ${data.scale} ${data.location ?? "未知區域"}`;

	if (data.depth == null) body = `${notify ?? "未知"}地震，${data.location ?? "未知區域"} (NSSPE)`;

	new Notification("EEW 強震即時警報", {
		body   : body,
		icon   : "../TREM.ico",
		silent : document.hasFocus(),
	});

	if (speecd_use) {
		let speecd_scale = data.scale;
		const speecd_number = data.number;
		let find0 = INFO.findIndex(v => v.ID == data.id);

		if (!Number.isNaN(speecd_scale)) speecd_scale = Number.parseFloat(speecd_scale);

		if (find0 == -1) find0 = INFO.length;

		if (speecd_number == 1) {
			if (MaxIntensity.value >= 4) TREM.speech.speak({ text: "注意強震，此地震可能造成災害" });

			TREM.speech.speak({ text: `${data.location}，發生規模${speecd_scale.toFixed(1).replace(".", "點")}地震` });
		} else if (INFO[find0]?.alert_magnitude != speecd_scale && speecd_scale != 0) {
			TREM.speech.speak({ text: `${data.location}，發生規模${speecd_scale.toFixed(1).replace(".", "點")}地震` });
		} else if (INFO[find0]?.alert_magnitude != speecd_scale && speecd_scale == 0) {
			TREM.speech.speak({ text: `${data.Unit}，已取消警報` });
		} else if (data.cancel) {
			TREM.speech.speak({ text: `${data.Unit}，已取消警報` });
		}

		if (data.author == "cwa")
			if (data.location.includes("海") && Number(data.depth) <= 35)
				if (Number(speecd_scale) >= 7 && speecd_number == 1)
					TREM.speech.speak({ text: "震源位置及規模表明，可能發生海嘯，沿岸地區應慎防海水位突變，並留意中央氣象署是否發布，海嘯警報" });
				else if (Number(speecd_scale) >= 6 && speecd_number == 1)
					TREM.speech.speak({ text: "沿岸地區應慎防海水位突變" });
				else if (INFO[find0]?.alert_magnitude != speecd_scale)
					if (Number(speecd_scale) >= 7)
						TREM.speech.speak({ text: "震源位置及規模表明，可能發生海嘯，沿岸地區應慎防海水位突變，並留意中央氣象署是否發布，海嘯警報" });
					else if (Number(speecd_scale) >= 6)
						TREM.speech.speak({ text: "沿岸地區應慎防海水位突變" });
	}

	if (!Info.Notify.includes(data.id)) {
		Info.Notify.push(data.id);
		// show latest eew
		TINFO = INFO.length;
		clearInterval(Timers.ticker);
		Timers.ticker = setInterval(() => {
			if (TINFO + 1 >= INFO.length)
				TINFO = 0;
			else TINFO++;
		}, 5000);

		if (Alert) {
			changeView("main", "#mainView_btn");

			raiseMainWindow({ show: setting["eew.show"], cover: setting["eew.cover"], flash: true });
		}

		eewt.id = data.id;

		if (data.author != "trem")
			if (setting["audio.eew"] && Alert) {
				log("Playing Audio > eew", 1, "Audio", "eew");
				dump({ level: 0, message: "Playing Audio > eew", origin: "Audio" });
				TREM.Audios.eew.play();
				audioPlay1(`../audio/1/${level.label.replace("+", "").replace("-", "")}.wav`);

				if (level.label.includes("+"))
					audioPlay1("../audio/1/intensity-strong.wav");
				else if (level.label.includes("-"))
					audioPlay1("../audio/1/intensity-weak.wav");
				else
					audioPlay1("../audio/1/intensity.wav");

				if (value > 0 && value < 100) {
					if (value <= 10) {
						audioPlay1(`../audio/1/${value.toString()}.wav`);
					} else if (value < 20) {
						audioPlay1(`../audio/1/x${value.toString().substring(1, 2)}.wav`);
					} else {
						audioPlay1(`../audio/1/${value.toString().substring(0, 1)}x.wav`);
						audioPlay1(`../audio/1/x${value.toString().substring(1, 2)}.wav`);
					}

					audioPlay1("../audio/1/second.wav");
				}
			}
	}

	if (data.author != "trem")
		if (MaxIntensity.value >= 5)
			if (!Info.Warn.includes(data.id)) {
				Info.Warn.push(data.id);

				if (!EEWAlert) {
					EEWAlert = true;

					if (setting["audio.eew"] && Alert)
						for (let index = 0; index < 5; index++)
							audioPlay("../audio/Warn.wav");
				}
			}

	let _time = -1;
	let stamp = 0;

	if ((EarthquakeList[data.id].number ?? 1) < data.number) {
		if ((data.type == "trem-eew" || data.author == "trem") && setting["audio.eew"] && Alert) {
			log("Playing Audio > note", 1, "Audio", "eew");
			dump({ level: 0, message: "Playing Audio > note", origin: "Audio" });
			TREM.Audios.note.play();
		} else if (setting["audio.eew"] && Alert) {
			log("Playing Audio > update", 1, "Audio", "eew");
			dump({ level: 0, message: "Playing Audio > update", origin: "Audio" });
			TREM.Audios.update.play();
		}

		EarthquakeList[data.id].number = data.number;
	}

	eew[data.id] = {
		lon    : Number(data.lon),
		lat    : Number(data.lat),
		time   : 0,
		Time   : data.time,
		id     : data.id,
		km     : 0,
		type   : data.type,
		t      : eew[data.id]?.t ?? null,
		value  : Math.floor(_speed(data.depth, distance).Stime - (NOW().getTime() - data.time) / 1000),
		Second : eew[data.id]?.Second ?? -1,
		arrive : eew[data.id]?.arrive ?? "",
	};

	if (data.number != 1) {
		clearInterval(eew[data.id].t);
		eew[data.id].t = null;
		eew[data.id].Second = -1;
		eew[data.id].arrive = "";
	}

	if (data.author != "trem")
		if (eew[data.id].Second == -1 || eew[data.id].value < eew[data.id].Second)
			if (setting["audio.eew"] && Alert)
				if (eew[data.id].arrive == "") {
					if (eew[data.id].t != null) {
						clearInterval(eew[data.id].t);
						eew[data.id].t = null;
					}

					eew[data.id].t = setInterval(() => {
						try {
							eew[data.id].value = Math.floor(_speed(data.depth, distance).Stime - (NOW().getTime() - data.time) / 1000);
						} catch (err) {
							log(err, 3, "Audio", "eew");
							dump({ level: 2, message: err, origin: "Audio" });
							console.log(err);
						}

						if (Math.sign(eew[data.id].value) != -1) {
							eew[data.id].Second = eew[data.id].value;

							if (stamp != eew[data.id].value && !audio.minor_lock) {
								stamp = eew[data.id].value;

								if (eew[data.id].value < 100)
									if (eew[data.id].value > 10) {
										if (eew[data.id].value.toString().substring(1, 2) == "0") {
											audioPlay1(`../audio/1/${eew[data.id].value.toString().substring(0, 1)}x.wav`);
											audioPlay1("../audio/1/x0.wav");
										} else {
											audioPlay("../audio/1/ding.wav");
										}
									} else if (eew[data.id].value > 0) {
										audioPlay1(`../audio/1/${eew[data.id].value.toString()}.wav`);
									} else {
										eew[data.id].arrive = data.id;
										audioPlay1("../audio/1/arrive.wav");
										_time = 0;
										eew[data.id].Second = -1;
									}
							}
						} else if (_time >= 0) {
							audioPlay("../audio/1/ding.wav");
							_time++;

							if (_time >= 10) {
								clearInterval(eew[data.id].t);
								eew[data.id].t = null;
								_time = -1;
							}
						}
					}, 50);
				}

	const speed = setting["shock.smoothing"] ? 100 : 500;

	if (EarthquakeList[data.id].Timer != undefined || EarthquakeList[data.id].Timer != null) clearInterval(EarthquakeList[data.id].Timer);

	if (EarthquakeList[data.id].epicenterIcon != undefined || EarthquakeList[data.id].epicenterIcon != null || EarthquakeList[data.id].epicenterIcon) {
		EarthquakeList[data.id].epicenterIcon.remove();
		EarthquakeList[data.id].epicenterIcon = null;
	}

	if (EarthquakeList.ITimer != undefined) clearInterval(EarthquakeList.ITimer);

	// AlertBox: 種類
	let classString = "alert-box ";

	if (data.replay_timestamp) {
		replay = data.replay_timestamp;
		replayT = NOW().getTime();
	}

	if (data.cancel)
		classString += "eew-cancel";
	else if (data.Test)
		classString += "eew-test";
	else if (data.Alert)
		classString += "eew-alert";
	else
		classString += "eew-pred";

	let find = INFO.findIndex(v => v.ID == data.id);

	if (find == -1) find = INFO.length;
	const time = new Date((data.replay_time) ? data.replay_time : data.time);
	INFO[find] = {
		ID              : data.id,
		alert_number    : data.number,
		alert_intensity : (data.type == "trem-eew" || data.author == "trem") ? (data.max ? data.max : data.eq.max ?? 0) : MaxIntensity.value,
		alert_location  : data.location ?? "未知區域",
		alert_time      : time,
		alert_sTime     : data.depth ? Math.floor(data.time + dev_s) : null,
		alert_pTime     : data.depth ? Math.floor(data.time + dev_p) : null,
		alert_local     : level.value,
		alert_magnitude : data.scale ?? "?",
		alert_depth     : data.depth ?? "?",
		alert_provider  : (data.final) ? data.Unit + "(最終報)" : data.Unit,
		alert_type      : classString,
		"intensity-1"   : `<font color="white" size="7"><b>${MaxIntensity.label}</b></font>`,
		"time-1"        : `<font color="white" size="2"><b>${time}</b></font>`,
		"info-1"        : `<font color="white" size="4"><b>M ${data.scale} </b></font><font color="white" size="3"><b> 深度: ${data.depth} km</b></font>`,
		distance,
	};

	// switch to main view
	$("#mainView_btn")[0].click();
	// remember navrail state
	const navState = !$("#nav-rail").hasClass("hide");

	// hide navrail so the view goes fullscreen
	if (navState) toggleNav(false);
	// hide report to make screen clean
	$(roll).fadeOut(200);
	// show minimap
	$("#map-tw").addClass("show");

	updateText();

	if (Timers.eew == null)
		Timers.eew = setInterval(() => {
			updateText();

			if (Timers.ticker == null)
				Timers.ticker = setInterval(() => {
					if (TINFO + 1 >= INFO.length)
						TINFO = 0;
					else TINFO++;
				}, 9000);
		}, 1000);

	EEWshot = NOW().getTime() - 28500;
	EEWshotC = 1;

	main(data);

	if (EarthquakeList[data.id].Timer == undefined || EarthquakeList[data.id].Timer == null) EarthquakeList[data.id].Timer = Timer_run;

	EarthquakeList[data.id].Timer ??= setInterval(() => {
		main(data);
	}, speed);

	if (EarthquakeList[data.id].Timer != null || EarthquakeList[data.id].Timer != undefined) {
		clearInterval(EarthquakeList[data.id].Timer);
		EarthquakeList[data.id].Timer = setInterval(() => {
			main(data);
		}, speed);
	} else if (EarthquakeList[data.id].Timer == null || EarthquakeList[data.id].Timer == undefined) {
		EarthquakeList[data.id].Timer = setInterval(() => {
			main(data);
		}, speed);
	}

	// 舊的一報若正顯示在小地圖上，新圖層畫好後再移除，避免閃爍
	const oldGeojson = TREM.EEW.get(data.id)?.geojson;

	TREM.EEW.get(data.id).geojson = vtLayer(MapData.tw_town, {
		minZoom   : 7,
		maxZoom   : 7,
		tolerance : 20,
		buffer    : 256,
		debug     : 0,
		zIndex    : 1,
		style     : (properties) => {
			if (properties.TOWNCODE) {
				if (!GC[properties.TOWNCODE])
					return {
						stroke      : false,
						color       : "transparent",
						weight      : 0.8,
						opacity     : 0,
						fillColor   : TREM.Colors.surfaceVariant,
						fillOpacity : 0.6,
					};
				return {
					stroke      : false,
					color       : "transparent",
					weight      : 0.8,
					opacity     : 0,
					fillColor   : TREM.color(GC[properties.TOWNCODE]),
					fillOpacity : 1,
				};
			} else {
				return {
					color       : "transparent",
					weight      : 0.8,
					opacity     : 0,
					fillColor   : TREM.Colors.surfaceVariant,
					fillOpacity : 0.6,
				};
			}
		},
	});

	if (oldGeojson && Maps.mini.hasLayer(oldGeojson))
		replaceLayer(oldGeojson, TREM.EEW.get(data.id).geojson, Maps.mini);
	else
		oldGeojson?.remove();

	// 關閉 TREM 速報通知時，只送其他來源的速報
	if (setting["webhook.url"] != "" && !(setting["trem-eew.No-Notification"] && data.author == "trem") && webhookInTime(`${data.replay_time ? "replay" : "eew"}:${data.id}`, time.getTime()))
		setTimeout(() => {
			const showtime = timeconvert(time).format("YYYY/MM/DD HH:mm:ss");
			const provider = eewProvider(data);

			let msg = setting["webhook.body"];
			msg = msg.replace("%Depth%", data.depth == null ? "?" : data.depth).replaceAll("%NorthLatitude%", data.lat).replace("%Time%", showtime).replaceAll("%EastLongitude%", data.lon).replace("%location%", data.location).replace("%Scale%", data.scale == null ? "?" : data.scale).replace("%Number%", data.number).replace("%Final%", (data.final) ? "(最終報)" : "").replace("%Provider%", provider);

			// 自訂內容沒有 username（用 Discord 上設定的名稱與頭像）或自帶 footer 時，照自訂的送
			msg = JSON.parse(msg);

			if (msg.embeds?.[0]) {
				if (!msg.embeds[0].image?.url) delete msg.embeds[0].image;

				const now = NOW();
				msg.embeds[0].footer ??= {
					text     : `ExpTech Studio ${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${now.getHours()}:${now.getMinutes()}:${now.getSeconds()}`,
					icon_url : "https://avatars.githubusercontent.com/u/91672109?s=128",
				};
			}

			msg.tts = setting["tts.Notification"];
			msg.content = setting["tts.Notification"] ? (showtime + "左右發生顯著有感地震東經" + data.lon + "北緯" + data.lat + "位於" + data.location + "深度" + (data.depth == null ? "?" : data.depth + "公里") + "規模" + (data.scale == null ? "?" : data.scale) + "第" + data.number + "報發報單位" + provider + "慎防強烈搖晃，就近避難 [趴下、掩護、穩住]") : "";
			log(`Posting EEW Webhook ${data.id} #${data.number}`, 1, "Webhook", "eew");
			dump({ level: 0, message: "Posting EEW Webhook", origin: "Webhook" });
			// 同一個地震的後續報數編輯原訊息，並換上當下的地圖截圖
			const key = eewWebhookKey(data);
			sendWebhook(setting["webhook.url"], msg, { key, image: true }).catch((error) => {
				log(error, 3, "Webhook", "eew");
				dump({ level: 2, message: error, origin: "Webhook" });
			});
			startWebhookLive(data.id, key);
		}, 2000);
});

// 震動檢測（即時測站觸發）的 Webhook：同一次震動編輯同一則訊息，震度升級時更新內容與截圖
// 發震時間與震動開始相差 2 分鐘內的 CWA 或 TREM 速報，由速報接手編輯這則訊息（見 eewWebhookKey）
const RTS_WEBHOOK_TAKEOVER_MS = 120_000;
let rtsWebhookEvent = null;

function rtsWebhook(Json, All) {
	if (setting["webhook.url"] == "" || !setting["trem-eq.alert.Notification"]) return;

	if (All[0].intensity < Number(setting["trem-eq.alert.Notification.Intensity"])) return;

	const time = Json.time ?? Json.Time;

	if (!rtsWebhookEvent || rtsWebhookEvent.ended)
		rtsWebhookEvent = { key: `rts:${time}`, start: time, claimed: false, ended: false };

	const event = rtsWebhookEvent;

	if (event.claimed || !webhookInTime(event.key, event.start)) return;

	// 依縣市整理最大震度與 PGA
	const counties = {};

	for (const s of All) {
		if (!s.loc) continue;

		const id = s.uuid.split("-")[2];
		const data = Json.station ? Json.station[id] : Json[id];
		const pga = +(data?.a ?? data?.pga ?? 0);
		const county = (counties[s.loc.split(" ")[0]] ??= { intensity: -1, pga: 0 });

		if (s.intensity > county.intensity) county.intensity = s.intensity;

		if (pga > county.pga) county.pga = pga;
	}

	const max = All[0].intensity;
	const title = max > 4 ? "強震檢測" : max > 1 ? "震動檢測" : "弱反應";
	let description = `開始時間 > ${timeconvert(new Date(event.start)).format("YYYY/MM/DD HH:mm:ss")}\n\n`;

	for (const [name, county] of Object.entries(counties).sort((a, b) => b[1].intensity - a[1].intensity || b[1].pga - a[1].pga).slice(0, 10))
		description += `${name} 最大震度 > ${IntensityI(county.intensity)}（${county.pga} gal）\n`;

	description += `\n共 ${All.length} 站觸發`;

	const msg = {
		...webhookIdentity(),
		content : setting["tts.Notification"] ? `${title}\n${description}` : title,
		tts     : setting["tts.Notification"],
		embeds  : [
			{
				author      : { name: title },
				description : description,
				// 與地圖上的震度顏色相同（含自訂配色）
				color       : parseInt(String(TREM.color(max)).replace("#", ""), 16) || 0x757575,
				footer      : { text: "TREMV 即時測站（非正式速報）" },
				timestamp   : new Date().toISOString(),
			},
		],
	};

	log(`Posting ${title} Webhook (${event.key})`, 1, "Webhook", "rts");
	dump({ level: 0, message: `Posting ${title} Webhook`, origin: "Webhook" });
	sendWebhook(setting["webhook.url"], msg, { key: event.key, image: true }).catch((error) => {
		log(error, 3, "Webhook", "rts");
		dump({ level: 2, message: error, origin: "Webhook" });
	});
}

function webhookIdentity() {
	try {
		const { username, avatar_url } = JSON.parse(setting["webhook.body"]);
		return {
			...(username ? { username } : {}),
			...(avatar_url ? { avatar_url } : {}),
		};
	} catch {
		return {};
	}
}

/** 速報的 Webhook 事件識別；剛發出的震動檢測訊息由 CWA 或 TREM 速報接手編輯 */
const eewWebhookKeys = new Map();

function eewWebhookKey(data) {
	const key = `${data.replay_time ? "replay" : "eew"}:${data.id}`;

	if (eewWebhookKeys.has(key)) return eewWebhookKeys.get(key);

	const event = rtsWebhookEvent;
	// 以發震時間比對，重播的速報不會接手即時的震動檢測，反之亦然
	const eqTime = data.replay_time ?? data.time;

	if (event && !event.claimed && (data.author == "cwa" || data.author == "trem") && Math.abs(event.start - eqTime) < RTS_WEBHOOK_TAKEOVER_MS && hasWebhookMessage(event.key)) {
		event.claimed = true;
		log(`EEW ${data.id} takes over ${event.key}`, 1, "Webhook", "eew");
		eewWebhookKeys.set(key, event.key);
		return event.key;
	}

	eewWebhookKeys.set(key, key);

	if (eewWebhookKeys.size > 200) eewWebhookKeys.delete(eewWebhookKeys.keys().next().value);

	return key;
}

// 重播或延遲送達的舊警報不發 Webhook。以同一事件第一次收到時判斷，
// 已發出的地震後續報數照常發送；webhook.maxAge 為 0 時不限制，空白時用預設的 60 秒
const webhookInTimeCache = new Map();

function webhookInTime(key, eventTime) {
	const value = String(setting["webhook.maxAge"] ?? "").trim();
	const limit = value == "" ? 60 : Number(value);

	if (!(limit > 0)) return true;

	if (!webhookInTimeCache.has(key)) {
		webhookInTimeCache.set(key, NOW().getTime() - eventTime <= limit * 1000);

		if (webhookInTimeCache.size > 200) webhookInTimeCache.delete(webhookInTimeCache.keys().next().value);
	}

	return webhookInTimeCache.get(key);
}

// 速報發出後每 5 秒更新一次 Discord 訊息的截圖，直到所在地 S 波抵達
const WEBHOOK_LIVE_INTERVAL_MS = 5_000;
const WEBHOOK_LIVE_MAX_MS = 120_000;
const webhookLive = new Map();

function startWebhookLive(id, key) {
	if (webhookLive.has(key)) return;

	const start = Date.now();

	const stop = () => {
		clearInterval(timer);
		webhookLive.delete(key);
	};

	const timer = setInterval(() => {
		const info = INFO.find((i) => i.ID == id);
		const cancelled = TREM.EEW.get(id)?.Cancel != undefined;

		// 速報已結束、取消或沒有震源深度（無法推算抵達時間）：不再更新
		if (!info || cancelled || info.alert_sTime == null || Date.now() - start > WEBHOOK_LIVE_MAX_MS) return stop();

		const arrived = NOW().getTime() > info.alert_sTime;

		// 抵達後確定送出一張原始畫質的（上一次還在送時會略過）才停
		refreshWebhookImage(setting["webhook.url"], key, { full: arrived })
			.then((done) => arrived && done && stop())
			.catch((error) => log(error, 3, "Webhook", "eew-live"));
	}, WEBHOOK_LIVE_INTERVAL_MS);

	webhookLive.set(key, timer);
}

/** 速報的發報單位名稱。 */
function eewProvider(data) {
	const providers = {
		"eew-cwb"   : "中央氣象署 (CWA)",
		"eew-scdzj" : "四川省地震局 (SCDZJ)",
		"eew-fjdzj" : "福建省地震局 (FJDZJ)",
		"eew-nied"  : "防災科学技術研究所 (NIED)",
		"eew-jma"   : "気象庁(JMA)",
		"eew-kma"   : "기상청(KMA)",
	};

	if (providers[data.type]) return providers[data.type];

	if (data.type == "trem-eew" || data.author == "trem")
		return (data.number ?? data.serial) <= 3 ? "NSSPE(無震源參數推算)" : "TREM(實驗功能僅供參考)";

	return data.Unit;
}
// #endregion

// #region Event: eewEnd
TREM.Earthquake.on("eewEnd", (id, type) => {
	clear(id, type);
});
// #endregion

ipcRenderer.on("Olddatabase_tsunami", (event, json) => {
	TREM.Earthquake.emit("tsunami", json);
});

TREM.Earthquake.on("tsunami", (data) => {
	console.debug(data);

	if (data.cancel) {
		if (speecd_use) TREM.speech.speak({ text: "海嘯警報已解除" });

		if (TSUNAMI.ALL)
			TSUNAMI.ALL.remove();

		if (TSUNAMI.warnIcon)
			TSUNAMI.warnIcon.remove();
		TSUNAMI = {};

		Mapsmainfocus();
	} else {
		if (speecd_use) TREM.speech.speak({ text: "海嘯警報已發布，請迅速疏散至避難場所" });

		if (data.number == 1) {
			raiseMainWindow({ show: setting["report.show"], cover: setting["report.cover"] });

			if (setting["audio.report"]) audioPlay("../audio/Water.wav");
			Mapsmainfocus();
		}

		if (!TSUNAMI.warnIcon) {
			const warnIcon = L.icon({
				iconUrl   : "../image/warn.png",
				iconSize  : [30, 30],
				className : "tsunami",
			});
			TSUNAMI.warnIcon = L.marker([+data.lat, +data.lon], { icon: warnIcon }).addTo(Maps.main);
		} else {
			TSUNAMI.warnIcon.setLatLng([+data.lat, +data.lon]);
		}

		const tsunami_level = {};

		const now = new Date(data.time);
		const Now3 = now.getFullYear()
			+ "/" + (now.getMonth() + 1)
			+ "/" + now.getDate()
			+ " " + now.getHours()
			+ ":" + now.getMinutes();

		for (let i = 0; i < data.area.length; i++) {
			if (!data.area[i].arrivalTime) continue;
			new Notification("海嘯警報", {
				body   : `${Now3} 發生地震\n請${data.area[i].areaName}迅速疏散至避難場所`,
				icon   : "../TREM.ico",
				silent : document.hasFocus(),
			});
			tsunami_level[data.area[i].areaName] = tsunami_color(data.area[i].waveHeight);
		}

		if (TSUNAMI.ALL)
			TSUNAMI.ALL.remove();
		TSUNAMI.ALL = L.geoJson.vt(MapData.tw_tsunami_area, {
			minZoom   : 4,
			maxZoom   : 12,
			tolerance : 30,
			buffer    : 256,
			debug     : 0,
			zIndex    : 5,
			style     : (args) => {
				if (args.properties) args = args.properties;
				return {
					color       : tsunami_level[args.AREANAME],
					weight      : 3,
					fillColor   : "transparent",
					fillOpacity : 0,
				};
			},
		}).addTo(Maps.main);
		L.DomUtil.addClass(TSUNAMI.ALL._container, "tsunami");
	}
});

// 震波圓每張地圖共用一個 SVG 圖層；每個圓各建一個的話，圓移除後空的 SVG 還會留在地圖上
const waveRenderers = new Map();

function waveRendererOf(map) {
	if (!waveRenderers.has(map)) waveRenderers.set(map, L.svg());
	return waveRenderers.get(map);
}

function main(data) {
	if (showDialogtime) {
		lockScroll(false);
		$("#modal-overlay").fadeOut(0);
		showDialogtime.close();
		showDialogtime = null;
	}

	if (TREM.EEW.get(INFO[TINFO]?.ID).Cancel == undefined && ((setting["trem.ps"] && (data.type == "trem-eew" || data.author == "trem")) || (data.author != "trem"))) {
		if (data.depth != null) {

			/**
			 * @type {{p:number,s:number}} wave
			 */

			const wave = { p: 7, s: 4 };

			/**
			 * PS 波已走公尺數
			 * @type {number} kmP
			 * @type {number} km
			 */

			let kmP = 0;
			let km = 0;

			const km_time = (NOW().getTime() - data.time) / 1000;

			const _time_table = TREM.Resources.time[findClosest(TREM.Resources.time_list, data.depth)];
			let prev_table = null;

			for (const table of _time_table) {
				if (!kmP && table.P > km_time)
					if (prev_table) {
						const t_diff = table.P - prev_table.P;
						const r_diff = table.R - prev_table.R;
						const t_offset = km_time - prev_table.P;
						const r_offset = (t_offset / t_diff) * r_diff;
						kmP = prev_table.R + r_offset;
					} else {
						kmP = table.R;
					}

				if (!km && table.S > km_time)
					if (prev_table) {
						const t_diff = table.S - prev_table.S;
						const r_diff = table.R - prev_table.R;
						const t_offset = km_time - prev_table.S;
						const r_offset = (t_offset / t_diff) * r_diff;
						km = prev_table.R + r_offset;
					} else {
						km = table.R;
					}

				if (kmP && km) break;

				prev_table = table;
			}

			if (!kmP) kmP = Math.floor(Math.sqrt(Math.pow(km_time * wave.p, 2) - Math.pow(data.depth, 2)));

			if (!km) km = Math.floor(Math.sqrt(Math.pow(km_time * wave.s, 2) - Math.pow(data.depth, 2)));

			kmP *= 1000;
			km *= 1000;

			if (setting["shock.p"])
				if (kmP > 0) {
					if (!EarthquakeList[data.id].CircleP)
						EarthquakeList[data.id].CircleP = L.circle([+data.lat, +data.lon], {
							color     : "#6FB7B7",
							fillColor : "transparent",
							radius    : kmP,
							renderer  : waveRendererOf(Maps.main),
							className : "p-wave",
						}).addTo(Maps.main);

					if (!EarthquakeList[data.id].CircleP.getLatLng().equals([+data.lat, +data.lon]))
						EarthquakeList[data.id].CircleP
							.setLatLng([+data.lat, +data.lon]);

					EarthquakeList[data.id].CircleP
						.setRadius(kmP);

					if (!EarthquakeList[data.id].CirclePTW)
						EarthquakeList[data.id].CirclePTW = L.circle([data.lat, data.lon], {
							color     : "#6FB7B7",
							fillColor : "transparent",
							radius    : kmP,
							renderer  : waveRendererOf(Maps.mini),
							className : "p-wave",
						}).addTo(Maps.mini);

					if (!EarthquakeList[data.id].CirclePTW.getLatLng().equals([+data.lat, +data.lon]))
						EarthquakeList[data.id].CirclePTW
							.setLatLng([+data.lat, +data.lon]);

					EarthquakeList[data.id].CirclePTW
						.setRadius(kmP);
				}

			if (km > data.depth * 100) {
				if (TREM.EEW.get(data.id).waveProgress) {
					TREM.EEW.get(data.id).waveProgress.remove();
					delete TREM.EEW.get(data.id).waveProgress;
				}

				eew[data.id].km = km;

				if (!EarthquakeList[data.id].CircleS)
					EarthquakeList[data.id].CircleS = L.circle([+data.lat, +data.lon], {
						color       : data.Alert ? "red" : "orange",
						fillColor   : `url(#${data.Alert ? "alert" : "pred"}-gradient)`,
						fillOpacity : 1,
						radius      : km,
						renderer    : waveRendererOf(Maps.main),
						className   : "s-wave",
					}).addTo(Maps.main);

				if (!EarthquakeList[data.id].CircleS.getLatLng().equals([+data.lat, +data.lon]))
					EarthquakeList[data.id].CircleS
						.setLatLng([+data.lat, +data.lon]);

				EarthquakeList[data.id].CircleS.setRadius(km);

				if (EarthquakeList[data.id].CircleS.options.color != (data.Alert ? "red" : "orange"))
					EarthquakeList[data.id].CircleS.setStyle({
						color     : data.Alert ? "red" : "orange",
						fillColor : `url(#${data.Alert ? "alert" : "pred"}-gradient)`,
					});

				if (!EarthquakeList[data.id].CircleSTW)
					EarthquakeList[data.id].CircleSTW = L.circle([+data.lat, +data.lon], {
						color       : data.Alert ? "red" : "orange",
						fillColor   : `url(#${data.Alert ? "alert" : "pred"}-gradient)`,
						fillOpacity : 1,
						radius      : km,
						renderer    : waveRendererOf(Maps.mini),
						className   : "s-wave",
					}).addTo(Maps.mini);

				if (!EarthquakeList[data.id].CircleSTW.getLatLng().equals([+data.lat, +data.lon]))
					EarthquakeList[data.id].CircleSTW
						.setLatLng([+data.lat, +data.lon]);

				EarthquakeList[data.id].CircleSTW.setRadius(km);

				if (EarthquakeList[data.id].CircleSTW.options.color != (data.Alert ? "red" : "orange"))
					EarthquakeList[data.id].CircleSTW.setStyle({
						color     : data.Alert ? "red" : "orange",
						fillColor : `url(#${data.Alert ? "alert" : "pred"}-gradient)`,
					});
			} else {
				const num = Math.round(((NOW().getTime() - data.time) / 1000 / _time_table[0].S) * 100);
				// const num = (NOW().getTime() - data.time) / 10 / EarthquakeList[data.id].distance[1].Stime;
				const icon = L.divIcon({
					className : "progress_bar",
					html      : `<div style="background-color: aqua;height: ${num}%;"></div>`,
					iconSize  : [5, 50],
				});

				if (!TREM.EEW.get(data.id).waveProgress) {
					if (EarthquakeList[data.id].CircleS) {
						EarthquakeList[data.id].CircleS.remove();
						EarthquakeList[data.id].CircleS = null;
					} else if (EarthquakeList[data.id].CircleSTW) {
						EarthquakeList[data.id].CircleSTW.remove();
						EarthquakeList[data.id].CircleSTW = null;
					}

					if (EarthquakeList[data.id].CircleP) {
						EarthquakeList[data.id].CircleP.remove();
						EarthquakeList[data.id].CircleP = null;
					} else if (EarthquakeList[data.id].CirclePTW) {
						EarthquakeList[data.id].CirclePTW.remove();
						EarthquakeList[data.id].CirclePTW = null;
					}

					TREM.EEW.get(data.id).waveProgress = L.marker([+data.lat, +data.lon + 0.15], { icon: icon }).addTo(Maps.main);
				} else {
					TREM.EEW.get(data.id).waveProgress.setIcon(icon);
				}
			}
		}

		if (data.cancel)
			for (let index = 0; index < INFO.length; index++)
				if (INFO[index].ID == data.id) {
					INFO[index].alert_type = "alert-box eew-cancel";
					data.timestamp = NOW().getTime() - ((data.lon < 122.18 && data.lat < 25.47 && data.lon > 118.25 && data.lat > 21.77) ? 90_000 : 150_000);

					if (TREM.EEW.get(data.id).waveProgress) {
						TREM.EEW.get(data.id).waveProgress.remove();
						delete TREM.EEW.get(data.id).waveProgress;
					}

					TREM.Earthquake.emit("eewEnd", data.id);
					TREM.EEW.get(INFO[index].ID).Cancel = true;

					if (Object.keys(EarthquakeList).length == 1) {
						clearInterval(eew[data.id].t);
						audio.main = [];
						audio.minor = [];
					}

					break;
				}
	}

	// #region Epicenter Cross Icon

	let epicenterIcon;
	let offsetX = 0;
	let offsetY = 0;

	const cursor = INFO.findIndex((v) => v.ID == data.id) + 1;
	const iconUrl = cursor <= 4 && INFO.length > 1 ? `../image/cross${cursor}.png` : "../image/cross.png";

	if (cursor <= 4 && INFO.length > 1) {
		epicenterIcon = L.icon({
			iconUrl,
			iconSize  : [40, 40],
			className : "epicenterIcon",
		});

		if (cursor == 1) offsetY = 0.03;

		if (cursor == 2) offsetX = 0.03;

		if (cursor == 3) offsetY = -0.03;

		if (cursor == 4) offsetX = -0.03;

	} else {
		epicenterIcon = L.icon({
			iconUrl,
			iconSize  : [30, 30],
			className : "epicenterIcon",
		});
	}

	let epicenterIcon_tooltip = "";

	// main map
	if (!EarthquakeList[data.id].epicenterIcon) {
		epicenterIcon_tooltip = `<div>${data.Unit}</div><div>注意 ${cursor}</div><div>第 ${data.number} 報</div><div>規模: ${data.scale == null ? "?" : data.scale}</div><div>深度: ${data.depth == null ? "?" : data.depth} km</div>`;
		EarthquakeList[data.id].epicenterIcon = L.marker([+data.lat, +data.lon],
			{
				icon         : epicenterIcon,
				zIndexOffset : 6000,
			})
			.addTo(Maps.main)
			.bindTooltip(epicenterIcon_tooltip, {
				offset    : [8, 0],
				permanent : false,
				className : "eew-cursor-tooltip",
			});
	}

	// 要比 attribute：.src 讀回來是完整的 file:// 網址，跟相對路徑永遠不相等，每個 tick 都會重新載入圖片
	const epicenterImg = EarthquakeList[data.id].epicenterIcon.getElement();

	if (epicenterImg && epicenterImg.getAttribute("src") != iconUrl)
		epicenterImg.src = iconUrl;

	EarthquakeList[data.id].epicenterIcon.setLatLng([+data.lat, +data.lon]);

	// mini map
	if (!EarthquakeList[data.id].epicenterIconTW) {
		EarthquakeList[data.id].epicenterIconTW = L.marker([+data.lat + offsetY, +data.lon + offsetX], { icon: epicenterIcon }).addTo(Maps.mini);
		EarthquakeList[data.id].epicenterIconTW.getElement().classList.add("hide");
	}

	if (EarthquakeList[data.id].epicenterIconTW.getIcon()?.options?.iconUrl != epicenterIcon.options.iconUrl)
		EarthquakeList[data.id].epicenterIconTW.setIcon(epicenterIcon);

	if (!EarthquakeList[data.id].epicenterIconTW.getLatLng().equals([+data.lat + offsetY, +data.lon + offsetX]))
		EarthquakeList[data.id].epicenterIconTW.setLatLng([+data.lat + offsetY, +data.lon + offsetX]);

	if (!Timers.epicenterBlinker)
		Timers.epicenterBlinker = setInterval(() => {
			const epicenter_blink_state = EarthquakeList[Object.keys(EarthquakeList)[0]]?.epicenterIconTW?.getElement()?.classList?.contains("hide");

			if (epicenter_blink_state != undefined)
				for (const key in EarthquakeList) {
					const el = EarthquakeList[key];

					// if (epicenter_blink_state) {
					// 	if (el.epicenterIcon.getElement().classList.contains("hide"))
					// 		el.epicenterIcon.getElement().classList.remove("hide");
					// } else if (!el.epicenterIcon.getElement().classList.contains("hide")) {
					// 	el.epicenterIcon.getElement().classList.add("hide");
					// }

					if (key == INFO[TINFO].ID) {
						if (epicenter_blink_state) {
							if (el.epicenterIconTW.getElement().classList.contains("hide"))
								el.epicenterIconTW.getElement().classList.remove("hide");
						} else if (!el.epicenterIconTW.getElement().classList.contains("hide")) {
							el.epicenterIconTW.getElement().classList.add("hide");
						}
					} else if (!el.epicenterIconTW.getElement()?.classList?.contains("hide")) {
						el.epicenterIconTW.getElement().classList.add("hide");
					}
				}
		}, 500);

	// #endregion <- Epicenter Cross Icon


	if (NOW().getTime() - EEWshot > 60000)
		EEWshotC = 1;

	if (NOW().getTime() - EEWshot > 30000 && EEWshotC <= 2) {
		EEWshotC++;
		EEWshot = NOW().getTime();

		if (data.replay_time)
			setTimeout(() => {
				ipcRenderer.send("screenshotEEW", {
					Function : "replay_eew",
					ID       : data.id,
					Version  : data.Version,
					Time     : NOW().getTime(),
					Shot     : EEWshotC,
				});
			}, 300);
		else
			setTimeout(() => {
				ipcRenderer.send("screenshotEEW", {
					Function : "eew",
					ID       : data.id,
					Version  : data.Version,
					Time     : NOW().getTime(),
					Shot     : EEWshotC,
				});
			}, 300);
	}

	if (data.cancel) {
		if (Canceltime == 0) Canceltime = NOW().getTime();

		if (NOW().getTime() - Canceltime > 300_000) Cancel = true;
	}

	// 所在地 S 波抵達 30 秒後結束；沒有深度（推算不出抵達時間）時，最後一報後 5 分鐘結束
	const sTime = INFO.find((v) => v.ID == data.id)?.alert_sTime;
	const sPassed = sTime != null && NOW().getTime() - sTime > 30_000;

	if (NOW().getTime() - data.timestamp > 300_000 || sPassed || Cancel) {
		TREM.Earthquake.emit("eewEnd", data.id, data.type);
		// TREM.MapIntensity.clear();

		// remove epicenter cross icons
		EarthquakeList[data.id].epicenterIcon.remove();
		EarthquakeList[data.id].epicenterIconTW.remove();

		for (let index = 0; index < INFO.length; index++)
			if (INFO[index].ID == data.id) {
				TINFO = 0;
				INFO.splice(index, 1);
				break;
			}

		if (TREM.EEW.get(data.id)?.waveProgress) {
			TREM.EEW.get(data.id).waveProgress.remove();
			delete TREM.EEW.get(data.id).waveProgress;
		}


		if (TREM.EEW.get(data.id)?.geojson) {
			TREM.EEW.get(data.id).geojson.remove();
			delete TREM.EEW.get(data.id).geojson;
		}

		clearInterval(EarthquakeList[data.id].Timer);
		document.getElementById("box-10").innerHTML = "";

		if (eew[data.id].t != null) {
			clearInterval(eew[data.id].t);
			eew[data.id].t = null;
		}

		// if (EarthquakeList[data.id].Depth != null) Maps.main.removeLayer(EarthquakeList[data.id].Depth);
		delete EarthquakeList[data.id];
		delete eew[data.id];

		if (Object.keys(EarthquakeList).length == 0) {
			for (let index = 0, keys = Object.keys(eew), n = keys.length; index < n; index++)
				clearInterval(eew[keys[index]].t);
			audio.main = [];
			audio.minor = [];
			eew = {};
			EEWAlert = false;
			// hide eew alert
			clearInterval(Timers.ticker);
			Timers.ticker = null;
			Cancel = false;
			Canceltime = 0;
			INFO = [];
			Info = { Notify: [], Warn: [], Focus: [] };
			$("#alert-box").removeClass("show");
			$("#map-legends").removeClass("show");
			// hide minimap
			$("#map-tw").removeClass("show");

			// restore reports（震動檢測還在進行時維持隱藏）
			if (!rtsRollHidden) $(roll).fadeIn(200);
			clearInterval(Timers.epicenterBlinker);
			delete Timers.epicenterBlinker;
			clearInterval(Timers.eew);
			Timers.eew = null;
			rts_remove_eew = false;

			if (ReportTag == 0) stopReplay();
		}
	}
}

function tsunami_color(color) {
	return (color == "大於6公尺") ? "#B131FF" : (color == "3至6公尺") ? "red" : (color == "1至3公尺") ? "#FFEF29" : "#5CEE18";
}

function clear(ID, type) {
	// if (type != "trem-eew" || type != "trem") {
	if (EarthquakeList[ID].CircleS != undefined) EarthquakeList[ID].CircleS = EarthquakeList[ID].CircleS.remove();

	if (EarthquakeList[ID].CircleP != undefined) EarthquakeList[ID].CircleP = EarthquakeList[ID].CircleP.remove();

	if (EarthquakeList[ID].CircleSTW != undefined) Maps.mini.removeLayer(EarthquakeList[ID].CircleSTW);

	if (EarthquakeList[ID].CirclePTW != undefined) Maps.mini.removeLayer(EarthquakeList[ID].CirclePTW);
	// }
}

function updateText() {
	const info = INFO[TINFO];

	setClassName(document.getElementById("alert-box"), `${info.alert_type} ${IntensityToClassString(info.alert_intensity)} show`);
	setClassName(document.getElementById("alert-local"), `alert-item ${IntensityToClassString(info.alert_local)}`);
	setText(document.getElementById("alert-provider"), `${INFO.length > 1 ? `${TINFO + 1} ` : ""}${info.alert_provider}`);
	setText(document.getElementById("alert-number"), info.alert_number);
	setText(document.getElementById("alert-location"), info.alert_location);
	setText(document.getElementById("alert-time"), timeconvert(info.alert_time).format("YYYY/MM/DD HH:mm:ss"));
	setText(document.getElementById("alert-magnitude"), info.alert_magnitude);
	setText(document.getElementById("alert-depth"), info.alert_depth);
	document.getElementById("map-legends").classList.add("show");

	const alertP = document.getElementById("alert-p");
	const alertS = document.getElementById("alert-s");

	if (TREM.EEW.get(info.ID).Cancel != undefined) {
		setText(alertP, "X");
		setText(alertS, "X");
	} else if (info.alert_sTime == null) {
		setText(alertP, "?");
		setText(alertS, "?");
	} else {
		const left = (t) => {
			const num = Math.floor((t - NOW().getTime()) / 1000);
			return num <= 0 ? "" : num;
		};

		setText(alertS, left(info.alert_sTime));
		setText(alertP, left(info.alert_pTime));
	}

	// bring waves to front
	// if (EarthquakeList[info.ID].CircleP) EarthquakeList[info.ID].CircleP.bringToFront();
	// if (EarthquakeList[info.ID].CircleS) EarthquakeList[info.ID].CircleS.bringToFront();

	// 小地圖只顯示目前這一報的震央與震波（這些圖層存在 EarthquakeList，之前從 TREM.EEW 找，永遠找不到）
	for (const key in EarthquakeList) {
		const hidden = key != info.ID;

		for (const layer of [
			EarthquakeList[key].epicenterIconTW,
			EarthquakeList[key].CirclePTW,
			EarthquakeList[key].CircleSTW,
		])
			layer?.getElement?.()?.classList.toggle("hide", hidden);

		// 每秒都會執行：目前顯示的這一報不要移除再加回，否則色塊會每秒閃一次
		if (TREM.EEW.get(key)?.geojson && hidden)
			TREM.EEW.get(key).geojson.remove();
	}

	if (TREM.EEW.get(info.ID)?.geojson && !Maps.mini.hasLayer(TREM.EEW.get(info.ID).geojson)) TREM.EEW.get(info.ID).geojson.addTo(Maps.mini);
}

const changeView = (args, el, event) => {
	if (event instanceof KeyboardEvent && event?.key !== "Enter" && event?.key !== " ")
		return;

	const currentel = $(".view.show");
	const changeel = $(`#${args}`);

	if (changeel.attr("id") == currentel.attr("id")) return;

	const currentnav = $(".active");
	currentnav.removeClass("active");
	$(el)?.addClass("active");

	currentel.removeClass("show");
	changeel.addClass("show");

	if (changeel.attr("id") == "report") {
		// 報告列表的「TREM」篩選只篩「地震資訊」報告，現在已沒有這類資料，維持隱藏
		TREM.Report.api_key_verify = false;
		TREM.Report.report_trem = setting["report.trem"];
		TREM.Report.report_tremeew = setting["report.tremeew"];
		TREM.Report.station = station;
		toggleNav(false);
	}

	if (changeel.attr("id") == "intensity")
		toggleNav(false);

	if (changeel.attr("id") == "main") {
		TREM.Report.setView("report-list");
		toggleNav(false);
	}

	TREM.emit("viewChange", currentel.attr("id"), changeel.attr("id"));
};

function findClosest(arr, target) {
	return arr.reduce((prev, curr) => (Math.abs(curr - target) < Math.abs(prev - target) ? curr : prev));
}

function NOW() {
	return new Date(realNow());
}

// 台灣沒有日光節約時間，固定 UTC+8；不用 toLocaleString，它每次都要建時區格式器，每秒對每個測站呼叫很耗 CPU
const TAIPEI_OFFSET_MS = 8 * 3_600_000;

/** 回傳一個本機時區欄位等於台北時間的 Date（給 .format 顯示用，精確到秒） */
function timeconvert(time) {
	const t = new Date(time.getTime() + TAIPEI_OFFSET_MS);
	return new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds());
}

function globalgc() {
	global.gc();
}

ipcRenderer.on("app-before-quit", () => {
	trem_sse?.stop();
	eew_sse?.stop();
	log("Streams closed", 1, "TREM", "quit");

	// 通知主程序已準備好退出
	ipcRenderer.send("app-quit-response");
});

ipcRenderer.on("app-before-reload", () => {
	trem_sse?.stop();
	eew_sse?.stop();
	log("Streams closed", 1, "TREM", "reload");

	// 通知主程序已準備好退出
	ipcRenderer.send("app-quit-reload");
});