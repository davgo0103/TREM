/* global maplibregl:false, Maps: false, IntensityToClassString: false, Maps.report: true, IntensityI: false, changeView: false, replay: true, replayT: true, ReplayData: false, shell: false */

TREM.Report = {
	cache               : new Map(),
	view                : "report-list",
	reportList          : [],
	reportListElement   : document.getElementById("report-list-container"),
	api_key_verify      : false,
	station             : {},
	report_trem         : false,
	report_tremeew      : false,
	report_trem_station : {},
	report_trem_data    : [],
	report_eew_data     : [],
	report_station      : {},
	epicenterIcon       : null,
	report_circle_trem  : null,
	report_circle_cwb   : null,
	report_circle_rf    : null,
	replayHttp          : false,
	route               : route,

	/**
	 * @type {maplibregl.Marker[]}
	 */
	_markersTREM          : [],
	_markers              : [],
	_markersGroup         : null,
	_lastFocus            : [],
	_filterHasReplay      : false,
	_filterHasNumber      : false,
	_filterMagnitude      : false,
	_filterMagnitudeValue : 5,
	_filterIntensity      : false,
	_filterIntensityValue : 4,
	_filterTREM           : false,
	_filterCWA            : true,
	_filterDate           : false,
	_filterDateValue      : "",
	_filterMonth          : false,
	_filterMonthValue     : "",
	_reportItemTemplate   : document.getElementById("template-report-list-item"),
	_report_trem_data     : storage.getItem("report_trem_data") ?? [],
	_report_eew_data      : storage.getItem("report_eew_data") ?? [],
	_report_Temp          : null,
	get _mapPaddingLeft() {
		return document.getElementById("map-report").offsetWidth / 2;
	},
	unloadReports(skipCheck = false) {
		if (this.view == "report-list" || skipCheck) {
			this.reportListElement.replaceChildren();
			this._clearMap();
		}
	},
	loadReports(skipCheck = false) {
		if (this.view == "report-list" || skipCheck) {
			const fragment = new DocumentFragment();
			const reports = Array.from(this.cache, ([k, v]) => v);

			this.reportList = reports.filter((v) => this._matchesFilter(v));

			for (const report of reports) {
				const element = this._createReportItem(report);

				if (!report.originTime) {
					log(report, 3, "loadReports", "Report");
					continue;
				}

				if (!this._matchesFilter(report)) {
					element.classList.add("hide");
					element.style.display = "none";
				} else {
					this._markers.push(L.marker(
						[report.lat, report.lon],
						{
							icon: L.divIcon({
								html      : TREM.Resources.icon.oldcross,
								iconSize  : [report.mag * 4, report.mag * 4],
								className : `epicenterIcon ${IntensityToClassString(report.int)}`,
							}),
							opacity      : (reports.length - reports.indexOf(report)) / reports.length,
							zIndexOffset : 1000 + reports.length - reports.indexOf(report),
						})
						.on("click", () => {
							TREM.set_report_overview = 0;
							this.setView("report-overview", report.id);
						}));
					this._markersGroup = L.featureGroup(this._markers).addTo(Maps.report);
				}

				fragment.appendChild(element);
			}

			document.getElementById("report-detail-header-number").innerText = `共 ${this.reportList.length} 個`;
			this.reportListElement.appendChild(fragment);
		}
	},
	_createReportItem(report) {
		const el = document.importNode(this._reportItemTemplate.content, true).querySelector(".report-list-item");

		el.id = report.id;
		el.className += ` ${IntensityToClassString(report.int)}`;
		el.querySelector(".report-list-item-location").innerText = report.loc;
		el.querySelector(".report-list-item-id").innerText = TREM.Localization.getString(report.loc.startsWith("地震資訊") ? "Report_Title_Local" : (report.no % 1000 ? report.no : "Report_Title_Small"));
		el.querySelector(".report-list-item-unit-Magnitude").innerText = (report.loc.startsWith("地震資訊")) ? "d" : "L";
		el.querySelector(".report-list-item-Magnitude").innerText = report.mag == 0 ? "0.0" : report.mag;
		const time = new Date(new Date(report.time).toLocaleString("en-US", { hourCycle: "h23", timeZone: "Asia/Taipei" })).format("YYYY/MM/DD HH:mm:ss");
		el.querySelector(".report-list-item-time").innerText = time;

		el.querySelector("button").value = report.id;
		el.querySelector("button").addEventListener("click", function() {
			TREM.Report.setView("report-overview", this.value);
		});
		ripple(el.querySelector("button"));

		return el;
	},

	/**
	 * 報告是否符合目前勾選的篩選條件
	 * @param {EarthquakeReport} report
	 */
	_matchesFilter(report) {
		const date = report.originTime?.split(" ")[0] ?? "";
		const mag = report.mag;

		return !(
			(this._filterHasNumber && !(report.no % 1000))
			|| (this._filterHasReplay && !(report.trem && report.trem != 1000))
			|| (this._filterMagnitude && !(this._filterMagnitudeValue == -1 ? mag == 0.0 : this._filterMagnitudeValue == 0 ? mag < 1.0 : this._filterMagnitudeValue == 1 ? mag < 2.0 : this._filterMagnitudeValue == 2 ? mag < 3.0 : this._filterMagnitudeValue == 3 ? mag < 4.0 : this._filterMagnitudeValue == 45 ? mag < 4.5 : mag >= 4.5))
			|| (this._filterIntensity && report.int != this._filterIntensityValue)
			|| (this._filterTREM && !report.loc.startsWith("地震資訊"))
			|| (this._filterCWA && report.id.match(/-/g).length !== 3)
			|| (this._filterDate && date != this._filterDateValue)
			|| (this._filterMonth && (date.split("/")[0] + "/" + date.split("/")[1]) != this._filterMonthValue)
		);
	},

	/**
	 * @param {*} key
	 * @param {*} value
	 * @param {HTMLSelectElement} select
	 */
	_handleFilter(key, value, select) {
		const oldlist = [...this.reportList];
		this[`_${key}`] = value;

		if (key == "filterTREM" && value) {
			const element = document.getElementById("report-label-filter-hasNumber");
			element.classList.add("hide");
			element.style.display = "none";
			const element1 = document.getElementById("report-label-filter-intensity");
			element1.classList.add("hide");
			element1.style.display = "none";
			const element2 = document.getElementById("report-label-filter-CWA");
			element2.classList.add("hide");
			element2.style.display = "none";
			this._filterHasNumber = false;
			this._filterIntensity = false;
			this._filterCWA = false;
		} else if (key == "filterTREM" && !value) {
			const element = document.getElementById("report-label-filter-hasNumber");
			element.classList.remove("hide");
			element.style.display = "block";
			const element1 = document.getElementById("report-label-filter-intensity");
			element1.classList.remove("hide");
			element1.style.display = "block";
			const element2 = document.getElementById("report-label-filter-CWA");
			element2.classList.remove("hide");
			element2.style.display = "block";
			this._filterCWA = true;
			const element3 = document.getElementById("report-filter-CWA");
			element3.checked = true;
			const element5 = document.getElementById("report-filter-hasNumber");
			element5.checked = false;
			const element6 = document.getElementById("report-filter-intensity");
			element6.checked = false;
		}

		if (select) {
			const parent = document.getElementById(select.id.slice(0, select.id.length - 6));

			if (!parent.checked)
				return parent.click();
		}

		this._filterDateValue = this._filterDateValue.replace(/-/g, "/");
		this._filterMonthValue = this._filterMonthValue.replace(/-/g, "/");

		this.reportList = Array.from(this.cache, ([k, v]) => v).filter((v) => this._matchesFilter(v));

		document.getElementById("report-detail-header-number").innerText = `共 ${this.reportList.length} 個`;
		this._updateReports(oldlist, this.reportList);
	},
	setView(view, reportIdentifier) {
		if (this.view == view)
			if (!reportIdentifier)
				return;

		const oldView = document.getElementById(this.view);
		let newView = document.getElementById(view);

		document.getElementById("report-detail-body").style.height = `${oldView.offsetHeight + 16 }px`;
		document.getElementById("report-detail-body").style.width = `${oldView.offsetWidth + 16 }px`;

		switch (view) {
			case "report-list": {
				this._clearMap(true);
				this.loadReports(true);
				this._focusMap();
				this._setup_api_key_verify();
				document.getElementById("report-detail-back").classList.add("hide");
				document.getElementById("report-detail-refresh").classList.remove("hide");
				document.getElementById("report-detail-header-number").style.display = "";
				break;
			}

			case "report-overview": {
				if (this.view == "report-list") this.unloadReports(true);
				this._setupReport(this.cache.get(reportIdentifier));
				document.getElementById("report-detail-back").classList.remove("hide");
				document.getElementById("report-detail-refresh").classList.add("hide");
				document.getElementById("report-detail-header-number").style.display = "none";
				break;
			}

			case "eq-report-overview": {
				if (this.view == "report-list") this.unloadReports(true);
				this._setupReport(reportIdentifier, true);
				document.getElementById("report-detail-back").classList.remove("hide");
				document.getElementById("report-detail-refresh").classList.add("hide");
				document.getElementById("report-detail-header-number").style.display = "none";
				break;
			}

			default:
				break;
		}

		if (view == "eq-report-overview") {
			view = "report-overview";
			newView = document.getElementById(view);
		}

		if (this.view != view) {
			oldView.classList.remove("show");
			newView.style.position = "absolute";
			newView.style.visibility = "visible";
			document.getElementById("report-detail-body").style.height = `${newView.offsetHeight + 16 }px`;
			document.getElementById("report-detail-body").style.width = `${newView.offsetWidth + 16 }px`;
			setTimeout(() => {
				oldView.style.visibility = "hidden";
				newView.classList.add("show");
			}, 250);
		}

		setTimeout(() => {
			newView.style.position = "";
			document.getElementById("report-detail-body").style.height = "";
			document.getElementById("report-detail-body").style.width = "";
		}, 500);

		this.view = view;
	},
	replay(id) {
		const report = this.cache.get(id);

		if (replay != 0) return;
		changeView("main", "#mainView_btn");

		// 重播資料下載完整就讀本機檔案，否則向伺服器要
		if (ReplayData.stateOf(report) == "complete") {
			ipcRenderer.send("testoldtime", report.time);
		} else {
			this.replayHttp = true;
			ipcRenderer.send("testoldtimeEEW", report.time);
		}
	},

	/** 下載重播資料；下載到一半的會從中斷處繼續 */
	replaydownloader(id) {
		const report = this.cache.get(id);

		if (!report || ReplayData.progressOf(report) || ReplayData.stateOf(report) == "complete") return;

		if (ReportTag) ReportTag = 0;

		ReplayData.download(report, () => this._updateDownloadButton(report))
			.then(() => log(`Replay data downloaded: ${report.id}`, 1, "Report", "replaydownloader"))
			.catch((err) => {
				if (err?.name == "AbortError") return;

				log(err, 3, "Report", "replaydownloader");
				showDialog("error", "下載重播資料", `下載失敗，再按一次「繼續下載」會從中斷處接著下載。
${err}`);
			})
			.finally(() => this._updateDownloadButton(report));

		this._updateDownloadButton(report);
	},

	/** 右鍵：刪除重播資料（下載中會先停止） */
	replaydownloaderrm(id) {
		const report = this.cache.get(id);

		if (!report || (ReplayData.stateOf(report) == "none" && !ReplayData.progressOf(report))) return;

		showDialog("warn", "刪除重播資料", `確定要刪除這筆地震的重播資料嗎？
${report.loc ?? ""}`, 1, "delete", () => {
			ReplayData.remove(report)
				.catch((err) => log(err, 3, "Report", "replaydownloaderrm"))
				.finally(() => this._updateDownloadButton(report));
		});
	},

	openReplayFolder(id) {
		const report = this.cache.get(id);

		if (report) shell.openPath(ReplayData.dirOf(report));
	},

	/** 依下載狀態更新按鈕；只更新目前顯示中的報告，其他報告在背景下載時不影響畫面 */
	_updateDownloadButton(report) {
		const button = document.getElementById("report-replay-downloader");

		if (!button || button.value != report.id) return;

		const progress = ReplayData.progressOf(report);
		const state = ReplayData.stateOf(report);
		const bar = document.getElementById("downloader_progress");
		const [icon, text] = progress ? ["downloading", `下載中 ${Math.floor(progress.done / progress.total * 100)}%`]
			: state == "complete" ? ["download_done", "已下載"]
				: state == "partial" ? ["download", "繼續下載"]
					: ["download", "下載"];

		document.getElementById("report-replay-downloader-icon").innerText = icon;
		document.getElementById("report-replay-downloader-text").innerText = text;
		bar.style.display = progress ? "" : "none";

		if (progress) bar.value = progress.done / progress.total;

		const hasData = progress || state != "none";
		button.title = hasData ? "" : "下載這筆地震前後的測站與速報資料，之後重播不需連線";

		for (const id of ["report-replay-folder", "report-replay-delete"])
			document.getElementById(id).style.display = hasData ? "" : "none";
	},
	back() {
		if (TREM.set_report_overview != 0)
			TREM.backindexButton();

		switch (this.view) {
			case "report-overview":
				this.setView("report-list");
				break;

			default:
				break;
		}
	},
	refreshList() {
		this.unloadReports();
		this.loadReports();
		this._focusMap();
		this._setup_api_key_verify();
	},
	copyReport(id) {
		const report = this.cache.get(id);
		const string = [];

		string.push(`　　　　　　　　　　${report.loc.startsWith("地震資訊") ? "地震資訊" : "中央氣象署"}地震測報中心　${TREM.Localization.getString(report.loc.startsWith("地震資訊") ? "Report_Title_Local" : (report.no % 1000 ? `第${report.no.toString().slice(-3)}號有感地震報告` : "Report_Title_Small"))}`);

		// 臺灣時間的年月日時分秒
		const time = new Date(new Date(report.time).toLocaleString("en-US", { hourCycle: "h23", timeZone: "Asia/Taipei" }));
		string.push(`　　　　　　　　　　發　震　時　間： ${time.getFullYear() - 1911}年${(time.getMonth() + 1 < 10 ? " " : "") + (time.getMonth() + 1)}月${(time.getDate() < 10 ? " " : "") + time.getDate()}日${(time.getHours() < 10 ? " " : "") + time.getHours()}時${(time.getMinutes() < 10 ? " " : "") + time.getMinutes()}分${(time.getSeconds() < 10 ? " " : "") + time.getSeconds()}秒`);
		string.push(`　　　　　　　　　　震　央　位　置： 北　緯　 ${report.lat.toFixed(2)} °`);
		string.push(`　　　　　　　　　　　　　　　　　　 東  經　${report.lon.toFixed(2)} °`);
		string.push(`　　　　　　　　　　震　源　深　度：　 ${report.depth < 10 ? " " : ""}${report.depth.toFixed(1)}  公里`);
		string.push(`　　　　　　　　　　芮　氏　規　模：　  ${report.mag.toFixed(1)}`);
		string.push(`　　　　　　　　　　相　對　位　置： ${report.loc}`);
		string.push("");
		string.push("                                 各 地 震 度 級");
		string.push("");

		const name = (text) => text.length < 3 ? text.split("").join("　") : text;
		const int = (number) => `${IntensityI(number)}級`.replace("-級", "弱").replace("+級", "強");
		const areas = [];

		if (report.list)
			for (let index = 0, keys = Object.keys(report.list), n = keys.length; index < n; index++) {
				const areaString = [];
				areaString.push(`${keys[index]}地區最大震度 ${int(report.list[keys[index]].int)}`);

				for (let station_index = 0, station_keys = Object.keys(report.list[keys[index]].town), o = station_keys.length; station_index < o; station_index++)
					areaString.push(`　　　${name(station_keys[station_index])} ${int(report.list[keys[index]].town[station_keys[station_index]].int)}　　　`);

				areas.push(areaString);
			}

		let count = areas.length;

		if (count > 2)
			while (count > 0) {
				const threeAreas = [
					areas.shift(),
					areas.shift(),
					areas.shift(),
				];
				const whichToLoop = threeAreas[threeAreas.reduce((p, c, i, a) => a[p]?.length > c?.length ? p : i, 0)];
				const theLine = [];

				for (const index in whichToLoop) {
					const a = threeAreas[0][index];
					const b = threeAreas[1][index];
					const c = threeAreas[2][index];
					let strToPush = "";

					if (a)
						strToPush += a;
					else
						strToPush += "　　　　　　　　　　　";

					if (b)
						strToPush += `　　　${b}`;
					else
						strToPush += "　　　　　　　　　　　　　　";

					if (c)
						strToPush += `　　　${c}`;
					else
						strToPush += "　　　　　　　　　　　";
					theLine.push(strToPush.trimEnd());
				}

				string.push(theLine.join("\n"));
				count -= 3;
				continue;
			}
		else
			for (const area of areas) {
				const theLine = [];

				for (const str of area) {
					let strToPush = "";

					if (str)
						strToPush += `　　　　　　　　　　　　　　${str}`;

					theLine.push(strToPush.trimEnd());
				}

				string.push(theLine.join("\n"));
			}

		const filepath = path.join(app.getPath("temp"), `TREM_Report_${id}.txt`);
		fs.writeFileSync(filepath, string.join("\n"), { encoding: "utf-8" });
		ipcRenderer.send("openFolder", filepath);
		setTimeout(() => fs.rmSync(filepath), 5_000);
	},

	/**
	 * @param {EarthquakeReport[]} oldlist
	 * @param {EarthquakeReport[]} newlist
	 */
	_updateReports(oldlist, newlist) {
		const removed = oldlist.filter(v => !newlist.includes(v));
		const added = newlist.filter(v => !oldlist.includes(v));
		const keys = [...this.cache.keys()];

		this._clearMap();

		for (const report of removed)
			this._hideItem(document.getElementById(report.id));

		for (const report of added)
			this._showItem(document.getElementById(report.id));

		for (const report of newlist) {
			this._markers.push(L.marker(
				[report.lat, report.lon],
				{
					icon: L.divIcon({
						html      : TREM.Resources.icon.oldcross,
						iconSize  : [report.mag * 4, report.mag * 4],
						className : `epicenterIcon ${IntensityToClassString(report.int)}`,
					}),
					opacity      : (newlist.length - newlist.indexOf(report)) / newlist.length,
					zIndexOffset : 1000 + this.cache.size - keys.indexOf(report.id),
				})
				.on("click", () => {
					TREM.set_report_overview = 0;
					this.setView("report-overview", report.id);
				}));

			this._markersGroup = L.featureGroup(this._markers).addTo(Maps.report);
		}
	},

	/**
	 * @param {HTMLElement} element
	 */
	_hideItem(element) {
		element.classList.add("hide");
		setTimeout(() => element.style.display = "none", 200);
	},

	/**
	 * @param {HTMLElement} element
	 * @param {HTMLElement} reference
	 */
	_showItem(element) {
		element.style.display = "";
		setTimeout(() => element.classList.remove("hide"), 10);
	},
	_focusMap(...args) {
		if (args.length) {
			this._lastFocus = [...args];
			Maps.report.fitBounds(...args);
		} else if (this._lastFocus.length) {
			Maps.report.fitBounds(...this._lastFocus);
		} else {
			this._lastFocus = [[[25.35, 119.4], [21.9, 122.22]], { paddingTopLeft: [this._mapPaddingLeft, 0] }];
			Maps.report.fitBounds(...this._lastFocus);
		}
	},
	_clearMap(resetFoucs = false) {
		if (this._markers.length) {
			for (const marker of this._markers)
				marker.remove();
			this._markers = [];
		}

		if (resetFoucs) {
			this._lastFocus = [];
			this._focusMap();
		}
	},

	/**
	 * @param {EarthquakeReport} report
	 */
	_setupReport(report, skip = false) {
		this._clearMap();

		console.debug(report);

		if (!report) return;

		if (report.loc) {
			// 重播與下載按鈕以 value 帶報告 ID
			for (const id of ["report-replay", "report-replay-downloader"]) {
				const button = document.getElementById(id);

				if (button) button.value = report.id;
			}

			if (!report.list) {
				fetch(this.route.earthquakeReport(report.id))
					.then((res) => {
						if (res.ok) {
							console.debug(res);

							res.json().then(res1 => {
								console.debug(res1);

								report.list = res1.list;

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
											const station = report.list[areaName].town[station_name];
											const distance = TREM.Utils.twoPointDistance(
												{ lat: report.lat, lon: report.lon },
												{ lat: station.lat, lon: station.lon },
											).toFixed(2);
											report.list[areaName].town[station_name].distance = distance;

											if (Max_Level_distance > parseFloat(distance))
												if (Max_Level_areaName === areaName) {
													if (Max_Level === station.int) {
														Max_Level_stationName = station_name;
														Max_Level_distance = parseFloat(distance);
													}
												} else if (Max_Level === station.int) {
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

								ipcRenderer.send("report-Notification", report);

								let _report_data = [];
								_report_data = storage.getItem("report_data");

								for (let _i = 0; _i < _report_data.length; _i++)
									if (_report_data[_i]?.id)
										if (_report_data[_i].id === report.id)
											_report_data[_i] = report;

								storage.setItem("report_data", _report_data);
								// ipcRenderer.send("ReportGET");

								document.getElementById("report-overview-number").innerText = TREM.Localization.getString(report.loc.startsWith("地震資訊") ? "Report_Title_Local" : (report.no % 1000 ? report.no : "Report_Title_Small"));
								document.getElementById("report-overview-location").innerText = report.loc;
								const time = new Date(new Date(report.time).toLocaleString("en-US", { hourCycle: "h23", timeZone: "Asia/Taipei" }));
								document.getElementById("report-overview-time").innerText = time.format("YYYY/MM/DD HH:mm:ss");
								document.getElementById("report-overview-latitude").innerText = report.lat;
								document.getElementById("report-overview-longitude").innerText = report.lon;

								if (report.loc.startsWith("地震資訊")) {
									document.getElementById("report-overview-intensity").parentElement.parentElement.style.display = "none";
								} else {
									document.getElementById("report-overview-intensity").parentElement.parentElement.style.display = "";
									const int = `${IntensityI(report.Max_Level)}`.split("");
									document.getElementById("report-overview-intensity").innerText = int[0];
									document.getElementById("report-overview-intensity").className = (int[1] == "+") ? "strong"
										: (int[1] == "-") ? "weak"
											: "";
								}

								document.getElementById("report-overview-intensity-location").innerText = (report.loc.startsWith("地震資訊")) ? "" : `${report.Max_Level_areaName} ${report.Max_Level_stationName}`;
								document.getElementById("report-overview-unit-magnitude").innerText = (report.loc.startsWith("地震資訊")) ? "d" : "L";
								document.getElementById("report-overview-magnitude").innerText = report.mag == 0 ? "0.0" : report.mag;
								document.getElementById("report-overview-depth").innerText = report.depth;

								document.getElementById("report-detail-copy").style.display = "";
								document.getElementById("report-detail-copy").value = report.id;

								this._updateDownloadButton(report);

								if (report.loc.startsWith("地震資訊")) {
									document.getElementById("report-cwb").style.display = "none";
									document.getElementById("report-scweb").style.display = "none";
								} else {
									document.getElementById("report-cwb").style.display = "";
									document.getElementById("report-scweb").style.display = "";

									const cwb_code = "EQ"
										+ report.no
										+ "-"
										+ (time.getMonth() + 1 < 10 ? "0" : "") + (time.getMonth() + 1)
										+ (time.getDate() < 10 ? "0" : "") + time.getDate()
										+ "-"
										+ (time.getHours() < 10 ? "0" : "") + time.getHours()
										+ (time.getMinutes() < 10 ? "0" : "") + time.getMinutes()
										+ (time.getSeconds() < 10 ? "0" : "") + time.getSeconds();
									document.getElementById("report-cwb").value = `https://www.cwa.gov.tw/V8/C/E/EQ/${cwb_code}.html`;

									const scweb_code = ""
										+ time.getFullYear()
										+ (time.getMonth() + 1 < 10 ? "0" : "") + (time.getMonth() + 1)
										+ (time.getDate() < 10 ? "0" : "") + time.getDate()
										+ (time.getHours() < 10 ? "0" : "") + time.getHours()
										+ (time.getMinutes() < 10 ? "0" : "") + time.getMinutes()
										+ (time.getSeconds() < 10 ? "0" : "") + time.getSeconds()
										+ (report.mag * 10)
										+ (report.no % 1000 ? report.no.toString().slice(-3) : "");
									document.getElementById("report-scweb").value = `https://scweb.cwa.gov.tw/zh-tw/earthquake/details/${scweb_code}`;
								}

								let Station_i = 0;
								this.report_station = {};

								if (Object.keys(report.list).length)
									for (let index = 0, keys = Object.keys(report.list), n = keys.length; index < n; index++)
										for (let station_index = 0, station_keys = Object.keys(report.list[keys[index]].town), o = station_keys.length; station_index < o; station_index++) {
											const station = report.list[keys[index]].town[station_keys[station_index]];
											const station_tooltip = `<div>測站地名: ${keys[index]} ${station_keys[station_index]}</div><div>距離震央: ${station.distance} km</div><div>震度: ${IntensityI(station.int)}</div>`;
											this.report_station[Station_i] = L.marker(
												[station.lat, station.lon],
												{
													icon: L.divIcon({
														iconSize  : [16, 16],
														className : `map-intensity-icon ${IntensityToClassString(station.int)}`,
													}),
													zIndexOffset: 200 + station.int,
												}).bindTooltip(station_tooltip, {
												offset    : [8, 0],
												permanent : false,
												className : "report-cursor-tooltip",
											});
											this._markers.push(this.report_station[Station_i]);
											Station_i += 1;
										}

								// console.log(this.report_station);
								this.epicenterIcon = null;
								this.epicenterIcon = L.marker(
									[report.lat, report.lon],
									{
										icon: L.divIcon({
											html      : TREM.Resources.icon.oldcross,
											iconSize  : [32, 32],
											className : "epicenterIcon",
										}),
										zIndexOffset: 5000,
									});
								this._markers.push(this.epicenterIcon);

								this.report_trem_data = this._report_trem_data;
								this.report_eew_data = this._report_eew_data;
								this._report_Temp = report;
								this._setuptremget(report);
								this._setupeewget(report);
							});
						} else {
							console.error(res);

							switch (res.status) {
								case 429: {
									log(res.status, 3, "report_list_info", "Report");
									dump({ level: 2, message: res.status });
									break;
								}

								case 404: {
									log(res.status, 3, "report_list_info", "Report");
									dump({ level: 2, message: res.status });
									break;
								}

								case 500: {
									log(res.status, 3, "report_list_info", "Report");
									dump({ level: 2, message: res.status });
									break;
								}

								default: break;
							}
						}
					}).catch(err => {
						console.log(err.message);
						log(err, 3, "report_list", "Report");
						dump({ level: 2, message: err });
						return "err";
					});
			} else if (report.list) {
				if (!report.Max_Level) {
					let Max_Level = 0;
					let Max_Level_areaName = "";
					let Max_Level_stationName = "";
					let Max_Level_distance = Number.POSITIVE_INFINITY;

					for (let index = 0, keys = Object.keys(report.list), n = keys.length; index < n; index++) {
						const areaName = keys[index];

						if (Max_Level < report.list[areaName].int) {
							Max_Level = report.list[areaName].int;
							Max_Level_areaName = areaName;
							Max_Level_distance = Number.POSITIVE_INFINITY;
						}

						for (let station_index = 0, station_keys = Object.keys(report.list[areaName].town), o = station_keys.length; station_index < o; station_index++) {
							const station_name = station_keys[station_index];
							const station = report.list[areaName].town[station_name];
							const distance = TREM.Utils.twoPointDistance(
								{ lat: report.lat, lon: report.lon },
								{ lat: station.lat, lon: station.lon },
							).toFixed(2);
							report.list[areaName].town[station_name].distance = distance;

							if (Max_Level_distance > parseFloat(distance))
								if (Max_Level_areaName === areaName) {
									if (Max_Level === station.int) {
										Max_Level_stationName = station_name;
										Max_Level_distance = parseFloat(distance);
									}
								} else if (Max_Level === station.int) {
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

				ipcRenderer.send("report-Notification", report);

				document.getElementById("report-overview-number").innerText = TREM.Localization.getString(report.loc.startsWith("地震資訊") ? "Report_Title_Local" : (report.no % 1000 ? report.no : "Report_Title_Small"));
				document.getElementById("report-overview-location").innerText = report.loc;
				const time = new Date(new Date(report.time).toLocaleString("en-US", { hourCycle: "h23", timeZone: "Asia/Taipei" }));
				document.getElementById("report-overview-time").innerText = time.format("YYYY/MM/DD HH:mm:ss");
				document.getElementById("report-overview-latitude").innerText = report.lat;
				document.getElementById("report-overview-longitude").innerText = report.lon;

				if (report.loc.startsWith("地震資訊")) {
					document.getElementById("report-overview-intensity").parentElement.parentElement.style.display = "none";
				} else {
					document.getElementById("report-overview-intensity").parentElement.parentElement.style.display = "";
					const int = `${IntensityI(report.Max_Level)}`.split("");
					document.getElementById("report-overview-intensity").innerText = int[0];
					document.getElementById("report-overview-intensity").className = (int[1] == "+") ? "strong"
						: (int[1] == "-") ? "weak"
							: "";
				}

				document.getElementById("report-overview-intensity-location").innerText = (report.loc.startsWith("地震資訊")) ? "" : `${report.Max_Level_areaName} ${report.Max_Level_stationName}`;
				document.getElementById("report-overview-unit-magnitude").innerText = (report.loc.startsWith("地震資訊")) ? "d" : "L";
				document.getElementById("report-overview-magnitude").innerText = report.mag == 0 ? "0.0" : report.mag;
				document.getElementById("report-overview-depth").innerText = report.depth;

				document.getElementById("report-detail-copy").style.display = "";
				document.getElementById("report-detail-copy").value = report.id;

				this._updateDownloadButton(report);

				if (report.loc.startsWith("地震資訊")) {
					document.getElementById("report-cwb").style.display = "none";
					document.getElementById("report-scweb").style.display = "none";
				} else {
					document.getElementById("report-cwb").style.display = "";
					document.getElementById("report-scweb").style.display = "";

					const cwb_code = "EQ"
						+ report.no
						+ "-"
						+ (time.getMonth() + 1 < 10 ? "0" : "") + (time.getMonth() + 1)
						+ (time.getDate() < 10 ? "0" : "") + time.getDate()
						+ "-"
						+ (time.getHours() < 10 ? "0" : "") + time.getHours()
						+ (time.getMinutes() < 10 ? "0" : "") + time.getMinutes()
						+ (time.getSeconds() < 10 ? "0" : "") + time.getSeconds();
					document.getElementById("report-cwb").value = `https://www.cwa.gov.tw/V8/C/E/EQ/${cwb_code}.html`;

					const scweb_code = ""
						+ time.getFullYear()
						+ (time.getMonth() + 1 < 10 ? "0" : "") + (time.getMonth() + 1)
						+ (time.getDate() < 10 ? "0" : "") + time.getDate()
						+ (time.getHours() < 10 ? "0" : "") + time.getHours()
						+ (time.getMinutes() < 10 ? "0" : "") + time.getMinutes()
						+ (time.getSeconds() < 10 ? "0" : "") + time.getSeconds()
						+ (report.mag * 10)
						+ (report.no % 1000 ? report.no.toString().slice(-3) : "");
					document.getElementById("report-scweb").value = `https://scweb.cwa.gov.tw/zh-tw/earthquake/details/${scweb_code}`;
				}

				let Station_i = 0;
				this.report_station = {};

				if (Object.keys(report.list).length)
					for (let index = 0, keys = Object.keys(report.list), n = keys.length; index < n; index++)
						for (let station_index = 0, station_keys = Object.keys(report.list[keys[index]].town), o = station_keys.length; station_index < o; station_index++) {
							const station = report.list[keys[index]].town[station_keys[station_index]];
							const station_tooltip = `<div>測站地名: ${keys[index]} ${station_keys[station_index]}</div><div>距離震央: ${station.distance} km</div><div>震度: ${IntensityI(station.int)}</div>`;
							this.report_station[Station_i] = L.marker(
								[station.lat, station.lon],
								{
									icon: L.divIcon({
										iconSize  : [16, 16],
										className : `map-intensity-icon ${IntensityToClassString(station.int)}`,
									}),
									zIndexOffset: 200 + station.int,
								}).bindTooltip(station_tooltip, {
								offset    : [8, 0],
								permanent : false,
								className : "report-cursor-tooltip",
							});
							this._markers.push(this.report_station[Station_i]);
							Station_i += 1;
						}

				// console.log(this.report_station);
				this.epicenterIcon = null;
				this.epicenterIcon = L.marker(
					[report.lat, report.lon],
					{
						icon: L.divIcon({
							html      : TREM.Resources.icon.oldcross,
							iconSize  : [32, 32],
							className : "epicenterIcon",
						}),
						zIndexOffset: 5000,
					});
				this._markers.push(this.epicenterIcon);

				this.report_trem_data = this._report_trem_data;
				this.report_eew_data = this._report_eew_data;
				this._report_Temp = report;
				this._setuptremget(report);
				this._setupeewget(report);
			}
		}

		if (skip) {
			ReportTag = NOW().getTime();
			console.debug("ReportTag: ", ReportTag);
		}
	},
	_setupeewget(report) {
		// 舊的 eew-info API 已下線，只使用本機快取
		this._setupeewmarker(report);
	},
	_setupeewmarker(report) {
		if (this.report_eew_data[report.trem]) {
			const res = this.report_eew_data[report.trem];

			for (let i = 0; i < res.length; i++) {
				const eew = res[i].eq;
				const latlng = L.latLng(eew.lat, eew.lon);
				const latlng1 = L.latLng(report.lat, report.lon);
				const distance = latlng.distanceTo(latlng1);
				const eew_epicenterIcon = L.marker(
					[(eew.lat == report.lat && eew.lon == report.lon) ? eew.lat + 0.03 : eew.lat, eew.lon],
					{
						icon: L.divIcon({
							html      : TREM.Resources.icon.oldcross,
							iconSize  : [16, 16],
							className : "epicenterIcon",
						}),
						zIndexOffset: 5000,
					}).bindTooltip(`<div class="report_station_box">TREM EEW<div>報數: 第 ${i + 1} 報${res[i].final ? " (最終報)" : ""}</div><div>位置: ${eew.loc} | ${eew.lat}°N  ${eew.lon} °E</div><div>規模: M ${eew.mag}</div><div>深度: ${eew.depth} km</div><div>預估最大震度: ${IntensityI(eew.max)}</div><div>與CWA震央距: ${(distance / 1000).toFixed(2)} km</div></div>`, {
					offset    : [8, 0],
					permanent : false,
					className : "report-cursor-tooltip",
					opacity   : 1,
				});
				this._markers.push(eew_epicenterIcon);
				this._setupzoomPredict();
			}
		}
	},
	_setuptremget() {
		// TREM 自家報告的 API（trem/info、trem/report）已下線
		this._setupzoomPredict();
	},
	_setupzoomPredict() {
		this._markersGroup = L.featureGroup(this._markers).addTo(Maps.report);

		const zoomPredict = (Maps.report.getBoundsZoom(this._markersGroup.getBounds()) - Maps.report.getMinZoom()) / (Maps.report.getMaxZoom() * (1.5 ** (Maps.report.getBoundsZoom(this._markersGroup.getBounds()) - Maps.report.getMinZoom())));
		const offsetHeightPredict = (document.getElementById("map-report").offsetHeight * zoomPredict) + 50;
		this._focusMap(this._markersGroup.getBounds(), {
			paddingTopLeft     : [document.getElementById("map-report").offsetWidth / 2, offsetHeightPredict],
			paddingBottomRight : [document.getElementById("map-report").offsetWidth * zoomPredict, offsetHeightPredict],
		});
	},
	_setup_api_key_verify() {
		if (!this.api_key_verify) {
			const element = document.getElementById("report-label-filter-TREM");
			element.classList.add("hide");
			element.style.display = "none";
		} else if (this.api_key_verify) {
			const element = document.getElementById("report-label-filter-TREM");
			element.classList.remove("hide");
			element.style.display = "block";
		}
	},
};

TREM.on("viewChange", (oldView, newView) => {
	switch (oldView) {
		case "report": {
			TREM.Report.unloadReports();
			TREM.Report._setup_api_key_verify();
			break;
		}

		default:
			break;
	}

	switch (newView) {
		case "report": {
			TREM.Report.unloadReports();
			TREM.Report.loadReports();
			TREM.Report._focusMap();
			TREM.Report._setup_api_key_verify();

			if (TREM.Report.view != "report-overview" && TREM.Report._filterDateValue == "" && TREM.Report._filterMonthValue == "") {
				const input = document.getElementById("report-filter-month-value");
				const today = new Date();
				const mm = String(today.getMonth() + 1).padStart(2, "0");
				const yyyy = today.getFullYear();
				input.value = yyyy + "-" + mm;
				const checkbox = document.getElementById("report-filter-month");
				checkbox.checked = true;
				TREM.Report._handleFilter("filterMonthValue", input.value);
				TREM.Report._handleFilter("filterMonth", true);
			}


			break;
		}

		default:
			break;
	}
});