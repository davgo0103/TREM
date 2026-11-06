// geojson-vt 圖層：同一份 GeoJSON 用同樣的切片選項只建一次索引
//
// L.geoJson.vt 建立時會同步把整份 GeoJSON 切成索引。鄉鎮圖有 3.7 MB，每次要十幾到幾十 ms，
// 而速報每一報、震度圖每次更新都要用新的配色重畫鄉鎮圖；形狀不變，只有 style 變，索引可以共用。
const L = require("leaflet");
require("leaflet-geojson-vt");

const EMPTY = { type: "FeatureCollection", features: [] };

/** GeoJSON 物件 → (切片選項 → 索引) */
const indexes = new WeakMap();

// 只有這些選項會影響 geojson-vt 切出來的索引；style、zIndex 等是畫的時候才用
const indexKey = (options) => JSON.stringify([
	options.maxZoom,
	options.tolerance,
	options.buffer,
	options.extent,
	options.indexMaxZoom,
	options.indexMaxPoints,
]);

/**
 * 跟 L.geoJson.vt(geojson, options) 一樣，但重用已經建好的索引
 * @param {object} geojson
 * @param {object} options
 */
function vtLayer(geojson, options) {
	let byOptions = indexes.get(geojson);

	if (!byOptions) indexes.set(geojson, byOptions = new Map());

	const key = indexKey(options);
	const index = byOptions.get(key);

	if (!index) {
		const layer = L.geoJson.vt(geojson, options);
		byOptions.set(key, layer.tileIndex);
		return layer;
	}

	const layer = L.geoJson.vt(EMPTY, options);
	layer.tileIndex = index;
	return layer;
}

module.exports = vtLayer;
