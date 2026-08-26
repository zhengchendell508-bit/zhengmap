const DEFAULT_CENTER = [32.8599867, -97.0677587];


// 手机端防止快速连续点击触发浏览器双击放大。
// 只拦截地图空白处的第二次过快 touchend；不要拦截号码标记、弹窗、按钮和输入面板，
// 否则 iPhone/Android 上快速点小号码时，Leaflet 的 click 事件会被 preventDefault 吃掉，
// 导致“已送达 / 取消”有时不弹出。
(function preventMobileDoubleTapZoom() {
  let lastTouchEndTime = 0;

  function isInteractiveTouchTarget(target) {
    return !!(target && target.closest && target.closest([
      "button",
      "input",
      "select",
      "textarea",
      "a",
      ".leaflet-marker-icon",
      ".leaflet-popup",
      ".leaflet-control",
      ".number-marker",
      ".delivery-route-panel",
      ".delivery-action-popup",
      ".community-search-panel",
      ".community-suggestion-panel",
      ".mobile-mode-panel",
      ".settings-panel",
      ".building-panel",
      ".community-bar",
      ".top-toolbar",
      ".nav-controls"
    ].join(",")));
  }

  document.addEventListener(
    "touchend",
    function (event) {
      if (isInteractiveTouchTarget(event.target)) {
        lastTouchEndTime = 0;
        return;
      }

      const now = Date.now();
      if (now - lastTouchEndTime <= 320) {
        event.preventDefault();
      }
      lastTouchEndTime = now;
    },
    { passive: false }
  );

  document.addEventListener(
    "gesturestart",
    function (event) {
      event.preventDefault();
    },
    { passive: false }
  );
})();


const map = L.map("map", {
  rotate: true,
  touchRotate: true,
  bearing: 0,
  doubleClickZoom: false,
  zoomControl: false
}).setView(DEFAULT_CENTER, 18);

map.setMaxZoom(19);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap"
}).addTo(map);

let markerSize = 16;
let fontSize = 8;
let markerColor = "#1479e8";
let markerShape = "circle";
let rotation = 0;

let appData = {
  version: 3,
  activeCommunityId: null,
  communities: []
};

let renderedMarkers = [];
let selectedBuildingId = null;
let selectedPositions = new Set();
let displayMode = "communities";
let pendingLatLng = null;
let currentInput = "";
let myLocationMarker = null;
let myLatLng = null;
let myHeading = 0;
let locationWatchId = null;
let hasCenteredOnMyLocation = false;
let followHeading = false;
let headingReady = false;
let headingPermissionRequested = false;
let headingWatchdogTimer = null;
let bestAccuracySeen = Infinity;
let lastAcceptedAccuracy = null;
let communityInputPreviousValue = "";
let communitySearchCommunityId = null;
let communitySearchTargets = [];
let deliveryDeliveredKeys = new Set();
let deliveryCancelledKeys = new Set();
let deliveryPendingPanelOpen = false;
let deliveryDeliveredPanelOpen = false;
let deliveryLastHiddenTarget = null;
let deliveryLastHiddenType = "";
let deliveryToastTimer = null;
let communitySuggestionCloseTimer = null;
let pendingBuildingPhotoBuildingId = null;
let viewingBuildingPhotoBuildingId = null;
let pendingCommunityOfficePhotoCommunityId = null;
let viewingCommunityOfficePhotoCommunityId = null;

const ROUTES_API_KEY_STORAGE_KEY = "xunbaohuoRoutesApiKey";
const ROUTES_API_USAGE_STORAGE_KEY = "xunbaohuoRoutesApiUsageV1";
const ROUTES_API_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
const DELIVERY_ROUTE_MAX_OPTIMIZED_STOPS = 25;
const DELIVERY_ROUTE_CHUNK_POINT_LIMIT = 27; // origin + 25 intermediates + destination
let deliveryPlannedRouteLayer = null;
let deliveryWalkConnectorLayers = new Map();
let deliveryPlannedRouteStartLatLng = null;
let deliveryPlannedRouteOrderedKeys = [];
let deliveryPlannedRouteSignature = "";
let deliveryRoutePlanning = false;
let deliveryRouteLastDistanceMeters = 0;
let deliveryRouteLastDurationSeconds = 0;

function getStoredRoutesApiKey() {
  try {
    return String(localStorage.getItem(ROUTES_API_KEY_STORAGE_KEY) || "").trim();
  } catch (error) {
    return "";
  }
}

function saveStoredRoutesApiKey(value) {
  const key = String(value || "").trim();
  if (!key) return false;
  try {
    localStorage.setItem(ROUTES_API_KEY_STORAGE_KEY, key);
    return true;
  } catch (error) {
    return false;
  }
}

function getRoutesApiKeyFingerprint(key) {
  const text = String(key || "");
  if (!text) return "none";
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `k${(hash >>> 0).toString(16)}`;
}

function getRoutesApiUsageStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ROUTES_API_USAGE_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function saveRoutesApiUsageStore(store) {
  try {
    localStorage.setItem(ROUTES_API_USAGE_STORAGE_KEY, JSON.stringify(store || {}));
  } catch (error) {
    console.warn("保存 Routes API 本地计数失败：", error);
  }
}

function getLocalRoutesDateKeys() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return { monthKey: `${y}-${m}`, dayKey: `${y}-${m}-${d}` };
}

function normalizeRoutesApiUsageRecord(record) {
  const keys = getLocalRoutesDateKeys();
  const next = record && typeof record === "object" ? { ...record } : {};
  next.totalRequests = Number(next.totalRequests) || 0;
  next.successRequests = Number(next.successRequests) || 0;
  next.failedRequests = Number(next.failedRequests) || 0;
  if (next.monthKey !== keys.monthKey) {
    next.monthKey = keys.monthKey;
    next.monthRequests = 0;
  }
  if (next.dayKey !== keys.dayKey) {
    next.dayKey = keys.dayKey;
    next.dayRequests = 0;
  }
  next.monthRequests = Number(next.monthRequests) || 0;
  next.dayRequests = Number(next.dayRequests) || 0;
  return next;
}

function getCurrentRoutesApiUsage() {
  const key = getStoredRoutesApiKey();
  if (!key) return normalizeRoutesApiUsageRecord({});
  const store = getRoutesApiUsageStore();
  return normalizeRoutesApiUsageRecord(store[getRoutesApiKeyFingerprint(key)]);
}

function recordRoutesApiRequest(key, outcome = "attempt") {
  const text = String(key || "").trim();
  if (!text) return;
  const store = getRoutesApiUsageStore();
  const id = getRoutesApiKeyFingerprint(text);
  const record = normalizeRoutesApiUsageRecord(store[id]);
  if (outcome === "attempt") {
    record.totalRequests += 1;
    record.monthRequests += 1;
    record.dayRequests += 1;
    record.lastRequestAt = Date.now();
  } else if (outcome === "success") {
    record.successRequests += 1;
  } else if (outcome === "failed") {
    record.failedRequests += 1;
  }
  store[id] = record;
  saveRoutesApiUsageStore(store);
  updateRoutesApiMiniStatus();
}

function getRoutesApiMaskedKey() {
  const key = getStoredRoutesApiKey();
  if (!key) return "未设置";
  const tail = key.slice(-4);
  return `••••${tail}`;
}

function updateRoutesApiMiniStatus() {
  if (!routesApiUsageText || !routesApiKeyText) return;
  const key = getStoredRoutesApiKey();
  if (!key) {
    routesApiUsageText.innerText = "API：尚未设置";
    routesApiKeyText.innerText = "Key：未设置";
    return;
  }
  const usage = getCurrentRoutesApiUsage();
  const failedText = usage.failedRequests ? `｜失败 ${usage.failedRequests}` : "";
  routesApiUsageText.innerText = `API：本月 ${usage.monthRequests} 次｜今天 ${usage.dayRequests} 次${failedText}`;
  routesApiKeyText.innerText = `Key：${getRoutesApiMaskedKey()}`;
}

function changeRoutesApiKey() {
  const current = getStoredRoutesApiKey();
  const entered = prompt("输入新的 Google Routes API Key。\n只保存在当前设备浏览器，不会写进 GitHub 文件。", "");
  const next = String(entered || "").trim();
  if (!next || next === current) {
    updateRoutesApiMiniStatus();
    return;
  }
  saveStoredRoutesApiKey(next);
  updateRoutesApiMiniStatus();
  updateLocationStatus(`Routes API Key 已更换为 ${getRoutesApiMaskedKey()}`, "success");
}

function clearRoutesApiKey() {
  const current = getStoredRoutesApiKey();
  if (!current) return;
  if (!confirm(`确定清除当前 Routes API Key（${getRoutesApiMaskedKey()}）吗？\n本地请求计数会保留；以后重新填回同一把 Key 时仍可继续看到。`)) return;
  try {
    localStorage.removeItem(ROUTES_API_KEY_STORAGE_KEY);
  } catch (error) {}
  updateRoutesApiMiniStatus();
  updateLocationStatus("已清除当前 Routes API Key", "success");
}

function ensureRoutesApiKey() {
  const existing = getStoredRoutesApiKey();
  if (existing) return existing;
  const entered = prompt("请输入新的 Google Routes API Key。\n密钥只保存在当前设备浏览器的本地存储中，不会写进 GitHub 文件。", "");
  if (!entered || !String(entered).trim()) return "";
  const key = String(entered).trim();
  saveStoredRoutesApiKey(key);
  updateRoutesApiMiniStatus();
  return key;
}

function isDeliveryRouteLocked() {
  return deliveryRoutePlanning || deliveryPlannedRouteOrderedKeys.length > 0;
}

function blockRouteInterrupt(actionName = "进行其他操作") {
  if (!isDeliveryRouteLocked()) return false;
  alert(`本次送货路线正在使用中，不能${actionName}。\n\n请先点击“结束送货”，确认结束后才能退出本次路线。`);
  updateLocationStatus("送货路线已锁定；只有“结束送货”可以退出", "info");
  return true;
}

function clearDeliveryPlannedRoute(options = {}) {
  if (deliveryPlannedRouteLayer && map && map.hasLayer(deliveryPlannedRouteLayer)) {
    map.removeLayer(deliveryPlannedRouteLayer);
  }
  deliveryPlannedRouteLayer = null;
  deliveryWalkConnectorLayers = new Map();
  deliveryPlannedRouteOrderedKeys = [];
  deliveryPlannedRouteSignature = "";
  deliveryRouteLastDistanceMeters = 0;
  deliveryRouteLastDurationSeconds = 0;
  if (!options.keepStart) deliveryPlannedRouteStartLatLng = null;
  updateDeliveryRoutePlanStatus();
}

function updateDeliveryRoutePlanStatus(message = "") {
  if (!deliveryRoutePlanStatus) return;
  if (message) {
    deliveryRoutePlanStatus.innerText = message;
    return;
  }
  if (deliveryRoutePlanning) {
    deliveryRoutePlanStatus.innerText = "路线：正在规划...";
    return;
  }
  if (!deliveryPlannedRouteOrderedKeys.length) {
    deliveryRoutePlanStatus.innerText = "路线：尚未规划";
    return;
  }
  const km = deliveryRouteLastDistanceMeters > 0 ? (deliveryRouteLastDistanceMeters / 1000).toFixed(deliveryRouteLastDistanceMeters >= 10000 ? 1 : 2) : "";
  const min = deliveryRouteLastDurationSeconds > 0 ? Math.max(1, Math.round(deliveryRouteLastDurationSeconds / 60)) : 0;
  const extra = [km ? `${km} km` : "", min ? `约 ${min} 分钟` : ""].filter(Boolean).join(" · ");
  deliveryRoutePlanStatus.innerText = `路线：已规划 ${deliveryPlannedRouteOrderedKeys.length} 站${extra ? ` · ${extra}` : ""}`;
}

function getDeliveryRouteOrderIndex(target) {
  const key = getDeliveryTargetKey(target);
  const index = deliveryPlannedRouteOrderedKeys.indexOf(key);
  return index >= 0 ? index + 1 : 0;
}

function deliveryRouteTargetsSignature(targets) {
  return (Array.isArray(targets) ? targets : []).map(getDeliveryTargetKey).sort().join("|");
}

function haversineMeters(a, b) {
  const lat1 = Number(a?.lat ?? a?.[0]);
  const lng1 = Number(a?.lng ?? a?.[1]);
  const lat2 = Number(b?.lat ?? b?.[0]);
  const lng2 = Number(b?.lng ?? b?.[1]);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return Infinity;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * s2 * s2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function getTargetPoint(target) {
  const latlng = getDeliveryTargetLatLng(target);
  if (!latlng) return null;
  return { target, lat: Number(latlng.lat), lng: Number(latlng.lng) };
}

function buildLocalClosedLoopOrder(targets, startLatLng) {
  const remaining = (Array.isArray(targets) ? targets : []).map(getTargetPoint).filter(Boolean);
  if (!remaining.length) return [];
  const ordered = [];
  let current = { lat: Number(startLatLng.lat), lng: Number(startLatLng.lng) };
  while (remaining.length) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    remaining.forEach((point, index) => {
      const distance = haversineMeters(current, point);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    const [next] = remaining.splice(bestIndex, 1);
    ordered.push(next);
    current = next;
  }

  // 简单 2-opt：以起点=终点的闭环距离为目标，减少明显折返。
  const routeDistance = (points) => {
    if (!points.length) return 0;
    let total = haversineMeters(startLatLng, points[0]);
    for (let i = 1; i < points.length; i += 1) total += haversineMeters(points[i - 1], points[i]);
    total += haversineMeters(points[points.length - 1], startLatLng);
    return total;
  };
  let improved = true;
  let passes = 0;
  while (improved && passes < 4) {
    improved = false;
    passes += 1;
    const before = routeDistance(ordered);
    outer: for (let i = 0; i < ordered.length - 2; i += 1) {
      for (let j = i + 2; j < ordered.length; j += 1) {
        const candidate = ordered.slice();
        candidate.splice(i, j - i + 1, ...candidate.slice(i, j + 1).reverse());
        if (routeDistance(candidate) + 0.5 < before) {
          ordered.splice(0, ordered.length, ...candidate);
          improved = true;
          break outer;
        }
      }
    }
  }
  return ordered.map((point) => point.target);
}

function toRoutesWaypoint(lat, lng) {
  return {
    location: {
      latLng: {
        latitude: Number(lat),
        longitude: Number(lng)
      }
    }
  };
}

async function callGoogleComputeRoutes(apiKey, points, optimize = false) {
  if (!Array.isArray(points) || points.length < 2) throw new Error("路线点不足");
  const origin = points[0];
  const destination = points[points.length - 1];
  const intermediates = points.slice(1, -1);
  const body = {
    origin: toRoutesWaypoint(origin.lat, origin.lng),
    destination: toRoutesWaypoint(destination.lat, destination.lng),
    intermediates: intermediates.map((point) => toRoutesWaypoint(point.lat, point.lng)),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    polylineQuality: "HIGH_QUALITY",
    polylineEncoding: "ENCODED_POLYLINE"
  };
  if (optimize && intermediates.length > 1) body.optimizeWaypointOrder = true;

  const fieldMask = optimize
    ? "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.optimizedIntermediateWaypointIndex"
    : "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline";

  recordRoutesApiRequest(apiKey, "attempt");
  let response;
  try {
    response = await fetch(ROUTES_API_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": fieldMask
      },
      body: JSON.stringify(body)
    });
  } catch (networkError) {
    recordRoutesApiRequest(apiKey, "failed");
    throw networkError;
  }

  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    data = null;
  }
  if (!response.ok) {
    recordRoutesApiRequest(apiKey, "failed");
    const message = data?.error?.message || `Routes API 请求失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  recordRoutesApiRequest(apiKey, "success");
  const route = data?.routes?.[0];
  if (!route?.polyline?.encodedPolyline) throw new Error("Google 没有返回可显示的路线");
  return route;
}

function decodeGooglePolyline(encoded) {
  const coordinates = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte = null;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    const dLat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dLat;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    const dLng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dLng;
    coordinates.push([lat / 1e5, lng / 1e5]);
  }
  return coordinates;
}

function projectPointToRouteSegment(target, a, b) {
  const lat0 = Number(target.lat) * Math.PI / 180;
  const cosLat = Math.max(0.2, Math.cos(lat0));
  const tx = Number(target.lng) * cosLat;
  const ty = Number(target.lat);
  const ax = Number(a[1]) * cosLat;
  const ay = Number(a[0]);
  const bx = Number(b[1]) * cosLat;
  const by = Number(b[0]);
  const dx = bx - ax;
  const dy = by - ay;
  const denom = dx * dx + dy * dy;
  let t = denom > 0 ? ((tx - ax) * dx + (ty - ay) * dy) / denom : 0;
  t = Math.max(0, Math.min(1, t));
  return {
    lat: ay + (by - ay) * t,
    lng: (ax + (bx - ax) * t) / cosLat
  };
}

function findNearestPointOnRoute(targetLatLng, routeGroups) {
  const target = { lat: Number(targetLatLng.lat), lng: Number(targetLatLng.lng) };
  let nearest = null;
  let nearestDistance = Infinity;
  (routeGroups || []).forEach((points) => {
    for (let i = 1; i < points.length; i += 1) {
      const candidate = projectPointToRouteSegment(target, points[i - 1], points[i]);
      const distance = haversineMeters(target, candidate);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = candidate;
      }
    }
  });
  return nearest ? { ...nearest, distanceMeters: nearestDistance } : null;
}

function renderDeliveryPlannedRoute(encodedPolylines, orderedTargets = []) {
  if (deliveryPlannedRouteLayer && map && map.hasLayer(deliveryPlannedRouteLayer)) map.removeLayer(deliveryPlannedRouteLayer);
  deliveryWalkConnectorLayers = new Map();
  const groups = (Array.isArray(encodedPolylines) ? encodedPolylines : []).map(decodeGooglePolyline).filter((points) => points.length > 1);
  if (!groups.length) {
    deliveryPlannedRouteLayer = null;
    return;
  }

  const layers = groups.map((points) => L.polyline(points, {
    weight: 6,
    opacity: 0.86,
    lineCap: "round",
    lineJoin: "round"
  }));

  // Google 的蓝色实线只代表可驾驶道路；每个号码仍以用户在地图上放置的精确坐标为准。
  // 本地从驾驶路线最近点到号码精确位置补一条“黑色细虚点线”，只作为最后接驳方向提示，
  // 不额外请求 Google WALK API，也不表示真实的人行道路。
  (Array.isArray(orderedTargets) ? orderedTargets : []).forEach((target) => {
    const targetLatLng = getDeliveryTargetLatLng(target);
    if (!targetLatLng) return;
    const nearest = findNearestPointOnRoute(targetLatLng, groups);
    if (!nearest || !Number.isFinite(nearest.distanceMeters)) return;

    // 几乎与驾驶线完全重合时没有可见接驳段，避免生成零长度折线。
    if (nearest.distanceMeters < 0.5) return;

    const connectorLayer = L.polyline([
      [nearest.lat, nearest.lng],
      [Number(targetLatLng.lat), Number(targetLatLng.lng)]
    ], {
      color: "#111111",
      weight: 2,
      opacity: 0.82,
      dashArray: "1 6",
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
      className: "delivery-walk-connector"
    });
    const targetKey = getDeliveryTargetKey(target);
    if (targetKey) deliveryWalkConnectorLayers.set(targetKey, connectorLayer);
    if (!deliveryDeliveredKeys.has(targetKey) && !deliveryCancelledKeys.has(targetKey)) {
      layers.push(connectorLayer);
    }
  });

  deliveryPlannedRouteLayer = L.layerGroup(layers).addTo(map);
}

function syncDeliveryWalkConnectorLayers() {
  if (!deliveryPlannedRouteLayer || !deliveryWalkConnectorLayers.size) return;
  deliveryWalkConnectorLayers.forEach((layer, key) => {
    const shouldShow = !deliveryDeliveredKeys.has(key) && !deliveryCancelledKeys.has(key);
    const isShown = deliveryPlannedRouteLayer.hasLayer(layer);
    if (shouldShow && !isShown) deliveryPlannedRouteLayer.addLayer(layer);
    if (!shouldShow && isShown) deliveryPlannedRouteLayer.removeLayer(layer);
  });
}

function makeRoutePointFromTarget(target) {
  const latlng = getDeliveryTargetLatLng(target);
  if (!latlng) return null;
  return { lat: Number(latlng.lat), lng: Number(latlng.lng), target };
}

function splitRoutePointsIntoChunks(points) {
  const chunks = [];
  if (!Array.isArray(points) || points.length < 2) return chunks;
  let startIndex = 0;
  while (startIndex < points.length - 1) {
    const endIndex = Math.min(points.length - 1, startIndex + DELIVERY_ROUTE_CHUNK_POINT_LIMIT - 1);
    chunks.push(points.slice(startIndex, endIndex + 1));
    if (endIndex >= points.length - 1) break;
    startIndex = endIndex;
  }
  return chunks;
}

async function planDeliveryRoute(options = {}) {
  if (deliveryRoutePlanning) return;
  const pendingTargets = getDeliveryPendingTargets();
  if (!pendingTargets.length) {
    alert("本次没有待送号码，暂时不需要规划路线。");
    return;
  }
  if (!myLatLng && !deliveryPlannedRouteStartLatLng) {
    alert("还没有取得手机当前位置。请先点右下角定位/指南针按钮，等蓝点出现后再规划路线。");
    return;
  }
  const apiKey = ensureRoutesApiKey();
  if (!apiKey) return;

  const startLatLng = deliveryPlannedRouteStartLatLng || L.latLng(Number(myLatLng[0]), Number(myLatLng[1]));
  if (!deliveryPlannedRouteStartLatLng) deliveryPlannedRouteStartLatLng = L.latLng(startLatLng.lat, startLatLng.lng);

  deliveryRoutePlanning = true;
  updateDeliveryRoutePlanStatus();
  if (planDeliveryRouteBtn) planDeliveryRouteBtn.disabled = true;

  try {
    let orderedTargets = [];
    const encodedPolylines = [];
    let distanceMeters = 0;
    let durationSeconds = 0;

    if (pendingTargets.length <= DELIVERY_ROUTE_MAX_OPTIMIZED_STOPS) {
      const validTargetPoints = pendingTargets.map(makeRoutePointFromTarget).filter(Boolean);
      const validTargets = validTargetPoints.map((point) => point.target);
      const points = [
        { lat: startLatLng.lat, lng: startLatLng.lng },
        ...validTargetPoints,
        { lat: startLatLng.lat, lng: startLatLng.lng }
      ];
      if (points.length < 3) throw new Error("没有足够的有效号码坐标");
      const route = await callGoogleComputeRoutes(apiKey, points, true);
      const indexes = Array.isArray(route.optimizedIntermediateWaypointIndex) ? route.optimizedIntermediateWaypointIndex : [];
      orderedTargets = indexes.length === validTargets.length ? indexes.map((index) => validTargets[index]).filter(Boolean) : validTargets.slice();
      encodedPolylines.push(route.polyline.encodedPolyline);
      distanceMeters += Number(route.distanceMeters) || 0;
      durationSeconds += parseFloat(String(route.duration || "0").replace(/s$/, "")) || 0;
    } else {
      orderedTargets = buildLocalClosedLoopOrder(pendingTargets, startLatLng);
      const routePoints = [
        { lat: startLatLng.lat, lng: startLatLng.lng },
        ...orderedTargets.map(makeRoutePointFromTarget).filter(Boolean),
        { lat: startLatLng.lat, lng: startLatLng.lng }
      ];
      for (const chunk of splitRoutePointsIntoChunks(routePoints)) {
        const route = await callGoogleComputeRoutes(apiKey, chunk, false);
        encodedPolylines.push(route.polyline.encodedPolyline);
        distanceMeters += Number(route.distanceMeters) || 0;
        durationSeconds += parseFloat(String(route.duration || "0").replace(/s$/, "")) || 0;
      }
    }

    deliveryPlannedRouteOrderedKeys = orderedTargets.map(getDeliveryTargetKey);
    deliveryPlannedRouteSignature = deliveryRouteTargetsSignature(pendingTargets);
    deliveryRouteLastDistanceMeters = distanceMeters;
    deliveryRouteLastDurationSeconds = durationSeconds;
    renderDeliveryPlannedRoute(encodedPolylines, orderedTargets);
    renderDeliveryRoutePanel();
    updateDeliveryRoutePlanStatus();

    const routePoints = [deliveryPlannedRouteStartLatLng];
    orderedTargets.forEach((target) => {
      const point = getDeliveryTargetLatLng(target);
      if (point) routePoints.push(point);
    });
    routePoints.push(deliveryPlannedRouteStartLatLng);
    if (routePoints.length > 2) {
      const bounds = L.latLngBounds(routePoints);
      if (bounds.isValid()) map.fitBounds(bounds, { paddingTopLeft: [30, 110], paddingBottomRight: [90, 150], maxZoom: 19, animate: true });
    }

    if (pendingTargets.length > DELIVERY_ROUTE_MAX_OPTIMIZED_STOPS) {
      updateLocationStatus(`已规划 ${orderedTargets.length} 个号码的闭环路线。号码超过 ${DELIVERY_ROUTE_MAX_OPTIMIZED_STOPS} 个，本次先按地图位置优化顺序，再由 Google 绘制道路路线。`, "success");
    } else {
      updateLocationStatus(`已规划 ${orderedTargets.length} 个号码的闭环路线。偏离路线不会自动重算。`, "success");
    }

    // 只有真正成功画出路线后才自动收起“本次号码”大窗口；失败时保持打开方便查看错误。
    deliveryPendingPanelOpen = false;
    deliveryDeliveredPanelOpen = false;
    renderDeliveryRoutePanel();
  } catch (error) {
    console.error("路线规划失败：", error);
    updateDeliveryRoutePlanStatus(`路线：规划失败 · ${error.message || "未知错误"}`);
    alert(`路线规划失败：${error.message || "未知错误"}\n\n如果提示 API key / referrer / CORS，请把错误截图发给我。`);
  } finally {
    deliveryRoutePlanning = false;
    if (planDeliveryRouteBtn) planDeliveryRouteBtn.disabled = false;
    if (deliveryPlannedRouteOrderedKeys.length) updateDeliveryRoutePlanStatus();
  }
}

function replanDeliveryRouteOnlyForNewTargets() {
  if (!deliveryPlannedRouteStartLatLng || !deliveryPlannedRouteOrderedKeys.length) return;
  const pendingTargets = getDeliveryPendingTargets();
  const nextSignature = deliveryRouteTargetsSignature(pendingTargets);
  if (nextSignature === deliveryPlannedRouteSignature) return;
  // 唯一自动重算条件：本次清单真正新增了号码。起终点仍保持第一次规划时的位置。
  planDeliveryRoute({ reason: "new-target" });
}

function finishCurrentDeliveryRoute() {
  if (!confirm("确定结束本次送货吗？\n路线和本次号码清单会收起；公寓地图资料不会删除。")) return;
  clearDeliveryPlannedRoute();
  showCommunityBuildingsOnly();
  updateLocationStatus("本次送货已结束", "success");
}


const historyStack = [];
const MAX_HISTORY = 50;
const GOOD_ACCURACY = 20;
const MAX_ACCEPTABLE_ACCURACY = 60;
const ACCURACY_DOWNGRADE_TOLERANCE = 20;

const DESKTOP_DEFAULT_MARKER_SIZE = 16;
const DESKTOP_DEFAULT_FONT_SIZE = 8;
const MOBILE_DEFAULT_MARKER_SIZE = 22;
const MOBILE_DEFAULT_FONT_SIZE = 11;
const MARKER_SIZE_MIN = 15;
const MARKER_SIZE_MAX = 25;
const FONT_SIZE_MIN = 5;
const FONT_SIZE_MAX = 15;

const locationStatus = document.getElementById("locationStatus");
const headingText = document.getElementById("headingText");
const mobileStatusText = document.getElementById("mobileStatusText");
const mobileStatusBadge = document.getElementById("mobileStatusBadge");
const navButton = document.getElementById("navButton");
const addHereBtn = document.getElementById("addHereBtn");
const settingsPanel = document.getElementById("settingsPanel");
const buildingPanel = document.getElementById("buildingPanel");
const buildingPanelTitle = document.getElementById("buildingPanelTitle");
const buildingPanelHint = document.getElementById("buildingPanelHint");
const positionList = document.getElementById("positionList");
const addBuildingPhotoBtn = document.getElementById("addBuildingPhotoBtn");
const buildingPhotoInput = document.getElementById("buildingPhotoInput");
const buildingPhotoViewer = document.getElementById("buildingPhotoViewer");
const buildingPhotoViewerTitle = document.getElementById("buildingPhotoViewerTitle");
const buildingPhotoViewerImage = document.getElementById("buildingPhotoViewerImage");
const closeBuildingPhotoViewerBtn = document.getElementById("closeBuildingPhotoViewer");
const replaceBuildingPhotoBtn = document.getElementById("replaceBuildingPhotoBtn");
const deleteBuildingPhotoBtn = document.getElementById("deleteBuildingPhotoBtn");
const communitySelect = document.getElementById("communitySelect");
const communityDropdownBtn = document.getElementById("communityDropdownBtn");
const communityOptions = document.getElementById("communityOptions");
const communitySuggestionPanel = document.getElementById("communitySuggestionPanel");
const addCommunityBtn = document.getElementById("addCommunityBtn");
const renameCommunityBtn = document.getElementById("renameCommunityBtn");
const communitySearchPanel = document.getElementById("communitySearchPanel");
const communitySearchTitle = document.getElementById("communitySearchTitle");
const communitySearchHint = document.getElementById("communitySearchHint");
const communityNumberSearchInput = document.getElementById("communityNumberSearchInput");
const communitySearchKeypad = document.getElementById("communitySearchKeypad");
const universalNumberPanel = document.getElementById("universalNumberPanel");
const universalNumberTitle = document.getElementById("universalNumberTitle");
const universalBuildingInput = document.getElementById("universalBuildingInput");
const universalFloorInput = document.getElementById("universalFloorInput");
const universalUnitGroups = document.getElementById("universalUnitGroups");
const addUniversalUnitGroupBtn = document.getElementById("addUniversalUnitGroupBtn");
const universalPreview = document.getElementById("universalPreview");
const closeUniversalNumberPanelBtn = document.getElementById("closeUniversalNumberPanel");
const confirmUniversalNumberBtn = document.getElementById("confirmUniversalNumber");
const cancelUniversalNumberBtn = document.getElementById("cancelUniversalNumber");
const mobileModePanel = document.getElementById("mobileModePanel");
const closeMobileModePanelBtn = document.getElementById("closeMobileModePanel");
const mobileModeStatusText = document.getElementById("mobileModeStatusText");
const mobileToggleEditModeBtn = document.getElementById("mobileToggleEditModeBtn");
const mobileImportJsonBtn = document.getElementById("mobileImportJsonBtn");
const mobileExportJsonBtn = document.getElementById("mobileExportJsonBtn");
const mobileOpenSettingsBtn = document.getElementById("mobileOpenSettingsBtn");
const cloudSyncStatus = document.getElementById("cloudSyncStatus");
let mobileEditMode = localStorage.getItem("mobileEditMode") === "1";

function isMobileKeypadOnlyMode() {
  return window.matchMedia && window.matchMedia("(max-width: 700px), (pointer: coarse)").matches;
}

function canEditMapMarkers() {
  // 电脑端永远是编辑管理；手机端默认送包裹，只有手动进入编辑模式才允许拖动/修改。
  return !isMobileKeypadOnlyMode() || mobileEditMode;
}

function applyMobileModeUi() {
  document.body.classList.toggle("mobile-edit-mode", mobileEditMode);
  document.body.classList.toggle("mobile-delivery-mode", !mobileEditMode);
  if (mobileModeStatusText) mobileModeStatusText.innerText = mobileEditMode ? "当前：编辑模式" : "当前：送包裹模式";
  if (mobileToggleEditModeBtn) mobileToggleEditModeBtn.innerText = mobileEditMode ? "退出编辑模式" : "进入编辑模式";
  if (mobileEditMode) updateLocationStatus("手机端编辑模式已开启：可以新增、拖动和修改标记", "warning");
}

function toggleMobileEditMode() {
  mobileEditMode = !mobileEditMode;
  localStorage.setItem("mobileEditMode", mobileEditMode ? "1" : "0");
  applyMobileModeUi();
  closeMobileModePanel();
  renderMap();
  updateLocationStatus(mobileEditMode ? "已进入编辑模式：小心不要误移动标记" : "已回到送包裹模式：标记已锁定", mobileEditMode ? "warning" : "success");
}

function openMobileModePanel() {
  if (!mobileModePanel) return;
  applyMobileModeUi();
  mobileModePanel.classList.add("is-open");
}

function closeMobileModePanel() {
  if (!mobileModePanel) return;
  mobileModePanel.classList.remove("is-open");
}

function configureMobileSearchInputKeyboard() {
  if (!communityNumberSearchInput) return;
  if (isMobileKeypadOnlyMode()) {
    communityNumberSearchInput.readOnly = true;
    communityNumberSearchInput.setAttribute("inputmode", "none");
    communityNumberSearchInput.setAttribute("aria-readonly", "true");
  } else {
    communityNumberSearchInput.readOnly = false;
    communityNumberSearchInput.setAttribute("inputmode", "text");
    communityNumberSearchInput.removeAttribute("aria-readonly");
  }
}

function clampMarkerSizeValue(value, fallback = DESKTOP_DEFAULT_MARKER_SIZE) {
  const number = parseInt(value, 10);
  return Math.min(MARKER_SIZE_MAX, Math.max(MARKER_SIZE_MIN, Number.isFinite(number) ? number : fallback));
}

function clampFontSizeValue(value, fallback = DESKTOP_DEFAULT_FONT_SIZE) {
  const number = parseInt(value, 10);
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Number.isFinite(number) ? number : fallback));
}

function applyMobileReadableMarkerDefaults() {
  // 手机端屏幕较小，默认新建公寓号码要更大；电脑端仍保持原来的默认大小。
  if (!isMobileKeypadOnlyMode()) return;
  if (markerSize <= DESKTOP_DEFAULT_MARKER_SIZE) markerSize = MOBILE_DEFAULT_MARKER_SIZE;
  if (fontSize <= DESKTOP_DEFAULT_FONT_SIZE) fontSize = MOBILE_DEFAULT_FONT_SIZE;
}
const closeCommunitySearchPanelBtn = document.getElementById("closeCommunitySearchPanel");
const confirmCommunityNumberSearchBtn = document.getElementById("confirmCommunityNumberSearch");
const showAllCommunityNumbersBtn = document.getElementById("showAllCommunityNumbers");
const showCommunityBuildingsOnlyBtn = document.getElementById("showCommunityBuildingsOnly");
const deliveryRoutePanel = document.getElementById("deliveryRoutePanel");
const togglePendingRouteListBtn = document.getElementById("togglePendingRouteList");
const closePendingRoutePanelBtn = document.getElementById("closePendingRoutePanelBtn");
const toggleDeliveredRouteListBtn = document.getElementById("toggleDeliveredRouteList");
const pendingRouteListPanel = document.getElementById("pendingRouteListPanel");
const deliveredRouteListPanel = document.getElementById("deliveredRouteListPanel");
const pendingRouteList = document.getElementById("pendingRouteList");
const deliveredRouteList = document.getElementById("deliveredRouteList");
const pendingRouteCount = document.getElementById("pendingRouteCount");
const deliveredRouteCount = document.getElementById("deliveredRouteCount");
const pendingRouteToggleCount = document.getElementById("pendingRouteToggleCount");
const deliveredRouteToggleCount = document.getElementById("deliveredRouteToggleCount");
const addDeliveryRouteNumberBtn = document.getElementById("addDeliveryRouteNumberBtn");
const planDeliveryRouteBtn = document.getElementById("planDeliveryRouteBtn");
const endDeliveryRouteBtn = document.getElementById("endDeliveryRouteBtn");
const deliveryRoutePlanStatus = document.getElementById("deliveryRoutePlanStatus");
const routesApiMiniStatus = document.getElementById("routesApiMiniStatus");
const routesApiUsageText = document.getElementById("routesApiUsageText");
const routesApiKeyText = document.getElementById("routesApiKeyText");
const changeRoutesApiKeyBtn = document.getElementById("changeRoutesApiKeyBtn");
const clearRoutesApiKeyBtn = document.getElementById("clearRoutesApiKeyBtn");
const pendingRouteEmptyState = document.getElementById("pendingRouteEmptyState");
const finishDeliveryRouteBtn = document.getElementById("finishDeliveryRouteBtn");
const deliveryToast = document.getElementById("deliveryToast");
const deliveryToastText = document.getElementById("deliveryToastText");
const undoDeliveryHideBtn = document.getElementById("undoDeliveryHideBtn");
const closeDeliveryToastBtn = document.getElementById("closeDeliveryToastBtn");

function updateLocationStatus(message, tone = "info") {
  locationStatus.innerText = message;
  locationStatus.className = "status-pill";
  if (tone !== "info") locationStatus.classList.add(tone);
}

function updateMobileStatus(message, badge = "待定位") {
  mobileStatusText.innerText = message;
  mobileStatusBadge.innerText = badge;
}

function normalizeHeading(value) {
  const normalized = value % 360;
  return normalized >= 0 ? normalized : normalized + 360;
}

function getHeadingLabel(heading) {
  if (heading === null || Number.isNaN(heading)) return "未知";
  const directions = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
  return directions[Math.round(normalizeHeading(heading) / 45) % directions.length];
}

function getMapBearing() {
  return typeof map.getBearing === "function" ? map.getBearing() || 0 : 0;
}

function setMapBearing(value) {
  rotation = normalizeHeading(value);
  if (typeof map.setBearing === "function") map.setBearing(rotation);
  navButton.style.setProperty("--bearing", `${normalizeHeading(42 - rotation)}deg`);
  updateMyLocationMarkerHeading();
}

function getDisplayHeading() {
  return normalizeHeading(myHeading - getMapBearing());
}

function updateHeadingText() {
  headingText.innerText = `方向: ${getHeadingLabel(myHeading)} ${Math.round(normalizeHeading(myHeading))}°`;
}

function getContrastTextColor(bgColor) {
  const hex = String(bgColor).replace("#", "");
  if (hex.length !== 6) return "#000000";
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness < 150 ? "#ffffff" : "#000000";
}

function createNumberIcon(number, size, font, color, shape, extraClass = "", photoThumbDataUrl = "") {
  const numberText = String(number ?? "").trim();
  const isLongApartmentNumber = /^\d{4,}$/.test(numberText);
  const isRangeLabel = /^\d+\s*-\s*\d+$/.test(numberText);
  const effectiveShape = (isLongApartmentNumber || isRangeLabel || numberText.length > 3) ? "rectangle" : shape;

  let borderRadius = "50%";
  if (effectiveShape === "square") borderRadius = "10px";
  if (effectiveShape === "rectangle") borderRadius = "12px";

  const realWidth = effectiveShape === "rectangle"
    ? Math.max(size * 1.9, numberText.length * Math.max(font * 0.72, 5.8) + 12)
    : size;
  const textColor = getContrastTextColor(color);
  const photoBadgeHtml = photoThumbDataUrl
    ? `<img class="number-photo-badge" src="${escapeHtml(photoThumbDataUrl)}" alt="已有照片">`
    : "";

  return L.divIcon({
    className: "",
    html: `
      <div class="number-marker ${extraClass}"
        style="
          width:${realWidth}px;
          height:${size}px;
          font-size:${font}px;
          background:${color};
          color:${textColor};
          border:0;
          border-radius:${borderRadius};
        ">
        ${number}
        ${photoBadgeHtml}
      </div>
    `,
    iconSize: [realWidth, size],
    iconAnchor: [realWidth / 2, size / 2]
  });
}


function compactNumberRange(values) {
  const numbers = (Array.isArray(values) ? values : [])
    .map((value) => String(value).trim())
    .filter((value) => /^\d+$/.test(value))
    .sort((a, b) => Number(a) - Number(b));

  if (numbers.length === 0) return "";
  if (numbers.length === 1) return numbers[0];
  return `${numbers[0]}-${numbers[numbers.length - 1]}`;
}

function splitGroupDisplayLine(line) {
  const text = String(line || "").trim();
  if (!text) return [];
  const numbers = expandNumberInput(text);
  const rangeMatch = text.match(/^\s*\d+\s*(?:[-－—~～]|到)\s*\d+\s*$/);
  if (rangeMatch && numbers.length) {
    const parts = text.match(/(\d+)\s*(?:[-－—~～]|到)\s*(\d+)/);
    if (parts) {
      const width = Math.max(parts[1].length, parts[2].length);
      const startPadded = String(Number(parts[1])).padStart(width, "0");
      const endPadded = String(Number(parts[2])).padStart(width, "0");
      if (width >= 3 && startPadded[0] !== endPadded[0]) {
        const floorLines = groupNumbersByFloorRange(numbers);
        if (floorLines.length) return floorLines;
      }
    }
  }
  return [text];
}

function getGroupDisplayLines(building) {
  // 楼组标记要按照当前实际存在的号码显示。
  // 例如只剩 303、304 时，应显示 303-304，而不是沿用旧的 301-304。
  const numericPositions = (building.positions || [])
    .map((item) => String(item.position || "").trim())
    .filter((value) => /^\d+$/.test(value));

  const floorLines = groupNumbersByFloorRange(numericPositions);
  if (floorLines.length) return floorLines.slice(0, 8);

  if (Array.isArray(building.groupDisplayLines) && building.groupDisplayLines.length) {
    return building.groupDisplayLines
      .flatMap((line) => splitGroupDisplayLine(line))
      .filter(Boolean)
      .slice(0, 8);
  }

  return [String(building.name || "楼组")];
}

function refreshGroupBuildingDisplay(building) {
  if (!building) return;
  const numericPositions = (building.positions || [])
    .map((item) => String(item.position || "").trim())
    .filter((value) => /^\d+$/.test(value));

  if (!numericPositions.length) return;
  const lines = groupNumbersByFloorRange(numericPositions);
  if (!lines.length) return;
  building.groupDisplayLines = lines;
  building.name = lines.join(" / ");
}

function createGroupIcon(building, size, font, color) {
  const lines = getGroupDisplayLines(building);
  const textColor = "#ffffff";
  const compactFont = Math.max(8, Math.min(font, 9));
  const maxTextLength = Math.max(...lines.map((line) => line.length), 4);
  const width = Math.max(48, Math.min(68, maxTextLength * Math.max(compactFont * 0.42, 4.8) + 10));
  const lineHeight = Math.max(compactFont, 9);
  const height = Math.max(28, lines.length * lineHeight + 6);

  return L.divIcon({
    className: "",
    html: `
      <div class="number-marker group-marker"
        style="
          width:${width}px;
          height:${height}px;
          font-size:${compactFont}px;
          background:${color};
          color:${textColor};
          border:0;
          border-radius:7px;
        ">
        ${lines.map((line) => `<span>${line}</span>`).join("")}
      </div>
    `,
    iconSize: [width, height],
    iconAnchor: [width / 2, height / 2]
  });
}

function parseApartmentNumber(value) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;

  if (text.length === 3) {
    return {
      original: text,
      building: text.slice(0, 1),
      ignoredFloor: text.slice(1, 2),
      position: text.slice(2)
    };
  }

  if (text.length === 4) {
    return {
      original: text,
      building: text.slice(0, 2),
      ignoredFloor: text.slice(2, -2),
      position: text.slice(-2)
    };
  }

  return null;
}
function parseTwoFloorSuffixNumber(value) {
  const text = String(value).trim();
  if (!/^\d{3,4}$/.test(text)) return null;

  const floor = text[0];
  if (floor !== "1" && floor !== "2") return null;

  const room = String(Number(text.slice(-2)));
  return {
    original: text,
    building: room,
    ignoredFloor: floor,
    position: floor,
    floorLabel: `${floor}楼`,
    isTwoFloorSuffix: true
  };
}

function parseNumberByCommunity(value, community) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;

  if (community?.type === "flat") {
    return {
      original: text,
      building: "独立编号",
      ignoredFloor: "",
      position: text,
      isFlat: true
    };
  }

  if (community?.type === "twofloor_suffix") {
    return parseTwoFloorSuffixNumber(text);
  }

  if (community?.type === "group_full") {
    return {
      original: text,
      building: text,
      ignoredFloor: "",
      position: text,
      isGroupFullSingle: true
    };
  }

  return parseApartmentNumber(text);
}

function isFlatCommunity(community = getActiveCommunity()) {
  return community?.type === "flat";
}

function isTwoFloorSuffixCommunity(community = getActiveCommunity()) {
  return community?.type === "twofloor_suffix";
}

function isGroupFullCommunity(community = getActiveCommunity()) {
  return community?.type === "group_full";
}

function normalizeCommunityType(type) {
  const value = String(type || "").trim().toLowerCase();
  const aliases = {
    building: "universal",
    universal: "universal",
    flat: "flat",
    twofloor_suffix: "twofloor_suffix",
    group_full: "group_full"
  };
  return aliases[value] || "universal";
}


function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createCommunity(name, type = "building", latlng = null) {
  const center = latlng || (map && typeof map.getCenter === "function" ? map.getCenter() : { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1] });
  const community = {
    id: makeId("community"),
    name: String(name || "").trim() || "未命名公寓",
    type: normalizeCommunityType(type),
    createdAt: new Date().toISOString(),
    lat: Number(center.lat),
    lng: Number(center.lng),
    buildings: []
  };
  appData.communities.push(community);
  appData.activeCommunityId = community.id;
  return community;
}

function getActiveCommunity() {
  if (!Array.isArray(appData.communities)) appData.communities = [];

  let community = appData.communities.find((item) => item.id === appData.activeCommunityId);

  if (!community && appData.communities.length > 0) {
    community = appData.communities[0];
    appData.activeCommunityId = community.id;
  }

  return community || null;
}

function ensureActiveCommunity() {
  let community = getActiveCommunity();
  if (community) return community;

  community = createCommunity("默认公寓");
  saveData();
  renderCommunitySelector();
  return community;
}

function getSortedCommunities() {
  if (!Array.isArray(appData.communities)) return [];
  return [...appData.communities].sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN", { numeric: true }));
}

function getCommunityCardLatLng(community) {
  if (Number.isFinite(Number(community?.lat)) && Number.isFinite(Number(community?.lng))) {
    return [Number(community.lat), Number(community.lng)];
  }
  return getCommunityCenterLatLng(community) || DEFAULT_CENTER;
}

function getCommunityBuildingCount(community) {
  return Array.isArray(community?.buildings) ? community.buildings.length : 0;
}

function getCommunityNumberCount(community) {
  return (Array.isArray(community?.buildings) ? community.buildings : [])
    .reduce((sum, building) => sum + (Array.isArray(building.positions) ? building.positions.length : 0), 0);
}

function createCommunityCardIcon(community) {
  const typeText = getCommunityTypeLabel(community?.type);
  const buildingCount = getCommunityBuildingCount(community);
  const numberCount = getCommunityNumberCount(community);
  const title = String(community?.name || "未命名公寓");
  const safeTitle = title.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

  return L.divIcon({
    className: "",
    html: `
      <div class="community-card-marker">
        <strong>${safeTitle}</strong>
        <span>${typeText} · ${buildingCount} 栋 / ${numberCount} 号</span>
        <small>${isMobileKeypadOnlyMode() && mobileEditMode ? "点击管理办公室照片" : "点击查找号码"}</small>
      </div>
    `,
    iconSize: [154, 64],
    iconAnchor: [77, 32]
  });
}

function getCommunityCenterLatLng(community) {
  const buildings = Array.isArray(community?.buildings) ? community.buildings : [];
  const points = [];

  buildings.forEach((building) => {
    if (Number.isFinite(Number(building.lat)) && Number.isFinite(Number(building.lng))) {
      points.push([Number(building.lat), Number(building.lng)]);
    }
    (Array.isArray(building.positions) ? building.positions : []).forEach((position) => {
      if (Number.isFinite(Number(position.lat)) && Number.isFinite(Number(position.lng))) {
        points.push([Number(position.lat), Number(position.lng)]);
      }
    });
  });

  if (points.length === 0) return null;
  const sum = points.reduce((total, point) => ({ lat: total.lat + point[0], lng: total.lng + point[1] }), { lat: 0, lng: 0 });
  return [sum.lat / points.length, sum.lng / points.length];
}

function getReferenceLatLngForCommunityList() {
  if (Array.isArray(myLatLng) && myLatLng.length === 2) return myLatLng;
  if (map && typeof map.getCenter === "function") {
    const center = map.getCenter();
    return [center.lat, center.lng];
  }
  return DEFAULT_CENTER;
}

function getDistanceMeters(a, b) {
  if (!a || !b) return Infinity;
  const toRad = (value) => Number(value) * Math.PI / 180;
  const earthRadius = 6371000;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(h)));
}

function getNearbyCommunities(limit = 3) {
  const reference = getReferenceLatLngForCommunityList();
  return getSortedCommunities()
    .map((community) => ({
      community,
      distance: getDistanceMeters(reference, getCommunityCardLatLng(community))
    }))
    .sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      return String(a.community.name).localeCompare(String(b.community.name), "zh-CN", { numeric: true });
    })
    .slice(0, limit)
    .map((item) => item.community);
}

function clearCommunitySuggestionCloseTimer() {
  if (communitySuggestionCloseTimer) {
    clearTimeout(communitySuggestionCloseTimer);
    communitySuggestionCloseTimer = null;
  }
}

function hideCommunitySuggestionPanel() {
  clearCommunitySuggestionCloseTimer();
  if (!communitySuggestionPanel) return;
  communitySuggestionPanel.classList.remove("is-open");
}

function isCommunitySuggestionPanelOpen() {
  return !!(communitySuggestionPanel && communitySuggestionPanel.classList.contains("is-open"));
}

function positionCommunitySuggestionPanel() {
  if (!communitySuggestionPanel || !communitySelect) return;
  const rect = communitySelect.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 360;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 640;
  const gap = 6;
  const left = Math.max(6, Math.min(rect.left, viewportWidth - 12));
  const width = Math.max(180, Math.min(rect.width + 112, viewportWidth - left - 6));
  const top = Math.max(44, Math.min(rect.bottom + gap, viewportHeight - 140));

  communitySuggestionPanel.style.setProperty("--community-suggestion-left", `${left}px`);
  communitySuggestionPanel.style.setProperty("--community-suggestion-top", `${top}px`);
  communitySuggestionPanel.style.setProperty("--community-suggestion-width", `${width}px`);
}

function isCommunitySearchAreaTarget(target) {
  if (!target) return false;
  const bar = document.querySelector(".community-bar");
  return (bar && bar.contains(target)) || (communitySuggestionPanel && communitySuggestionPanel.contains(target));
}

function renderCommunityOptions(list, showPanel = false) {
  const communities = Array.isArray(list) ? list : [];

  // 保留 datalist 作为电脑端备用，但手机端主要使用下面的自定义结果面板，
  // 避免浏览器原生下拉层遮住搜索框文字。
  if (communityOptions) {
    communityOptions.innerHTML = "";
    communities.forEach((community) => {
      const option = document.createElement("option");
      option.value = community.name;
      option.label = `${community.name} · ${getCommunityTypeLabel(community.type)} · 选中后跳到名牌`;
      communityOptions.appendChild(option);
    });
  }

  if (!communitySuggestionPanel) return;
  communitySuggestionPanel.innerHTML = "";

  const suggestionCloseBtn = document.createElement("button");
  suggestionCloseBtn.type = "button";
  suggestionCloseBtn.className = "community-suggestion-close";
  suggestionCloseBtn.setAttribute("aria-label", "关闭地址列表");
  suggestionCloseBtn.innerText = "×";
  suggestionCloseBtn.addEventListener("mousedown", (event) => event.preventDefault());
  suggestionCloseBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    hideCommunitySuggestionPanel();
    if (communitySelect) communitySelect.blur();
  });
  communitySuggestionPanel.appendChild(suggestionCloseBtn);

  communities.forEach((community) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "community-suggestion-item";
    button.setAttribute("role", "option");
    const count = getCommunityNumberCount(community);
    button.innerHTML = `<strong>${community.name}</strong><span>${getCommunityTypeLabel(community.type)} · ${count} 个号码 · 点选跳到名牌</span>`;

    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      communitySelect.value = community.name;
      hideCommunitySuggestionPanel();
      jumpToCommunityCard(community.id);
      if (communitySelect) communitySelect.blur();
    });

    communitySuggestionPanel.appendChild(button);
  });

  if (showPanel && communities.length) {
    clearCommunitySuggestionCloseTimer();
    positionCommunitySuggestionPanel();
    communitySuggestionPanel.classList.add("is-open");
  } else {
    hideCommunitySuggestionPanel();
  }
}

function normalizeChineseNumberText(text) {
  let value = String(text || "").trim();
  if (!value) return "";

  const digitMap = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9
  };

  function parseSmallChineseNumber(chunk) {
    if (!chunk || !/[零〇一二两三四五六七八九十百千万]/.test(chunk)) return null;
    let total = 0;
    let section = 0;
    let number = 0;
    for (const ch of chunk) {
      if (Object.prototype.hasOwnProperty.call(digitMap, ch)) {
        number = digitMap[ch];
      } else if (ch === "十") {
        section += (number || 1) * 10;
        number = 0;
      } else if (ch === "百") {
        section += (number || 1) * 100;
        number = 0;
      } else if (ch === "千") {
        section += (number || 1) * 1000;
        number = 0;
      } else if (ch === "万") {
        total += (section + number || 1) * 10000;
        section = 0;
        number = 0;
      }
    }
    return String(total + section + number);
  }

  value = value.replace(/[零〇一二两三四五六七八九十百千万]+/g, (match) => parseSmallChineseNumber(match) || match);
  return value;
}

function normalizeCommunitySearchText(text) {
  return normalizeChineseNumberText(text)
    .toLowerCase()
    .replace(/号楼|號樓|楼|樓|号|號/g, "")
    .replace(/apartments?|apts?|apt\.?/g, "")
    .replace(/[^a-z0-9一-龥]+/g, "");
}

function getCommunitySearchMatches(keyword, limit = 30) {
  const raw = String(keyword || "").trim();
  if (!raw) return getNearbyCommunities(3);

  const normalizedKeyword = normalizeCommunitySearchText(raw);
  const rawLower = normalizeChineseNumberText(raw).toLowerCase();

  return getSortedCommunities()
    .map((community) => {
      const name = String(community.name || "");
      const normalizedName = normalizeCommunitySearchText(name);
      const lowerName = name.toLowerCase();
      let score = 0;

      if (lowerName === rawLower || normalizedName === normalizedKeyword) score = 100;
      else if (lowerName.includes(rawLower)) score = 80;
      else if (normalizedKeyword && normalizedName.includes(normalizedKeyword)) score = 75;
      else if (normalizedKeyword && normalizedKeyword.includes(normalizedName)) score = 60;
      else return null;

      return { community, score };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.community.name).localeCompare(String(b.community.name), "zh-CN", { numeric: true });
    })
    .slice(0, limit)
    .map((item) => item.community);
}

function renderCommunitySelector(mode = "nearby") {
  if (!communitySelect) return;

  // 手机端地址候选列表打开时，不要被定位刷新、地图触摸或其他状态刷新重画关闭。
  // 这是解决“下拉地址闪一下/停不住”的关键。
  if (isCommunitySuggestionPanelOpen()) {
    positionCommunitySuggestionPanel();
    return;
  }

  const active = getActiveCommunity();

  // 不要在普通地图点击、定位刷新或重绘时，把上一次公寓地址重新写回搜索框。
  // 当前公寓只放在 placeholder 里提示；输入框本身保持空白，方便继续双击新增新的地址。
  if (document.activeElement !== communitySelect) {
    communitySelect.value = "";
  }

  communitySelect.placeholder = active ? `当前：${active.name} / 输入地址搜索` : "输入地址搜索";

  if (mode === "all") renderCommunityOptions(getSortedCommunities());
  else renderCommunityOptions(getNearbyCommunities(3));
}

function updateCommunityOptionsForInput() {
  if (!communitySelect) return;
  const keyword = String(communitySelect.value || "").trim();
  if (!keyword) {
    hideCommunitySuggestionPanel();
    return;
  }
  renderCommunityOptions(getCommunitySearchMatches(keyword, 30), true);
}

function jumpToCommunityCard(communityId, zoom = 18) {
  const community = getCommunityById(communityId);
  if (!community) return;
  if (blockRouteInterrupt("跳转到其他公寓群")) return;

  // 手动选择公寓地址时，只暂停“正在跟随”的状态，不改定位/跟随模式的核心逻辑。
  // 否则定位监听下一次刷新会把地图从选中的公寓名牌重新拉回当前位置。
  if (followHeading) {
    followHeading = false;
    if (navButton) navButton.classList.remove("is-following");
    updateMobileStatus("已暂停跟随，正在查看选择的公寓", "已定位");
  }

  appData.activeCommunityId = community.id;
  selectedBuildingId = null;
  selectedPositions.clear();
  communitySearchCommunityId = null;
  communitySearchTargets = [];
  deliveryDeliveredKeys = new Set();
  deliveryCancelledKeys = new Set();
  deliveryPendingPanelOpen = false;
  deliveryDeliveredPanelOpen = false;
  displayMode = "communities";
  saveData();
  closeBuildingPanel();
  closeCommunitySearchPanel();
  renderCommunitySelector("nearby");
  renderMap();

  const center = getCommunityCardLatLng(community);
  if (Array.isArray(center) && Number.isFinite(center[0]) && Number.isFinite(center[1])) {
    map.setView(center, Math.max(map.getZoom(), zoom), { animate: true });
  }

  updateLocationStatus(`已跳到公寓名牌：${community.name}`, "success");
}

function commitCommunityInput() {
  if (!communitySelect) return;
  const input = String(communitySelect.value || "").trim();
  if (!input) {
    renderCommunitySelector("nearby");
    return;
  }

  const matches = getCommunitySearchMatches(input, 30);
  const exact = matches.find((community) =>
    String(community.name).trim().toLowerCase() === input.toLowerCase() ||
    normalizeCommunitySearchText(community.name) === normalizeCommunitySearchText(input)
  );

  const target = exact || (matches.length === 1 ? matches[0] : null);
  if (target) {
    jumpToCommunityCard(target.id);
    return;
  }

  if (matches.length > 1) {
    renderCommunityOptions(matches, true);
    updateLocationStatus(`找到 ${matches.length} 个匹配地址，请在下方联想结果里选择一个`, "info");
    communitySelect.value = input;
    return;
  }

  updateLocationStatus("没有找到这个公寓地址，请检查是否已经记录", "warning");
  renderCommunityOptions(getSortedCommunities(), true);
  communitySelect.value = input;
}

function addCommunityFromUser() {
  const name = prompt("请输入当前公寓名称或地址，例如：Park Place Apartments");
  if (!name || !name.trim()) return;

  pushHistory();
  const community = createCommunity(name.trim(), "universal", map.getCenter());
  selectedBuildingId = null;
  selectedPositions.clear();
  displayMode = "communities";
  saveData();
  renderCommunitySelector();
  closeBuildingPanel();
  renderMap();
  updateLocationStatus(`已新增公寓群牌面：${community.name}。进入后用“大楼 / 楼层 / 公寓号”表格添加号码。`, "success");
}

function renameActiveCommunity() {
  const community = getActiveCommunity();
  if (!community) return;

  const name = prompt("修改当前公寓名称或地址", community.name);
  if (!name || !name.trim()) return;

  pushHistory();
  community.name = name.trim();
  saveData();
  renderCommunitySelector();
  updateLocationStatus(`当前公寓已改名为：${community.name}`, "success");
}

function switchActiveCommunity(id) {
  if (!id || id === appData.activeCommunityId) return;
  if (blockRouteInterrupt("切换公寓群")) return;

  appData.activeCommunityId = id;
  selectedBuildingId = null;
  selectedPositions.clear();
  displayMode = "buildings";
  saveData();
  closeBuildingPanel();
  closeCommunitySearchPanel();
  renderCommunitySelector();
  renderMap();

  const community = getActiveCommunity();
  updateLocationStatus(`当前公寓：${community ? community.name : "未选择"}`, "info");
}

function getCurrentBuildings() {
  const community = getActiveCommunity();
  return community && Array.isArray(community.buildings) ? community.buildings : [];
}

function getBuildingById(id) {
  return getCurrentBuildings().find((building) => building.id === id);
}

function getBuildingByName(name) {
  return getCurrentBuildings().find((building) => building.name === name);
}

function getSortedBuildings() {
  return [...getCurrentBuildings()].sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN", { numeric: true }));
}

function getSortedPositions(building) {
  return [...building.positions].sort((a, b) => String(a.position).localeCompare(String(b.position), "zh-CN", { numeric: true }));
}

function addApartmentNumber(latlng, rawNumber) {
  const community = ensureActiveCommunity();
  const parsed = parseNumberByCommunity(rawNumber, community);
  if (!parsed) {
    alert(community.type === "flat" ? "请输入纯数字编号，例如 1、25 或 100" : "请输入 3 位或 4 位纯数字号码，例如 123 或 1203");
    return false;
  }

  pushHistory();

  let building = getBuildingByName(parsed.building);

  if (!building) {
    building = {
      id: makeId("building"),
      name: parsed.building,
      lat: latlng.lat,
      lng: latlng.lng,
      color: markerColor,
      size: markerSize,
      fontSize,
      shape: markerShape,
      positions: []
    };
    community.buildings.push(building);
  }

  let position = building.positions.find((item) => item.position === parsed.position);

  if (!position) {
    position = {
      id: makeId("position"),
      position: parsed.position,
      lat: latlng.lat,
      lng: latlng.lng,
      color: markerColor,
      size: markerSize,
      fontSize,
      shape: markerShape,
      originals: []
    };
    building.positions.push(position);
  }

  if (!position.originals.includes(parsed.original)) {
    position.originals.push(parsed.original);
  }

  saveData();
  displayMode = "buildings";
  selectedBuildingId = building.id;
  selectedPositions.clear();
  renderMap();
  openBuildingPanel(building.id);
  if (community.type === "flat") {
    updateLocationStatus(`${parsed.original} 已加入 ${community.name} / 独立编号`, "success");
  } else {
    updateLocationStatus(`${parsed.original} 已归入 ${community.name} / ${parsed.building}号楼，位置 ${parsed.position}`, "success");
  }
  return true;
}

function removeRenderedMarkers() {
  renderedMarkers.forEach((marker) => map.removeLayer(marker));
  renderedMarkers = [];
}

function renderMap() {
  removeRenderedMarkers();

  const community = getActiveCommunity();

  if (displayMode === "communities") {
    renderCommunityCards();
    renderDeliveryRoutePanel();
    return;
  }

  if (displayMode === "communitySearch") {
    renderCommunitySearchPositions();
    renderDeliveryRoutePanel();
    return;
  }

  if (displayMode === "selected" && selectedBuildingId) {
    const building = getBuildingById(selectedBuildingId);
    if (building) {
      renderSelectedPositions(building);
      renderDeliveryRoutePanel();
      return;
    }
  }

  if (isFlatCommunity(community)) {
    displayMode = "buildings";
    renderFlatNumbers(community);
    renderDeliveryRoutePanel();
    return;
  }

  displayMode = "buildings";
  renderBuildings();
  renderDeliveryRoutePanel();
}

function showCommunityCardsMode() {
  if (blockRouteInterrupt("切换到公寓群牌面")) return;
  displayMode = "communities";
  selectedBuildingId = null;
  selectedPositions.clear();
  closeBuildingPanel();
  closeCommunitySearchPanel();
  renderMap();
  updateLocationStatus(
    deliveryPlannedRouteOrderedKeys.length
      ? "已收起楼栋；本次规划路线已保留"
      : "已收起楼栋，只显示公寓群牌面",
    "info"
  );
}


function getCommunityById(id) {
  return (Array.isArray(appData.communities) ? appData.communities : []).find((community) => community.id === id) || null;
}

function openCommunitySearchPanel(communityId) {
  const community = getCommunityById(communityId);
  if (!community) return;

  if (blockRouteInterrupt("打开或切换公寓群")) return;

  appData.activeCommunityId = community.id;
  communitySearchCommunityId = community.id;
  communitySearchTargets = [];
  deliveryDeliveredKeys = new Set();
  deliveryCancelledKeys = new Set();
  deliveryPendingPanelOpen = false;
  deliveryDeliveredPanelOpen = false;
  selectedBuildingId = null;
  selectedPositions.clear();
  displayMode = "communities";
  saveData();
  renderCommunitySelector();
  closeBuildingPanel();

  if (communitySearchTitle) communitySearchTitle.innerText = community.name || "公寓群";
  if (communitySearchHint) communitySearchHint.innerText = "输入一个或多个公寓号；支持数字或字母 A-Z，用空格/换行分开，也支持 A-G；也可以点“显示全部号码”。";
  if (communityNumberSearchInput) {
    configureMobileSearchInputKeyboard();
    communityNumberSearchInput.value = "";
    if (!isMobileKeypadOnlyMode()) {
      setTimeout(() => communityNumberSearchInput.focus(), 80);
    }
  }
  if (communitySearchKeypad) communitySearchKeypad.classList.remove("is-letter-mode");
  if (communitySearchPanel) communitySearchPanel.classList.add("is-open");
  updateLocationStatus(`已打开 ${community.name}，请输入要查找的公寓号`, "info");
}

function closeCommunitySearchPanel() {
  if (communitySearchPanel) communitySearchPanel.classList.remove("is-open");
}

function getPositionDisplayNumber(community, building, position) {
  const originals = Array.isArray(position.originals) ? position.originals.filter(Boolean) : [];
  if (normalizeCommunityType(community?.type) === "universal") return originals[0] ? String(originals[0]) : String(position.position);
  if (isFlatCommunity(community) || isGroupFullCommunity(community)) return String(position.position);
  if (originals.length) return String(originals[0]);
  if (isTwoFloorSuffixCommunity(community)) return `${building.name}-${position.position}楼`;
  return `${building.name}${String(position.position).padStart(2, "0")}`;
}

function getAllCommunityPositionTargets(community) {
  const targets = [];
  (Array.isArray(community?.buildings) ? community.buildings : []).forEach((building) => {
    (Array.isArray(building.positions) ? building.positions : []).forEach((position) => {
      targets.push(createDeliveryTargetFromRecord(community, building, position));
    });
  });
  return targets;
}


function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

function getDeliveryTargetKey(target) {
  return `${target?.buildingId || ""}:${target?.positionId || ""}`;
}

function cleanDeliveryRouteState() {
  const existingKeys = new Set((Array.isArray(communitySearchTargets) ? communitySearchTargets : []).map(getDeliveryTargetKey));
  deliveryDeliveredKeys = new Set(Array.from(deliveryDeliveredKeys).filter((key) => existingKeys.has(key)));
  deliveryCancelledKeys = new Set(Array.from(deliveryCancelledKeys).filter((key) => existingKeys.has(key)));

  if (!communitySearchTargets.length || displayMode !== "communitySearch") {
    deliveryPendingPanelOpen = false;
    deliveryDeliveredPanelOpen = false;
    deliveryLastHiddenTarget = null;
    deliveryLastHiddenType = "";
    hideDeliveryToast();
  }
}

function resetDeliveryRouteState() {
  deliveryDeliveredKeys = new Set();
  deliveryCancelledKeys = new Set();
  deliveryPendingPanelOpen = false;
  deliveryDeliveredPanelOpen = false;
  deliveryLastHiddenTarget = null;
  deliveryLastHiddenType = "";
  hideDeliveryToast();
  renderDeliveryRoutePanel();
}

function getDeliveryPendingTargets() {
  return sortDeliveryTargets((Array.isArray(communitySearchTargets) ? communitySearchTargets : []).filter((target) => {
    const key = getDeliveryTargetKey(target);
    return !deliveryDeliveredKeys.has(key) && !deliveryCancelledKeys.has(key);
  }));
}

function getDeliveryDeliveredTargets() {
  return sortDeliveryTargets((Array.isArray(communitySearchTargets) ? communitySearchTargets : []).filter((target) => deliveryDeliveredKeys.has(getDeliveryTargetKey(target))));
}

function getDeliveryTargetLabel(target) {
  return String(target?.label || target?.position || "").trim() || "号码";
}

function getTargetPositionRecord(target, community = getCommunityById(communitySearchCommunityId || appData.activeCommunityId)) {
  if (!community || !target) return { building: null, position: null };
  const building = (community.buildings || []).find((item) => item.id === target.buildingId);
  const position = (building?.positions || []).find((item) => item.id === target.positionId || String(item.position) === String(target.position));
  return { building: building || null, position: position || null };
}

function getNumericText(value) {
  return String(value ?? "").replace(/[^0-9]/g, "");
}

function toSortableNumber(value, fallback = 999999999) {
  const digits = getNumericText(value);
  if (!digits) return fallback;
  const number = Number(digits);
  return Number.isFinite(number) ? number : fallback;
}

function toSortableApartmentUnit(value, fallback = 999999999) {
  const text = String(value || "").trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (/^[A-Za-z]+$/.test(text)) {
    const alpha = alphaApartmentLabelToNumber(text);
    return Number.isFinite(alpha) ? 1000000 + alpha : fallback;
  }
  return toSortableNumber(text, fallback);
}

function hasSortableNumber(value) {
  return getNumericText(value).length > 0;
}

function buildDeliverySortPartsFromRecord(community, building, position, label = "") {
  const displayLabel = String(label || getPositionDisplayNumber(community, building, position) || position?.position || "").trim();
  const originals = Array.isArray(position?.originals) ? position.originals.filter(Boolean).map(String) : [];
  const original = originals.length ? originals[0] : displayLabel;
  const universal = position?.universal || {};
  const universalBuilding = String(universal.building || "").trim();
  const universalFloor = String(universal.floor || "").trim();
  const universalUnit = String(universal.unit || "").trim();
  const buildingName = String(building?.name || "").trim();
  const buildingNumber = toSortableNumber(universalBuilding || buildingName, 999999);
  const floorNumber = toSortableNumber(universalFloor, universalFloor ? 999999 : 0);
  const unitNumber = toSortableApartmentUnit(universalUnit || position?.position || displayLabel, 999999);
  const originalNumber = toSortableApartmentUnit(original || displayLabel, 999999999);

  // 万用号码填写了“大楼”时，先按楼栋数字排：3号楼必须在10号楼前面；再按楼层、房号排。
  if (universalBuilding) {
    return [0, buildingNumber, floorNumber, unitNumber, originalNumber];
  }

  // 没有大楼、只有1楼/2楼时，小公寓号码是独一无二的；先按后面的小号码排，再用楼层兜底。
  if (universalFloor) {
    return [1, unitNumber, floorNumber, originalNumber];
  }

  // 只有号码、独立号码：按号码本身排。
  if (universalUnit) {
    return [2, unitNumber, originalNumber, buildingNumber];
  }

  const twoFloorLabel = displayLabel.match(/^(\d+)\s*[-–—]?\s*([12])\s*楼$/);
  if (twoFloorLabel) {
    return [3, Number(twoFloorLabel[1]), Number(twoFloorLabel[2]), buildingNumber, unitNumber, originalNumber];
  }

  // 兼容旧数据：只要楼栋名称里能提取出数字，就先按楼栋数字排，不再按“10、3”的文字顺序或输入顺序排。
  if (hasSortableNumber(buildingName)) {
    return [4, buildingNumber, unitNumber, originalNumber];
  }

  return [5, unitNumber, buildingNumber, originalNumber];
}

function createDeliveryTargetFromRecord(community, building, position) {
  const label = getPositionDisplayNumber(community, building, position);
  return {
    communityId: community?.id || "",
    buildingId: building?.id || "",
    positionId: position?.id || "",
    position: String(position?.position ?? ""),
    label,
    sortParts: buildDeliverySortPartsFromRecord(community, building, position, label)
  };
}

function getDeliverySortParts(target) {
  if (Array.isArray(target?.sortParts)) return target.sortParts;
  const community = getCommunityById(target?.communityId || communitySearchCommunityId || appData.activeCommunityId);
  const { building, position } = getTargetPositionRecord(target, community);
  if (building && position) return buildDeliverySortPartsFromRecord(community, building, position, getDeliveryTargetLabel(target));
  return [9, toSortableNumber(target?.position || target?.label, 999999999), 999999999];
}

function compareDeliveryTargets(a, b) {
  const left = getDeliverySortParts(a);
  const right = getDeliverySortParts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return getDeliveryTargetLabel(a).localeCompare(getDeliveryTargetLabel(b), "zh-CN", { numeric: true });
}

function sortDeliveryTargets(targets) {
  return [...(Array.isArray(targets) ? targets : [])].sort(compareDeliveryTargets);
}

function hideDeliveryToast() {
  if (deliveryToastTimer) {
    clearTimeout(deliveryToastTimer);
    deliveryToastTimer = null;
  }
  if (deliveryToast) deliveryToast.classList.remove("is-open");
}

function showDeliveryToast(target, type = "delivered") {
  if (!deliveryToast || !deliveryToastText) return;
  hideDeliveryToast();
  deliveryLastHiddenTarget = target;
  deliveryLastHiddenType = type;
  deliveryToastText.innerText = type === "cancelled" ? `已取消 ${getDeliveryTargetLabel(target)} 号` : `已送达 ${getDeliveryTargetLabel(target)} 号`;
  deliveryToast.classList.add("is-open");
  deliveryToastTimer = setTimeout(() => {
    deliveryToastTimer = null;
    if (deliveryToast) deliveryToast.classList.remove("is-open");
  }, 3800);
}

function undoLastDeliveryHide() {
  if (!deliveryLastHiddenTarget) return;
  const key = getDeliveryTargetKey(deliveryLastHiddenTarget);
  if (deliveryLastHiddenType === "cancelled") deliveryCancelledKeys.delete(key);
  else deliveryDeliveredKeys.delete(key);
  const label = getDeliveryTargetLabel(deliveryLastHiddenTarget);
  deliveryLastHiddenTarget = null;
  deliveryLastHiddenType = "";
  hideDeliveryToast();
  renderMap();
  syncDeliveryWalkConnectorLayers();
  updateLocationStatus(`已恢复 ${label} 号到本次号码`, "success");
}

function markDeliveryTargetDelivered(target) {
  if (!target) return;
  const key = getDeliveryTargetKey(target);
  if (!key || deliveryDeliveredKeys.has(key)) return;
  deliveryCancelledKeys.delete(key);
  deliveryDeliveredKeys.add(key);
  renderMap();
  syncDeliveryWalkConnectorLayers();
  showDeliveryToast(target, "delivered");
  updateLocationStatus(`已送达 ${getDeliveryTargetLabel(target)} 号，已从地图隐藏`, "success");
}

function cancelDeliveryTarget(target) {
  if (!target) return;
  const key = getDeliveryTargetKey(target);
  if (!key || deliveryCancelledKeys.has(key)) return;
  deliveryDeliveredKeys.delete(key);
  deliveryCancelledKeys.add(key);
  renderMap();
  syncDeliveryWalkConnectorLayers();
  showDeliveryToast(target, "cancelled");
  updateLocationStatus(`已取消 ${getDeliveryTargetLabel(target)} 号，已从本次地图隐藏`, "warning");
}

function restoreDeliveryTarget(target) {
  if (!target) return;
  const key = getDeliveryTargetKey(target);
  deliveryDeliveredKeys.delete(key);
  deliveryCancelledKeys.delete(key);
  renderMap();
  syncDeliveryWalkConnectorLayers();
  updateLocationStatus(`已恢复 ${getDeliveryTargetLabel(target)} 号到地图`, "success");
}

function zoomToDeliveryTarget(target) {
  const community = getCommunityById(communitySearchCommunityId || appData.activeCommunityId);
  if (!community || !target) return;
  const building = (community.buildings || []).find((item) => item.id === target.buildingId);
  const position = (building?.positions || []).find((item) => item.id === target.positionId || String(item.position) === String(target.position));
  if (!position) return;
  map.setView([Number(position.lat), Number(position.lng)], Math.max(map.getZoom(), 19), { animate: true });
}

function getDeliveryTargetLatLng(target) {
  const community = getCommunityById(target?.communityId || communitySearchCommunityId || appData.activeCommunityId);
  const { position } = getTargetPositionRecord(target, community);
  const lat = Number(position?.lat);
  const lng = Number(position?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return L.latLng(lat, lng);
}

function fitDeliveryTargetsIntoMap(targets) {
  if (!map || !Array.isArray(targets) || !targets.length) return;

  const points = targets
    .map((target) => getDeliveryTargetLatLng(target))
    .filter(Boolean);

  if (!points.length) return;

  const isMobile = isMobileKeypadOnlyMode();
  const currentZoom = typeof map.getZoom === "function" ? map.getZoom() : 18;

  if (points.length === 1) {
    map.setView(points[0], Math.max(currentZoom, 18), { animate: true });
    return;
  }

  const bounds = L.latLngBounds(points);
  if (!bounds.isValid()) return;

  map.fitBounds(bounds, {
    animate: true,
    paddingTopLeft: isMobile ? [28, 108] : [42, 70],
    paddingBottomRight: isMobile ? [88, 142] : [42, 70],
    maxZoom: 18
  });
}

function scheduleFitCurrentDeliveryTargetsIntoMap(delay = 120) {
  window.setTimeout(() => {
    if (displayMode !== "communitySearch") return;
    fitDeliveryTargetsIntoMap(getDeliveryPendingTargets());
  }, delay);
}

function createDeliveryRouteRow(target, delivered = false) {
  const row = document.createElement("div");
  row.className = delivered ? "delivery-route-row is-delivered" : "delivery-route-row";

  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "delivery-route-chip";
  const routeOrder = delivered ? 0 : getDeliveryRouteOrderIndex(target);
  chip.innerText = routeOrder ? `${routeOrder}. ${getDeliveryTargetLabel(target)}` : getDeliveryTargetLabel(target);
  chip.addEventListener("click", () => zoomToDeliveryTarget(target));

  const action = document.createElement("button");
  action.type = "button";
  action.className = "delivery-route-action";
  action.innerText = delivered ? "恢复" : "已送达";
  action.addEventListener("click", () => {
    if (delivered) restoreDeliveryTarget(target);
    else markDeliveryTargetDelivered(target);
  });

  const locate = document.createElement("button");
  locate.type = "button";
  locate.className = "delivery-route-locate";
  locate.innerText = "定位";
  locate.addEventListener("click", () => zoomToDeliveryTarget(target));

  row.appendChild(chip);
  row.appendChild(action);
  row.appendChild(locate);
  return row;
}

function openDeliveryActionPopup(marker, target) {
  if (!marker || !target || !map) return;

  // 不把“已送达 / 取消”弹窗永久 bind 到 marker 上。
  // Leaflet 的 bindPopup 会给 marker 增加内置点击开关逻辑，手机端第二次点击同一个号码时，
  // 内置开关可能先把弹窗关掉，导致看起来“第一次能弹、第二次不弹”。
  // 这里每次点击都创建一个临时 popup，确保同一个小号码可以反复点击、反复弹出。
  if (typeof marker.unbindPopup === "function") marker.unbindPopup();

  const wrap = document.createElement("div");
  wrap.className = "delivery-action-popup";

  const deliveredBtn = document.createElement("button");
  deliveredBtn.type = "button";
  deliveredBtn.className = "delivery-action-delivered";
  deliveredBtn.innerText = "已送达";
  deliveredBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    map.closePopup();
    markDeliveryTargetDelivered(target);
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "delivery-action-cancel";
  cancelBtn.innerText = "取消";
  cancelBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    map.closePopup();
    cancelDeliveryTarget(target);
  });

  wrap.appendChild(deliveredBtn);
  wrap.appendChild(cancelBtn);

  const latlng = typeof marker.getLatLng === "function" ? marker.getLatLng() : null;
  if (!latlng) return;

  L.popup({
    closeButton: true,
    autoPan: true,
    className: "delivery-action-popup-shell",
    offset: [0, -8]
  })
    .setLatLng(latlng)
    .setContent(wrap)
    .openOn(map);
}

function renderDeliveryRouteRows(container, targets, delivered = false) {
  if (!container) return;
  container.innerHTML = "";

  if (!targets.length) {
    const empty = document.createElement("div");
    empty.className = "delivery-route-empty";
    empty.innerText = delivered ? "还没有已送达号码" : "本次号码已全部送达";
    container.appendChild(empty);
    return;
  }

  targets.forEach((target) => container.appendChild(createDeliveryRouteRow(target, delivered)));
}

function renderDeliveryRoutePanel() {
  if (!deliveryRoutePanel) return;
  cleanDeliveryRouteState();

  const visible = isMobileKeypadOnlyMode() && displayMode === "communitySearch" && Array.isArray(communitySearchTargets) && communitySearchTargets.length > 0;
  deliveryRoutePanel.classList.toggle("is-visible", visible);
  if (!visible) return;

  const pendingTargets = getDeliveryPendingTargets();
  const deliveredTargets = getDeliveryDeliveredTargets();

  if (pendingRouteCount) pendingRouteCount.innerText = String(pendingTargets.length);
  if (deliveredRouteCount) deliveredRouteCount.innerText = String(deliveredTargets.length);
  if (pendingRouteToggleCount) pendingRouteToggleCount.innerText = String(pendingTargets.length);
  if (deliveredRouteToggleCount) deliveredRouteToggleCount.innerText = String(deliveredTargets.length);

  if (togglePendingRouteListBtn) {
    togglePendingRouteListBtn.classList.toggle("is-open", deliveryPendingPanelOpen);
    togglePendingRouteListBtn.setAttribute("aria-expanded", deliveryPendingPanelOpen ? "true" : "false");
    const icon = togglePendingRouteListBtn.querySelector("em");
    if (icon) icon.innerText = deliveryPendingPanelOpen ? "⌃" : "⌄";
  }

  if (toggleDeliveredRouteListBtn) {
    toggleDeliveredRouteListBtn.classList.toggle("is-open", deliveryDeliveredPanelOpen);
    toggleDeliveredRouteListBtn.setAttribute("aria-expanded", deliveryDeliveredPanelOpen ? "true" : "false");
    const icon = toggleDeliveredRouteListBtn.querySelector("em");
    if (icon) icon.innerText = deliveryDeliveredPanelOpen ? "⌃" : "⌄";
  }

  if (pendingRouteListPanel) pendingRouteListPanel.classList.toggle("is-open", deliveryPendingPanelOpen);
  if (deliveredRouteListPanel) deliveredRouteListPanel.classList.toggle("is-open", deliveryDeliveredPanelOpen);

  if (pendingRouteEmptyState) pendingRouteEmptyState.hidden = pendingTargets.length !== 0;
  updateDeliveryRoutePlanStatus();
  renderDeliveryRouteRows(pendingRouteList, pendingTargets, false);
  renderDeliveryRouteRows(deliveredRouteList, deliveredTargets, true);
}

function togglePendingDeliveryPanel() {
  deliveryPendingPanelOpen = !deliveryPendingPanelOpen;
  if (deliveryPendingPanelOpen) deliveryDeliveredPanelOpen = false;
  renderDeliveryRoutePanel();
}

function toggleDeliveredDeliveryPanel() {
  deliveryDeliveredPanelOpen = !deliveryDeliveredPanelOpen;
  if (deliveryDeliveredPanelOpen) deliveryPendingPanelOpen = false;
  renderDeliveryRoutePanel();
}

function addDeliveryRouteNumbersFromText(text) {
  const community = getCommunityById(communitySearchCommunityId || appData.activeCommunityId);
  if (!community) return { added: 0, restored: 0, found: 0 };

  const targets = getSearchTargetsForCommunity(text, community);
  if (!targets.length) return { added: 0, restored: 0, found: 0 };

  const existingKeys = new Set(communitySearchTargets.map(getDeliveryTargetKey));
  let added = 0;
  let restored = 0;

  targets.forEach((target) => {
    const key = getDeliveryTargetKey(target);
    if (existingKeys.has(key)) {
      const wasDelivered = deliveryDeliveredKeys.delete(key);
      const wasCancelled = deliveryCancelledKeys.delete(key);
      if (wasDelivered || wasCancelled) restored += 1;
      return;
    }
    communitySearchTargets.push(target);
    existingKeys.add(key);
    added += 1;
  });

  return { added, restored, found: targets.length };
}

function promptAddDeliveryRouteNumber() {
  const value = prompt("请输入要补加的公寓号码；多个号码可以用空格、逗号或换行分开。", "");
  if (!value || !String(value).trim()) return;

  const result = addDeliveryRouteNumbersFromText(value);
  if (!result.found) {
    alert("没有找到要添加的号码，请确认号码已经在当前公寓资料里。\n如果这个号码还没有建档，需要先进入编辑模式添加到地图资料。 ");
    return;
  }

  appData.activeCommunityId = communitySearchCommunityId || appData.activeCommunityId;
  displayMode = "communitySearch";
  deliveryPendingPanelOpen = true;
  deliveryDeliveredPanelOpen = false;
  renderMap();
  scheduleFitCurrentDeliveryTargetsIntoMap();

  const parts = [];
  if (result.added) parts.push(`新增 ${result.added} 个`);
  if (result.restored) parts.push(`恢复 ${result.restored} 个`);
  updateLocationStatus(parts.length ? `${parts.join("，")}号码到本次送货清单` : "这些号码已经在本次清单里", result.added || result.restored ? "success" : "info");
  if (result.added > 0) window.setTimeout(replanDeliveryRouteOnlyForNewTargets, 80);
}

function normalizeApartmentSearchValue(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z]+$/.test(text) ? text.toUpperCase() : text;
}

function getSearchTargetsForCommunity(text, community) {
  const tokens = expandApartmentUnitInput(text);
  const rawTokens = String(text || "")
    .split(/[\s,，、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const searchValues = tokens.length ? tokens : rawTokens;
  const wanted = new Set(searchValues.map(normalizeApartmentSearchValue));
  const targets = [];
  const added = new Set();

  if (wanted.size === 0) return [];

  (Array.isArray(community?.buildings) ? community.buildings : []).forEach((building) => {
    (Array.isArray(building.positions) ? building.positions : []).forEach((position) => {
      const originals = Array.isArray(position.originals) ? position.originals.map(String) : [];
      const candidates = new Set([
        String(position.position),
        getPositionDisplayNumber(community, building, position),
        ...originals
      ].map(normalizeApartmentSearchValue));

      wanted.forEach((value) => {
        const parsed = parseNumberByCommunity(value, community);
        if (parsed && parsed.building === building.name && parsed.position === String(position.position)) {
          candidates.add(value);
        }
      });

      const matched = Array.from(wanted).some((value) => candidates.has(normalizeApartmentSearchValue(value)));
      if (!matched) return;

      const key = `${building.id}:${position.id}`;
      if (added.has(key)) return;
      added.add(key);
      targets.push(createDeliveryTargetFromRecord(community, building, position));
    });
  });

  return sortDeliveryTargets(targets);
}

function insertCommunitySearchText(text) {
  if (!communityNumberSearchInput) return;

  const insertText = text === "\\n" ? "\n" : String(text || "");
  const start = typeof communityNumberSearchInput.selectionStart === "number" ? communityNumberSearchInput.selectionStart : communityNumberSearchInput.value.length;
  const end = typeof communityNumberSearchInput.selectionEnd === "number" ? communityNumberSearchInput.selectionEnd : communityNumberSearchInput.value.length;
  const before = communityNumberSearchInput.value.slice(0, start);
  const after = communityNumberSearchInput.value.slice(end);

  communityNumberSearchInput.value = before + insertText + after;
  const cursor = start + insertText.length;
  if (!isMobileKeypadOnlyMode()) communityNumberSearchInput.focus();
  if (typeof communityNumberSearchInput.setSelectionRange === "function") {
    communityNumberSearchInput.setSelectionRange(cursor, cursor);
  }
}

function showCommunityNumberSearchResults() {
  if (blockRouteInterrupt("重新搜索号码")) return;
  clearDeliveryPlannedRoute();
  const community = getCommunityById(communitySearchCommunityId || appData.activeCommunityId);
  if (!community) return;

  const input = communityNumberSearchInput ? communityNumberSearchInput.value : "";
  const targets = getSearchTargetsForCommunity(input, community);
  if (targets.length === 0) {
    alert("没有找到这些公寓号。可以输入：101、102、203，或 A、B、C；也支持 A-G。可以一行写一个，空格和换行都能识别。请再检查是否在当前公寓群里。");
    return;
  }

  communitySearchCommunityId = community.id;
  communitySearchTargets = targets;
  deliveryDeliveredKeys = new Set();
  deliveryCancelledKeys = new Set();
  deliveryPendingPanelOpen = false;
  deliveryDeliveredPanelOpen = false;
  appData.activeCommunityId = community.id;
  displayMode = "communitySearch";
  closeCommunitySearchPanel();
  closeBuildingPanel();
  saveData();
  renderMap();
  scheduleFitCurrentDeliveryTargetsIntoMap();
  updateLocationStatus(`已显示 ${targets.length} 个号码的位置`, "success");
}

function showAllNumbersForCommunity() {
  if (blockRouteInterrupt("重新载入全部号码")) return;
  clearDeliveryPlannedRoute();
  const community = getCommunityById(communitySearchCommunityId || appData.activeCommunityId);
  if (!community) return;

  const targets = getAllCommunityPositionTargets(community);
  if (targets.length === 0) {
    alert("这个公寓群里面还没有号码。请先添加号码。");
    return;
  }

  communitySearchCommunityId = community.id;
  communitySearchTargets = targets;
  deliveryDeliveredKeys = new Set();
  deliveryCancelledKeys = new Set();
  deliveryPendingPanelOpen = false;
  deliveryDeliveredPanelOpen = false;
  appData.activeCommunityId = community.id;
  displayMode = "communitySearch";
  closeCommunitySearchPanel();
  closeBuildingPanel();
  saveData();
  renderMap();
  scheduleFitCurrentDeliveryTargetsIntoMap();
  updateLocationStatus(`已显示 ${community.name} 的全部 ${targets.length} 个号码`, "success");
}

function showCommunityBuildingsOnly() {
  if (blockRouteInterrupt("退出本次路线")) return;
  clearDeliveryPlannedRoute();
  const community = getCommunityById(communitySearchCommunityId || appData.activeCommunityId);
  if (!community) return;
  appData.activeCommunityId = community.id;
  displayMode = "buildings";
  communitySearchTargets = [];
  deliveryDeliveredKeys = new Set();
  deliveryCancelledKeys = new Set();
  deliveryPendingPanelOpen = false;
  deliveryDeliveredPanelOpen = false;
  closeCommunitySearchPanel();
  closeBuildingPanel();
  saveData();
  renderCommunitySelector();
  renderMap();
  updateLocationStatus(`只显示 ${community.name} 的楼栋标记`, "info");
}

const BUILDING_PHOTO_MAX_BYTES = 600 * 1024;
const BUILDING_PHOTO_TARGET_BYTES = 500 * 1024;
const BUILDING_PHOTO_MIME_TYPE = "image/jpeg";
const BUILDING_PHOTO_EXT = "jpg";
const BUILDING_PHOTO_DOC_PREFIX = "buildingPhoto_";
const BUILDING_PHOTO_DB_NAME = "xunbaohuoBuildingPhotos";
const BUILDING_PHOTO_STORE_NAME = "photos";
const BUILDING_PHOTO_FULL_SIZES = [
  [1080, 1920],
  [960, 1707],
  [900, 1600],
  [810, 1440],
  [720, 1280],
  [640, 1138],
  [540, 960]
];
const BUILDING_PHOTO_QUALITIES = [0.82, 0.78, 0.74, 0.7, 0.66, 0.62, 0.58, 0.54, 0.5, 0.46, 0.42];

function getBuildingPhotoDocId(communityId, buildingId) {
  return `${BUILDING_PHOTO_DOC_PREFIX}${String(communityId || "community").replace(/[^a-zA-Z0-9_-]/g, "_")}_${String(buildingId || "building").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

const COMMUNITY_OFFICE_PHOTO_DOC_PREFIX = "communityOfficePhoto_";

function getCommunityOfficePhotoDocId(communityId) {
  return `${COMMUNITY_OFFICE_PHOTO_DOC_PREFIX}${String(communityId || "community").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function getCommunityOfficePhotoMeta(community) {
  return normalizeBuildingPhotoMeta(community?.officePhoto);
}

function getCommunityOfficePhotoTitle(community) {
  return `${String(community?.name || "公寓社区")} · 办公室地址照片`;
}

function getCommunityOfficePhotoThumb(community) {
  const photo = getCommunityOfficePhotoMeta(community);
  return String(photo?.thumbDataUrl || "");
}

function getApartmentMarkerPhotoThumb(community, building) {
  const buildingThumb = getBuildingPhotoThumb(building);
  const officeThumb = getCommunityOfficePhotoThumb(community);

  // 手机送包裹模式下：优先显示“本楼照片”缩略图；没有再回退到“整个公寓社区”的办公室照片。
  // 这样司机长按号码给某一栋楼拍过照片后，能马上在这栋楼的小号码上看到更准确的缩略图提示。
  if (isMobileKeypadOnlyMode() && !mobileEditMode) {
    if (buildingThumb) return buildingThumb;
    if (officeThumb) return officeThumb;
  }
  return buildingThumb || officeThumb || "";
}

function normalizeBuildingPhotoMeta(photo) {
  if (!photo || !photo.hasPhoto) return undefined;
  return {
    id: String(photo.id || ""),
    hasPhoto: true,
    thumbDataUrl: String(photo.thumbDataUrl || photo.thumbUrl || ""),
    mimeType: BUILDING_PHOTO_MIME_TYPE,
    ext: BUILDING_PHOTO_EXT,
    sizeKB: Number.isFinite(Number(photo.sizeKB)) ? Math.round(Number(photo.sizeKB)) : undefined,
    width: Number.isFinite(Number(photo.width)) ? Number(photo.width) : undefined,
    height: Number.isFinite(Number(photo.height)) ? Number(photo.height) : undefined,
    updatedAtMs: Number(photo.updatedAtMs || photo.createdAtMs || Date.now())
  };
}

function getBuildingPhotoMeta(building) {
  return normalizeBuildingPhotoMeta(building?.photo);
}

function getBuildingPhotoThumb(building) {
  return getBuildingPhotoMeta(building)?.thumbDataUrl || "";
}

function getBuildingPhotoTitle(building) {
  const community = getActiveCommunity();
  const buildingName = building ? getBuildingDisplayName(building, community) : "大楼";
  return `${buildingName}照片`;
}

function updateBuildingPhotoButton(building) {
  if (!addBuildingPhotoBtn) return;
  const hasPhoto = !!getBuildingPhotoMeta(building);
  addBuildingPhotoBtn.innerText = hasPhoto ? "📷 查看/更换大楼照片" : "＋ 添加大楼照片";
  addBuildingPhotoBtn.title = hasPhoto ? "查看或更换这一栋大楼照片" : "给这一栋大楼添加照片，同楼小号码共用";
}

function dataUrlByteLength(dataUrl) {
  const base64 = String(dataUrl || "").split(",")[1] || "";
  return Math.floor(base64.length * 3 / 4);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取照片失败"));
    reader.readAsDataURL(blob);
  });
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("照片无法读取，请换一张 JPG 或 PNG 照片"));
    };
    img.src = url;
  });
}

function drawCoverImageToCanvas(img, targetWidth, targetHeight) {
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, targetWidth, targetHeight);

  const sourceWidth = img.naturalWidth || img.width;
  const sourceHeight = img.naturalHeight || img.height;
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;
  let sx = 0;
  let sy = 0;
  let sw = sourceWidth;
  let sh = sourceHeight;

  if (sourceRatio > targetRatio) {
    sw = sourceHeight * targetRatio;
    sx = (sourceWidth - sw) / 2;
  } else {
    sh = sourceWidth / targetRatio;
    sy = (sourceHeight - sh) / 2;
  }

  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
  return canvas;
}

function canvasToJpegBlob(canvas, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), BUILDING_PHOTO_MIME_TYPE, quality);
  });
}

async function makeBuildingPhotoThumb(img) {
  const canvas = drawCoverImageToCanvas(img, 96, 96);
  const blob = await canvasToJpegBlob(canvas, 0.72);
  return blobToDataUrl(blob);
}

async function compressBuildingPhotoFile(file) {
  if (!file || !String(file.type || "").startsWith("image/")) {
    throw new Error("请选择照片文件");
  }

  const img = await loadImageFromFile(file);
  const thumbDataUrl = await makeBuildingPhotoThumb(img);
  let best = null;

  for (const [width, height] of BUILDING_PHOTO_FULL_SIZES) {
    const canvas = drawCoverImageToCanvas(img, width, height);
    for (const quality of BUILDING_PHOTO_QUALITIES) {
      const blob = await canvasToJpegBlob(canvas, quality);
      if (!blob) continue;
      const candidate = { blob, width, height, quality, size: blob.size };
      if (!best || Math.abs(candidate.size - BUILDING_PHOTO_TARGET_BYTES) < Math.abs(best.size - BUILDING_PHOTO_TARGET_BYTES)) {
        best = candidate;
      }
      if (candidate.size <= BUILDING_PHOTO_MAX_BYTES) {
        const dataUrl = await blobToDataUrl(blob);
        return {
          dataUrl,
          thumbDataUrl,
          width,
          height,
          quality,
          mimeType: BUILDING_PHOTO_MIME_TYPE,
          ext: BUILDING_PHOTO_EXT,
          sizeBytes: blob.size,
          sizeKB: Math.round(blob.size / 1024)
        };
      }
    }
  }

  if (!best) throw new Error("照片压缩失败");
  const dataUrl = await blobToDataUrl(best.blob);
  return {
    dataUrl,
    thumbDataUrl,
    width: best.width,
    height: best.height,
    quality: best.quality,
    mimeType: BUILDING_PHOTO_MIME_TYPE,
    ext: BUILDING_PHOTO_EXT,
    sizeBytes: best.blob.size,
    sizeKB: Math.round(best.blob.size / 1024)
  };
}

function openBuildingPhotoDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("当前浏览器不支持本地照片缓存"));
      return;
    }
    const request = indexedDB.open(BUILDING_PHOTO_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BUILDING_PHOTO_STORE_NAME)) {
        db.createObjectStore(BUILDING_PHOTO_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("打开本地照片缓存失败"));
  });
}

async function putLocalBuildingPhoto(photoRecord) {
  try {
    const db = await openBuildingPhotoDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(BUILDING_PHOTO_STORE_NAME, "readwrite");
      tx.objectStore(BUILDING_PHOTO_STORE_NAME).put(photoRecord);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("保存本地照片失败"));
    });
    db.close();
  } catch (error) {
    console.warn("本地照片缓存失败：", error);
  }
}

async function getLocalBuildingPhoto(photoId) {
  try {
    const db = await openBuildingPhotoDb();
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(BUILDING_PHOTO_STORE_NAME, "readonly");
      const request = tx.objectStore(BUILDING_PHOTO_STORE_NAME).get(photoId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("读取本地照片失败"));
    });
    db.close();
    return result;
  } catch (error) {
    console.warn("读取本地照片缓存失败：", error);
    return null;
  }
}

async function deleteLocalBuildingPhoto(photoId) {
  try {
    const db = await openBuildingPhotoDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(BUILDING_PHOTO_STORE_NAME, "readwrite");
      tx.objectStore(BUILDING_PHOTO_STORE_NAME).delete(photoId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("删除本地照片失败"));
    });
    db.close();
  } catch (error) {
    console.warn("删除本地照片缓存失败：", error);
  }
}

async function saveBuildingPhotoToCloud(photoRecord) {
  const db = await ensureCloudReady();
  await db.collection(CLOUD_COLLECTION_NAME).doc(photoRecord.id).set({
    type: "buildingPhoto",
    appName: "xunbaohuo-map-navigation",
    schemaVersion: 1,
    id: photoRecord.id,
    communityId: photoRecord.communityId,
    buildingId: photoRecord.buildingId,
    mimeType: BUILDING_PHOTO_MIME_TYPE,
    ext: BUILDING_PHOTO_EXT,
    width: photoRecord.width,
    height: photoRecord.height,
    sizeBytes: photoRecord.sizeBytes,
    sizeKB: photoRecord.sizeKB,
    dataUrl: photoRecord.dataUrl,
    thumbDataUrl: photoRecord.thumbDataUrl,
    updatedAtMs: photoRecord.updatedAtMs,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    deviceId: getCloudDeviceId()
  });
}

async function getBuildingPhotoFromCloud(photoId) {
  const db = await ensureCloudReady();
  const doc = await db.collection(CLOUD_COLLECTION_NAME).doc(photoId).get();
  if (!doc.exists) return null;
  return doc.data() || null;
}

async function deleteBuildingPhotoFromCloud(photoId) {
  const db = await ensureCloudReady();
  await db.collection(CLOUD_COLLECTION_NAME).doc(photoId).delete();
}

async function saveCommunityOfficePhotoToCloud(photoRecord) {
  const db = await ensureCloudReady();
  await db.collection(CLOUD_COLLECTION_NAME).doc(photoRecord.id).set({
    type: "communityOfficePhoto",
    appName: "xunbaohuo-map-navigation",
    schemaVersion: 1,
    id: photoRecord.id,
    communityId: photoRecord.communityId,
    mimeType: BUILDING_PHOTO_MIME_TYPE,
    ext: BUILDING_PHOTO_EXT,
    width: photoRecord.width,
    height: photoRecord.height,
    sizeBytes: photoRecord.sizeBytes,
    sizeKB: photoRecord.sizeKB,
    dataUrl: photoRecord.dataUrl,
    thumbDataUrl: photoRecord.thumbDataUrl,
    updatedAtMs: photoRecord.updatedAtMs,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    deviceId: getCloudDeviceId()
  });
}

async function getCommunityOfficePhotoFromCloud(photoId) {
  return getBuildingPhotoFromCloud(photoId);
}

async function deleteCommunityOfficePhotoFromCloud(photoId) {
  return deleteBuildingPhotoFromCloud(photoId);
}

function requestCommunityOfficePhotoFile(communityId) {
  if (!buildingPhotoInput) return;
  const community = getCommunityById(communityId || appData.activeCommunityId);
  if (!community) {
    alert("没有找到当前公寓社区");
    return;
  }
  pendingBuildingPhotoBuildingId = null;
  pendingCommunityOfficePhotoCommunityId = community.id;
  buildingPhotoInput.value = "";
  buildingPhotoInput.click();
}

async function handleCommunityOfficePhotoFileSelected(file, community) {
  if (!file || !community) return;
  updateLocationStatus("正在压缩办公室地址照片...", "info");

  try {
    const compressed = await compressBuildingPhotoFile(file);
    if (compressed.sizeBytes > BUILDING_PHOTO_MAX_BYTES) {
      throw new Error(`照片压缩后仍然超过 ${Math.round(BUILDING_PHOTO_MAX_BYTES / 1024)}KB，请换一张更简单的照片`);
    }

    const photoId = getCommunityOfficePhotoDocId(community.id);
    const now = Date.now();
    const photoRecord = {
      id: photoId,
      communityId: community.id,
      dataUrl: compressed.dataUrl,
      thumbDataUrl: compressed.thumbDataUrl,
      mimeType: BUILDING_PHOTO_MIME_TYPE,
      ext: BUILDING_PHOTO_EXT,
      width: compressed.width,
      height: compressed.height,
      sizeBytes: compressed.sizeBytes,
      sizeKB: compressed.sizeKB,
      updatedAtMs: now
    };

    await putLocalBuildingPhoto(photoRecord);

    let cloudSaved = false;
    try {
      await saveCommunityOfficePhotoToCloud(photoRecord);
      cloudSaved = true;
    } catch (cloudError) {
      console.warn("办公室地址照片云端保存失败：", cloudError);
    }

    community.officePhoto = {
      id: photoId,
      hasPhoto: true,
      thumbDataUrl: compressed.thumbDataUrl,
      mimeType: BUILDING_PHOTO_MIME_TYPE,
      ext: BUILDING_PHOTO_EXT,
      sizeKB: compressed.sizeKB,
      width: compressed.width,
      height: compressed.height,
      updatedAtMs: now
    };

    saveData();
    renderMap();
    updateLocationStatus(cloudSaved ? `办公室地址照片已保存，约 ${compressed.sizeKB}KB，并已同步云端` : `办公室地址照片已保存，约 ${compressed.sizeKB}KB；云端未成功，本机可用`, cloudSaved ? "success" : "warning");

    if (viewingCommunityOfficePhotoCommunityId === community.id) {
      openCommunityOfficePhotoViewer(community.id);
    }
  } catch (error) {
    console.error("保存办公室地址照片失败：", error);
    alert(error?.message || "保存办公室地址照片失败");
    updateLocationStatus("办公室地址照片保存失败", "error");
  } finally {
    pendingCommunityOfficePhotoCommunityId = null;
    if (buildingPhotoInput) buildingPhotoInput.value = "";
  }
}

function requestBuildingPhotoFile(buildingId) {
  if (!buildingPhotoInput) return;
  const building = getBuildingById(buildingId || selectedBuildingId);
  if (!building) {
    alert("请先选择一栋大楼");
    return;
  }
  pendingBuildingPhotoBuildingId = building.id;
  buildingPhotoInput.value = "";
  buildingPhotoInput.click();
}

async function handleBuildingPhotoFileSelected(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;

  if (pendingCommunityOfficePhotoCommunityId) {
    const community = getCommunityById(pendingCommunityOfficePhotoCommunityId);
    if (!community) return;
    await handleCommunityOfficePhotoFileSelected(file, community);
    return;
  }

  const building = getBuildingById(pendingBuildingPhotoBuildingId || selectedBuildingId || viewingBuildingPhotoBuildingId);
  if (!building) return;
  const community = getActiveCommunity();
  if (!community) return;

  updateLocationStatus("正在压缩大楼照片...", "info");

  try {
    const compressed = await compressBuildingPhotoFile(file);
    if (compressed.sizeBytes > BUILDING_PHOTO_MAX_BYTES) {
      throw new Error(`照片压缩后仍然超过 ${Math.round(BUILDING_PHOTO_MAX_BYTES / 1024)}KB，请换一张更简单的照片`);
    }

    const photoId = getBuildingPhotoDocId(community.id, building.id);
    const now = Date.now();
    const photoRecord = {
      id: photoId,
      communityId: community.id,
      buildingId: building.id,
      dataUrl: compressed.dataUrl,
      thumbDataUrl: compressed.thumbDataUrl,
      mimeType: BUILDING_PHOTO_MIME_TYPE,
      ext: BUILDING_PHOTO_EXT,
      width: compressed.width,
      height: compressed.height,
      sizeBytes: compressed.sizeBytes,
      sizeKB: compressed.sizeKB,
      updatedAtMs: now
    };

    await putLocalBuildingPhoto(photoRecord);

    let cloudSaved = false;
    try {
      await saveBuildingPhotoToCloud(photoRecord);
      cloudSaved = true;
    } catch (cloudError) {
      console.warn("大楼照片云端保存失败：", cloudError);
    }

    building.photo = {
      id: photoId,
      hasPhoto: true,
      thumbDataUrl: compressed.thumbDataUrl,
      mimeType: BUILDING_PHOTO_MIME_TYPE,
      ext: BUILDING_PHOTO_EXT,
      sizeKB: compressed.sizeKB,
      width: compressed.width,
      height: compressed.height,
      updatedAtMs: now
    };

    saveData();
    renderMap();
    if (selectedBuildingId === building.id) openBuildingPanel(building.id);
    updateLocationStatus(cloudSaved ? `大楼照片已保存为 JPG，约 ${compressed.sizeKB}KB，并已同步云端` : `大楼照片已保存为 JPG，约 ${compressed.sizeKB}KB；云端未成功，本机可用`, cloudSaved ? "success" : "warning");

    if (viewingBuildingPhotoBuildingId === building.id) {
      openBuildingPhotoViewer(building.id);
    }
  } catch (error) {
    console.error("保存大楼照片失败：", error);
    alert(error?.message || "保存大楼照片失败");
    updateLocationStatus("大楼照片保存失败", "error");
  } finally {
    pendingBuildingPhotoBuildingId = null;
    if (buildingPhotoInput) buildingPhotoInput.value = "";
  }
}

async function loadBuildingPhotoRecord(building) {
  const photo = getBuildingPhotoMeta(building);
  if (!photo?.id) return null;

  const localRecord = await getLocalBuildingPhoto(photo.id);
  if (localRecord?.dataUrl) return localRecord;

  try {
    const cloudRecord = await getBuildingPhotoFromCloud(photo.id);
    if (cloudRecord?.dataUrl) {
      await putLocalBuildingPhoto(cloudRecord);
      return cloudRecord;
    }
  } catch (error) {
    console.warn("读取云端大楼照片失败：", error);
  }

  return null;
}

async function loadCommunityOfficePhotoRecord(community) {
  const photo = getCommunityOfficePhotoMeta(community);
  if (!photo?.id) return null;

  const localRecord = await getLocalBuildingPhoto(photo.id);
  if (localRecord?.dataUrl) return localRecord;

  try {
    const cloudRecord = await getCommunityOfficePhotoFromCloud(photo.id);
    if (cloudRecord?.dataUrl) {
      await putLocalBuildingPhoto(cloudRecord);
      return cloudRecord;
    }
  } catch (error) {
    console.warn("读取云端办公室地址照片失败：", error);
  }
  return null;
}

function makeSafePhotoDownloadName(value) {
  const base = String(value || "公寓社区")
    .trim()
    .replace(/[\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 80) || "公寓社区";
  return `${base}-办公室地址照片.jpg`;
}

function dataUrlToBlob(dataUrl) {
  const text = String(dataUrl || "");
  const match = text.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) return null;
  const mime = match[1] || BUILDING_PHOTO_MIME_TYPE || "image/jpeg";
  const isBase64 = !!match[2];
  const body = match[3] || "";
  if (isBase64) {
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(body)], { type: mime });
}

async function saveOrShareCommunityOfficePhoto(communityId) {
  const community = getCommunityById(communityId || appData.activeCommunityId);
  if (!community || !getCommunityOfficePhotoMeta(community)) {
    updateLocationStatus("当前公寓社区还没有办公室地址照片", "warning");
    return false;
  }

  updateLocationStatus("正在准备保存/分享办公室地址照片...", "info");
  try {
    const record = await loadCommunityOfficePhotoRecord(community);
    if (!record?.dataUrl) {
      throw new Error("没有读取到完整办公室地址照片");
    }

    const fileName = makeSafePhotoDownloadName(community.name);
    const blob = dataUrlToBlob(record.dataUrl);
    if (!blob) throw new Error("照片格式无法识别");
    const file = new File([blob], fileName, { type: blob.type || BUILDING_PHOTO_MIME_TYPE || "image/jpeg" });

    const canUseShare = typeof navigator !== "undefined"
      && typeof navigator.share === "function"
      && typeof navigator.canShare === "function"
      && navigator.canShare({ files: [file] });

    if (canUseShare) {
      await navigator.share({
        title: `${String(community.name || "公寓社区")} 办公室地址照片`,
        text: "请选择“保存到设备 / 保存图片 / Google 相册”等选项。",
        files: [file]
      });
      updateLocationStatus("已打开系统分享面板，可选择保存到图片/相册", "success");
      return true;
    }

    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.rel = "noopener";
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1200);
    }

    updateLocationStatus("当前浏览器不支持系统分享，已改为下载文件", "warning");
    return true;
  } catch (error) {
    if (error?.name === "AbortError") {
      updateLocationStatus("你已取消保存/分享办公室地址照片", "warning");
      return false;
    }
    console.error("保存/分享办公室地址照片失败：", error);
    alert(error?.message || "保存/分享办公室地址照片失败");
    updateLocationStatus("办公室地址照片保存/分享失败", "error");
    return false;
  }
}

function makeSafeBuildingPhotoDownloadName(building) {
  const community = getActiveCommunity();
  const base = String(getBuildingDisplayName(building, community) || "大楼")
    .trim()
    .replace(/[\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 80) || "大楼";
  return `${base}-大楼照片.jpg`;
}

async function saveOrShareBuildingPhoto(buildingId) {
  const building = getBuildingById(buildingId || selectedBuildingId);
  if (!building || !getBuildingPhotoMeta(building)) {
    updateLocationStatus("当前大楼还没有照片", "warning");
    return false;
  }

  updateLocationStatus("正在准备保存/分享大楼照片...", "info");
  try {
    const record = await loadBuildingPhotoRecord(building);
    if (!record?.dataUrl) {
      throw new Error("没有读取到完整大楼照片");
    }

    const fileName = makeSafeBuildingPhotoDownloadName(building);
    const blob = dataUrlToBlob(record.dataUrl);
    if (!blob) throw new Error("照片格式无法识别");
    const file = new File([blob], fileName, { type: blob.type || BUILDING_PHOTO_MIME_TYPE || "image/jpeg" });

    const canUseShare = typeof navigator !== "undefined"
      && typeof navigator.share === "function"
      && typeof navigator.canShare === "function"
      && navigator.canShare({ files: [file] });

    if (canUseShare) {
      await navigator.share({
        title: `${getBuildingPhotoTitle(building)}`,
        text: "请选择“保存到设备 / 保存图片 / Google 相册”等选项。",
        files: [file]
      });
      updateLocationStatus("已打开系统分享面板，可选择保存到图片/相册", "success");
      return true;
    }

    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.rel = "noopener";
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1200);
    }

    updateLocationStatus("当前浏览器不支持系统分享，已改为下载文件", "warning");
    return true;
  } catch (error) {
    if (error?.name === "AbortError") {
      updateLocationStatus("你已取消保存/分享大楼照片", "warning");
      return false;
    }
    console.error("保存/分享大楼照片失败：", error);
    alert(error?.message || "保存/分享大楼照片失败");
    updateLocationStatus("大楼照片保存/分享失败", "error");
    return false;
  }
}

function openApartmentPhotoActionPopup(marker, community, building) {
  if (!marker || !community) return;
  const latlng = typeof marker.getLatLng === "function" ? marker.getLatLng() : null;
  if (!latlng) return;

  const wrap = document.createElement("div");
  wrap.className = "building-photo-action-popup";

  const heading = document.createElement("div");
  heading.className = "building-photo-action-title";
  heading.innerText = "照片管理";
  wrap.appendChild(heading);

  const communityLabel = document.createElement("div");
  communityLabel.className = "building-photo-action-title";
  communityLabel.style.fontSize = "12px";
  communityLabel.style.marginTop = "4px";
  communityLabel.innerText = `${community.name || "公寓社区"} · 应用到整个公寓群`;
  wrap.appendChild(communityLabel);

  const hasCommunityPhoto = !!getCommunityOfficePhotoMeta(community);
  if (hasCommunityPhoto) {
    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "photo-action-secondary";
    viewBtn.innerText = "📷 查看公寓群照片";
    viewBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      map.closePopup();
      openCommunityOfficePhotoViewer(community.id);
    });
    wrap.appendChild(viewBtn);

    const shareBtn = document.createElement("button");
    shareBtn.type = "button";
    shareBtn.className = "photo-action-secondary";
    shareBtn.innerText = "📥 保存 / 分享公寓群照片";
    shareBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      map.closePopup();
      await saveOrShareCommunityOfficePhoto(community.id);
    });
    wrap.appendChild(shareBtn);
  }

  const addCommunityBtn = document.createElement("button");
  addCommunityBtn.type = "button";
  addCommunityBtn.className = "photo-action-primary";
  addCommunityBtn.innerText = hasCommunityPhoto ? "更换公寓群照片" : "＋ 添加公寓群照片";
  addCommunityBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    map.closePopup();
    requestCommunityOfficePhotoFile(community.id);
  });
  wrap.appendChild(addCommunityBtn);

  if (building) {
    const buildingLabel = document.createElement("div");
    buildingLabel.className = "building-photo-action-title";
    buildingLabel.style.fontSize = "12px";
    buildingLabel.style.marginTop = "10px";
    buildingLabel.innerText = `${getBuildingDisplayName(building, community)} · 只应用到当前大楼`;
    wrap.appendChild(buildingLabel);

    const hasBuildingPhoto = !!getBuildingPhotoMeta(building);
    if (hasBuildingPhoto) {
      const viewBuildingBtn = document.createElement("button");
      viewBuildingBtn.type = "button";
      viewBuildingBtn.className = "photo-action-secondary";
      viewBuildingBtn.innerText = "📷 查看本楼照片";
      viewBuildingBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        map.closePopup();
        openBuildingPhotoViewer(building.id);
      });
      wrap.appendChild(viewBuildingBtn);

      const shareBuildingBtn = document.createElement("button");
      shareBuildingBtn.type = "button";
      shareBuildingBtn.className = "photo-action-secondary";
      shareBuildingBtn.innerText = "📥 保存 / 分享本楼照片";
      shareBuildingBtn.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        map.closePopup();
        await saveOrShareBuildingPhoto(building.id);
      });
      wrap.appendChild(shareBuildingBtn);
    }

    const addBuildingBtn = document.createElement("button");
    addBuildingBtn.type = "button";
    addBuildingBtn.className = "photo-action-primary";
    addBuildingBtn.innerText = hasBuildingPhoto ? "更换本楼照片" : "＋ 添加本楼照片";
    addBuildingBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      map.closePopup();
      requestBuildingPhotoFile(building.id);
    });
    wrap.appendChild(addBuildingBtn);
  }

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "photo-action-cancel";
  cancelBtn.innerText = "取消";
  cancelBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    map.closePopup();
  });
  wrap.appendChild(cancelBtn);

  L.popup({
    closeButton: true,
    autoPan: true,
    className: "building-photo-action-popup-shell",
    offset: [0, -10]
  }).setLatLng(latlng).setContent(wrap).openOn(map);
}

async function openCommunityOfficePhotoViewer(communityId) {
  const community = getCommunityById(communityId || appData.activeCommunityId);
  if (!community || !buildingPhotoViewer || !buildingPhotoViewerImage) return;

  viewingBuildingPhotoBuildingId = null;
  viewingCommunityOfficePhotoCommunityId = community.id;
  if (buildingPhotoViewerTitle) buildingPhotoViewerTitle.innerText = getCommunityOfficePhotoTitle(community);
  buildingPhotoViewerImage.alt = "公寓办公室地址照片";
  buildingPhotoViewerImage.removeAttribute("src");
  buildingPhotoViewer.classList.add("is-open");
  buildingPhotoViewer.setAttribute("aria-hidden", "false");
  updateLocationStatus("正在读取办公室地址照片...", "info");

  const record = await loadCommunityOfficePhotoRecord(community);
  if (!record?.dataUrl) {
    updateLocationStatus("没有找到这个公寓社区的办公室地址照片，可重新添加", "warning");
    buildingPhotoViewerImage.removeAttribute("src");
    return;
  }

  buildingPhotoViewerImage.src = record.dataUrl;
  updateLocationStatus("已打开办公室地址照片", "success");
}

async function openBuildingPhotoViewer(buildingId) {
  const building = getBuildingById(buildingId || selectedBuildingId);
  if (!building || !buildingPhotoViewer || !buildingPhotoViewerImage) return;

  viewingCommunityOfficePhotoCommunityId = null;
  viewingBuildingPhotoBuildingId = building.id;
  if (buildingPhotoViewerTitle) buildingPhotoViewerTitle.innerText = getBuildingPhotoTitle(building);
  buildingPhotoViewerImage.alt = "大楼照片";
  buildingPhotoViewerImage.removeAttribute("src");
  buildingPhotoViewer.classList.add("is-open");
  buildingPhotoViewer.setAttribute("aria-hidden", "false");
  updateLocationStatus("正在读取大楼照片...", "info");

  const record = await loadBuildingPhotoRecord(building);
  if (!record?.dataUrl) {
    updateLocationStatus("没有找到这栋大楼的完整照片，可重新添加", "warning");
    buildingPhotoViewerImage.removeAttribute("src");
    return;
  }

  buildingPhotoViewerImage.src = record.dataUrl;
  updateLocationStatus("已打开大楼照片", "success");
}

function closeBuildingPhotoViewer() {
  if (!buildingPhotoViewer) return;
  buildingPhotoViewer.classList.remove("is-open");
  buildingPhotoViewer.setAttribute("aria-hidden", "true");
  viewingBuildingPhotoBuildingId = null;
  viewingCommunityOfficePhotoCommunityId = null;
}

function replaceCurrentBuildingPhoto() {
  if (viewingCommunityOfficePhotoCommunityId) {
    requestCommunityOfficePhotoFile(viewingCommunityOfficePhotoCommunityId);
    return;
  }
  requestBuildingPhotoFile(viewingBuildingPhotoBuildingId || selectedBuildingId);
}

async function deleteCurrentBuildingPhoto() {
  if (viewingCommunityOfficePhotoCommunityId) {
    const community = getCommunityById(viewingCommunityOfficePhotoCommunityId);
    if (!community || !getCommunityOfficePhotoMeta(community)) return;
    if (!confirm("确定删除这个公寓社区的办公室地址照片吗？")) return;
    const photoId = community.officePhoto.id;
    try {
      await deleteLocalBuildingPhoto(photoId);
      try {
        await deleteCommunityOfficePhotoFromCloud(photoId);
      } catch (cloudError) {
        console.warn("删除云端办公室地址照片失败：", cloudError);
      }
      delete community.officePhoto;
      saveData();
      renderMap();
      closeBuildingPhotoViewer();
      updateLocationStatus("已删除办公室地址照片", "success");
    } catch (error) {
      console.error("删除办公室地址照片失败：", error);
      alert("删除办公室地址照片失败");
    }
    return;
  }

  const building = getBuildingById(viewingBuildingPhotoBuildingId || selectedBuildingId);
  if (!building || !getBuildingPhotoMeta(building)) return;
  if (!confirm("确定删除这栋大楼照片吗？同一栋楼的小号码右上角缩略图也会一起消失。")) return;

  const photoId = building.photo.id;
  try {
    await deleteLocalBuildingPhoto(photoId);
    try {
      await deleteBuildingPhotoFromCloud(photoId);
    } catch (cloudError) {
      console.warn("删除云端大楼照片失败：", cloudError);
    }
    delete building.photo;
    saveData();
    renderMap();
    if (selectedBuildingId === building.id) openBuildingPanel(building.id);
    closeBuildingPhotoViewer();
    updateLocationStatus("已删除大楼照片", "success");
  } catch (error) {
    console.error("删除大楼照片失败：", error);
    alert("删除大楼照片失败");
  }
}

function openCommunityOfficePhotoActionPopup(marker, community) {
  if (!marker || !community) return;
  const hasPhoto = !!getCommunityOfficePhotoMeta(community);
  const wrap = document.createElement("div");
  wrap.className = "building-photo-action-popup";

  const heading = document.createElement("div");
  heading.className = "building-photo-action-title";
  heading.innerText = `${community.name || "公寓社区"} · 办公室地址照片`;
  wrap.appendChild(heading);

  if (hasPhoto) {
    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "photo-action-secondary";
    viewBtn.innerText = "📷 查看办公室地址照片";
    viewBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      map.closePopup();
      openCommunityOfficePhotoViewer(community.id);
    });
    wrap.appendChild(viewBtn);

    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "photo-action-secondary";
    downloadBtn.innerText = "📥 保存 / 分享照片";
    downloadBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      map.closePopup();
      await saveOrShareCommunityOfficePhoto(community.id);
    });
    wrap.appendChild(downloadBtn);
  }

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "photo-action-primary";
  addBtn.innerText = hasPhoto ? "更换办公室地址照片" : "＋ 添加办公室地址照片";
  addBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    map.closePopup();
    requestCommunityOfficePhotoFile(community.id);
  });
  wrap.appendChild(addBtn);

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "photo-action-cancel";
  cancelBtn.innerText = "取消";
  cancelBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    map.closePopup();
  });
  wrap.appendChild(cancelBtn);

  const latlng = typeof marker.getLatLng === "function" ? marker.getLatLng() : null;
  if (!latlng) return;

  L.popup({
    closeButton: true,
    autoPan: true,
    className: "building-photo-action-popup-shell",
    offset: [0, -12]
  }).setLatLng(latlng).setContent(wrap).openOn(map);
}

function openBuildingPhotoActionPopup(marker, building) {
  if (!marker || !building) return;
  const hasPhoto = !!getBuildingPhotoMeta(building);
  const title = getBuildingPhotoTitle(building);
  const wrap = document.createElement("div");
  wrap.className = "building-photo-action-popup";

  const heading = document.createElement("div");
  heading.className = "building-photo-action-title";
  heading.innerText = title;
  wrap.appendChild(heading);

  if (hasPhoto) {
    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "photo-action-secondary";
    viewBtn.innerText = "📷 查看大楼照片";
    viewBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      map.closePopup();
      openBuildingPhotoViewer(building.id);
    });
    wrap.appendChild(viewBtn);
  }

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "photo-action-primary";
  addBtn.innerText = hasPhoto ? "更换大楼照片" : "＋ 添加大楼照片";
  addBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    map.closePopup();
    requestBuildingPhotoFile(building.id);
  });
  wrap.appendChild(addBtn);

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "photo-action-cancel";
  cancelBtn.innerText = "取消";
  cancelBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    map.closePopup();
  });
  wrap.appendChild(cancelBtn);

  const latlng = typeof marker.getLatLng === "function" ? marker.getLatLng() : null;
  if (!latlng) return;

  L.popup({
    closeButton: true,
    autoPan: true,
    className: "building-photo-action-popup-shell",
    offset: [0, -8]
  })
    .setLatLng(latlng)
    .setContent(wrap)
    .openOn(map);
}

function getPositionMarkerStyle(building, position) {
  let size = clampMarkerSizeValue(Number(position?.size) || Number(building?.size) || markerSize, markerSize);
  let currentFontSize = clampFontSizeValue(Number(position?.fontSize) || Number(building?.fontSize) || fontSize, fontSize);

  // 只增强手机端公寓号码小标记的可读性，不影响楼栋大牌、当前公寓名牌和定位指南针。
  if (isMobileKeypadOnlyMode()) {
    size = Math.max(size, MOBILE_DEFAULT_MARKER_SIZE);
    currentFontSize = Math.max(currentFontSize, MOBILE_DEFAULT_FONT_SIZE);
  }

  return {
    size,
    fontSize: currentFontSize,
    color: position?.color || building?.color || markerColor,
    shape: position?.shape || building?.shape || markerShape
  };
}

function renderCommunitySearchPositions() {
  const community = getCommunityById(communitySearchCommunityId || appData.activeCommunityId);
  if (!community) return;

  const visibleTargets = sortDeliveryTargets((Array.isArray(communitySearchTargets) ? communitySearchTargets : [])
    .filter((target) => {
      const key = getDeliveryTargetKey(target);
      return !deliveryDeliveredKeys.has(key) && !deliveryCancelledKeys.has(key);
    }));

  const orderedTargets = visibleTargets;

  orderedTargets.forEach((target) => {
    const building = (community.buildings || []).find((item) => item.id === target.buildingId);
    if (!building) return;
    const item = (building.positions || []).find((position) => position.id === target.positionId || String(position.position) === String(target.position));
    if (!item) return;

    const markerExtraClass = isGroupFullCommunity(community) ? "group-position-marker" : isFlatCommunity(community) ? "flat-marker" : "position-marker";
    const displayNumber = target.label || getPositionDisplayNumber(community, building, item);
    const marker = L.marker([item.lat, item.lng], {
      icon: (() => {
        const style = getPositionMarkerStyle(building, item);
        return createNumberIcon(displayNumber, style.size, style.fontSize, style.color, style.shape, markerExtraClass, getApartmentMarkerPhotoThumb(community, building));
      })(),
      draggable: canEditMapMarkers(),
      riseOnHover: true
    }).addTo(map);

    marker.bindTooltip(`${community.name} / ${displayNumber}`, {
      direction: "top",
      offset: [0, -12]
    });

    let positionDragStartLatLng = null;
    marker.on("dragstart", () => {
      positionDragStartLatLng = marker.getLatLng();
      pushHistory();
    });
    marker.on("dragend", () => {
      const latlng = marker.getLatLng();
      applyPositionDragWithPhysicalGroup(building, item, positionDragStartLatLng, latlng);
      positionDragStartLatLng = null;
      saveData();
      renderMap();
    });

    marker.on("click", (event) => {
      if (isMobileKeypadOnlyMode() && !mobileEditMode && displayMode === "communitySearch") {
        if (event?.originalEvent && L?.DomEvent?.stop) L.DomEvent.stop(event.originalEvent);
        openDeliveryActionPopup(marker, target);
        return;
      }
      marker.openTooltip();
    });
    marker.on("contextmenu", (event) => {
      if (isMobileKeypadOnlyMode() && !mobileEditMode) {
        if (event?.originalEvent && L?.DomEvent?.stop) L.DomEvent.stop(event.originalEvent);
        openApartmentPhotoActionPopup(marker, community, building);
        return;
      }
      if (canEditMapMarkers()) deleteSinglePositionFromBuilding(building.id, item.position);
    });

    renderedMarkers.push(marker);
  });
}

function fitCommunityBuildingsIntoMap(community) {
  if (!map || !community) return;

  const points = [];

  (Array.isArray(community.buildings) ? community.buildings : []).forEach((building) => {
    const buildingLat = Number(building.lat);
    const buildingLng = Number(building.lng);

    if (Number.isFinite(buildingLat) && Number.isFinite(buildingLng)) {
      points.push([buildingLat, buildingLng]);
    }

    (Array.isArray(building.positions) ? building.positions : []).forEach((position) => {
      const lat = Number(position.lat);
      const lng = Number(position.lng);

      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        points.push([lat, lng]);
      }
    });
  });

  if (points.length === 0) {
    const center = getCommunityCardLatLng(community);
    if (Array.isArray(center) && Number.isFinite(center[0]) && Number.isFinite(center[1])) {
      map.setView(center, Math.max(map.getZoom(), 18), { animate: true });
    }
    return;
  }

  if (points.length === 1) {
    map.setView(points[0], Math.max(map.getZoom(), 18), { animate: true });
    return;
  }

  const bounds = L.latLngBounds(points);
  if (!bounds.isValid()) return;

  map.fitBounds(bounds, {
    animate: true,
    paddingTopLeft: isMobileKeypadOnlyMode() ? [28, 108] : [42, 70],
    paddingBottomRight: isMobileKeypadOnlyMode() ? [88, 160] : [42, 70],
    maxZoom: 18
  });
}

function openCommunityBuildings(communityId) {
  if (!communityId) return;
  const community = getCommunityById(communityId);
  if (!community) return;
  if (blockRouteInterrupt("打开或切换公寓群")) return;

  appData.activeCommunityId = community.id;
  communitySearchCommunityId = community.id;
  communitySearchTargets = [];
  deliveryDeliveredKeys = new Set();
  deliveryCancelledKeys = new Set();
  deliveryPendingPanelOpen = false;
  deliveryDeliveredPanelOpen = false;
  selectedBuildingId = null;
  selectedPositions.clear();
  displayMode = "buildings";
  saveData();
  closeBuildingPanel();
  renderCommunitySelector();
  renderMap();

  // 点击公寓名牌后，把视野重新框到这个公寓自己的楼栋/号码范围。
  // 否则名牌坐标和楼栋坐标不一致时，手机端会出现空白地图。
  fitCommunityBuildingsIntoMap(community);

  // 点击公寓名牌后：地图显示大楼号，同时保留底部号码搜索框。
  if (communitySearchTitle) communitySearchTitle.innerText = community.name || "公寓群";
  if (communitySearchHint) communitySearchHint.innerText = "可直接输入完整公寓号搜索；支持数字和字母 A-Z（如 A、F、A-G）；地图上也可点击大楼号查看。";
  if (communityNumberSearchInput) {
    configureMobileSearchInputKeyboard();
    communityNumberSearchInput.value = "";
    if (!isMobileKeypadOnlyMode()) {
      setTimeout(() => communityNumberSearchInput.focus(), 80);
    }
  }
  if (communitySearchPanel) communitySearchPanel.classList.add("is-open");

  updateLocationStatus(`已显示 ${community.name} 的大楼标记；也可以在下方搜索完整公寓号码`, "success");
}

function renderCommunityCards() {
  const nearby = getNearbyCommunities(3);
  const active = getActiveCommunity();
  const communities = [...nearby];
  if (active && !communities.some((item) => item.id === active.id)) communities.unshift(active);

  communities.forEach((community) => {
    const center = getCommunityCardLatLng(community);
    const marker = L.marker(center, {
      icon: createCommunityCardIcon(community),
      draggable: canEditMapMarkers(),
      riseOnHover: true
    }).addTo(map);

    marker.on("click", () => {
      if (isMobileKeypadOnlyMode() && mobileEditMode) {
        openCommunityOfficePhotoActionPopup(marker, community);
        return;
      }
      openCommunityBuildings(community.id);
    });
    marker.on("dragstart", pushHistory);
    marker.on("dragend", () => {
      const latlng = marker.getLatLng();
      community.lat = latlng.lat;
      community.lng = latlng.lng;
      saveData();
      renderCommunitySelector();
    });
    marker.on("contextmenu", () => {
      if (canEditMapMarkers()) deleteCommunityById(community.id);
    });

    renderedMarkers.push(marker);
  });
}

function renderFlatNumbers(community) {
  const flatBuilding = community.buildings.find((building) => building.name === "独立编号");
  if (!flatBuilding) return;

  getSortedPositions(flatBuilding).forEach((item) => {
    const marker = L.marker([item.lat, item.lng], {
      icon: (() => {
        const style = getPositionMarkerStyle(flatBuilding, item);
        return createNumberIcon(item.position, style.size, style.fontSize, style.color, style.shape, "flat-marker", getApartmentMarkerPhotoThumb(community, flatBuilding));
      })(),
      draggable: canEditMapMarkers(),
      riseOnHover: true
    }).addTo(map);

    marker.bindTooltip(`独立编号 ${item.position}`, {
      direction: "top",
      offset: [0, -12]
    });

    marker.on("dragstart", pushHistory);
    marker.on("dragend", () => {
      const latlng = marker.getLatLng();
      item.lat = latlng.lat;
      item.lng = latlng.lng;
      saveData();
    });

    marker.on("click", () => marker.openTooltip());
    marker.on("contextmenu", (event) => {
      if (isMobileKeypadOnlyMode() && !mobileEditMode) {
        if (event?.originalEvent && L?.DomEvent?.stop) L.DomEvent.stop(event.originalEvent);
        openApartmentPhotoActionPopup(marker, community, flatBuilding);
        return;
      }
      if (canEditMapMarkers()) deleteSinglePositionFromBuilding(flatBuilding.id, item.position);
    });

    renderedMarkers.push(marker);
  });
}

function renderBuildings() {
  const community = getActiveCommunity();
  getSortedBuildings().forEach((building) => {
    const isUniversal = normalizeCommunityType(community?.type) === "universal";
    const markerClass = isGroupFullCommunity(community) ? "group-marker" : isTwoFloorSuffixCommunity(community) ? "twofloor-marker" : isUniversal ? "universal-building-marker" : "building-marker";
    const markerLabel = isUniversal ? (building.name === "独立" ? "独立" : building.name) : building.name;
    const marker = L.marker([building.lat, building.lng], {
      icon: isGroupFullCommunity(community)
        ? createGroupIcon(building, building.size || 34, building.fontSize || 12, building.color || "#1479e8")
        : createNumberIcon(markerLabel, isUniversal ? Math.max(30, building.size || 16) : building.size || 16, isUniversal ? Math.max(13, building.fontSize || 8) : building.fontSize || 8, building.color || "#1479e8", isUniversal ? "circle" : building.shape || "circle", markerClass),
      draggable: canEditMapMarkers(),
      riseOnHover: true
    }).addTo(map);

    let buildingDragStartLatLng = null;
    marker.on("click", () => openBuildingPanel(building.id));
    marker.on("dragstart", () => {
      buildingDragStartLatLng = marker.getLatLng();
      pushHistory();
    });
    marker.on("dragend", () => {
      const latlng = marker.getLatLng();
      const oldLat = Number(buildingDragStartLatLng?.lat ?? building.lat);
      const oldLng = Number(buildingDragStartLatLng?.lng ?? building.lng);
      const deltaLat = Number(latlng.lat) - oldLat;
      const deltaLng = Number(latlng.lng) - oldLng;

      building.lat = latlng.lat;
      building.lng = latlng.lng;

      // 拖动大楼牌/号码范围牌时，里面的小号码作为一组一起移动。
      // 已经叠在一起的小号码会继续保持叠放状态，只是整体换位置。
      if (Number.isFinite(deltaLat) && Number.isFinite(deltaLng)) {
        (Array.isArray(building.positions) ? building.positions : []).forEach((position) => {
          position.lat = Number(position.lat) + deltaLat;
          position.lng = Number(position.lng) + deltaLng;
        });
      }

      buildingDragStartLatLng = null;
      saveData();
    });
    marker.on("contextmenu", () => {
      if (canEditMapMarkers()) deleteBuildingOrGroupById(building.id);
    });

    renderedMarkers.push(marker);
  });
}

function renderSelectedPositions(building) {
  const community = getActiveCommunity();
  const positions = getSortedPositions(building).filter((item) => selectedPositions.has(item.position));
  // 当批量生成的号码初始位于同一经纬度时，Leaflet 后添加的 marker 会盖在最上面。
  // 这里在“楼组完整号码”模式下按倒序渲染，这样最小号码（如 101）会在最上层，
  // 用户拖走 101 后，接着就能按顺序拖 102、103……
  const shouldRenderSmallNumberOnTop = isGroupFullCommunity() || normalizeCommunityType(getActiveCommunity()?.type) === "universal";
  const renderOrder = shouldRenderSmallNumberOnTop
    ? [...positions].reverse()
    : positions;

  renderOrder.forEach((item) => {
    const markerExtraClass = isGroupFullCommunity() ? "group-position-marker" : "position-marker";
    const marker = L.marker([item.lat, item.lng], {
      icon: (() => {
        const style = getPositionMarkerStyle(building, item);
        return createNumberIcon(item.position, style.size, style.fontSize, style.color, style.shape, markerExtraClass, getApartmentMarkerPhotoThumb(getActiveCommunity(), building));
      })(),
      draggable: canEditMapMarkers(),
      riseOnHover: true
    }).addTo(map);

    const tooltipText = isFlatCommunity()
      ? `独立编号 ${item.position}`
      : isGroupFullCommunity()
      ? `${building.name} / ${item.position}`
      : isTwoFloorSuffixCommunity()
      ? `${building.name}号 / ${item.position}楼`
      : `${getBuildingDisplayName(building)} / ${item.position}`;

    marker.bindTooltip(tooltipText, {
      direction: "top",
      offset: [0, -12]
    });

    let positionDragStartLatLng = null;
    marker.on("dragstart", () => {
      positionDragStartLatLng = marker.getLatLng();
      pushHistory();
    });
    marker.on("dragend", () => {
      const latlng = marker.getLatLng();
      applyPositionDragWithPhysicalGroup(building, item, positionDragStartLatLng, latlng);
      positionDragStartLatLng = null;
      saveData();
      renderMap();
    });

    marker.on("click", () => marker.openTooltip());
    marker.on("contextmenu", (event) => {
      if (isMobileKeypadOnlyMode() && !mobileEditMode) {
        if (event?.originalEvent && L?.DomEvent?.stop) L.DomEvent.stop(event.originalEvent);
        openApartmentPhotoActionPopup(marker, community, building);
        return;
      }
      if (canEditMapMarkers()) deleteSinglePositionFromBuilding(building.id, item.position);
    });

    renderedMarkers.push(marker);
  });

  updateLocationStatus(isGroupFullCommunity() ? `已展开 ${building.name} 的 ${positions.length} 个号码，可以拖动微调` : isFlatCommunity() ? `只显示选中的 ${positions.length} 个独立编号` : isTwoFloorSuffixCommunity() ? `只显示 ${building.name}号的 ${positions.length} 个楼层` : `只显示 ${getBuildingDisplayName(building)} 的 ${positions.length} 个号码`, "success");
}


function attachRightClickOrLongPressDelete(element, onDelete) {
  if (!element || typeof onDelete !== "function") return;

  const guardedDelete = (event) => {
    if (!canEditMapMarkers()) {
      if (event && event.preventDefault) event.preventDefault();
      updateLocationStatus("送包裹模式已锁定修改；需要删除请先进菜单开启编辑模式", "warning");
      return;
    }
    onDelete(event);
  };

  let pressTimer = null;
  const clearPressTimer = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };

  element.oncontextmenu = function (event) {
    event.preventDefault();
    guardedDelete(event);
  };

  element.ontouchstart = function () {
    clearPressTimer();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      guardedDelete();
    }, 650);
  };

  element.ontouchend = clearPressTimer;
  element.ontouchcancel = clearPressTimer;
  element.ontouchmove = clearPressTimer;
}

function deleteSinglePositionFromBuilding(buildingId, positionValue) {
  const building = getBuildingById(buildingId);
  if (!building) return;

  const item = building.positions.find((position) => position.position === positionValue);
  if (!item) return;

  const community = getActiveCommunity();
  const label = isGroupFullCommunity(community)
    ? `号码 ${item.position}`
    : isTwoFloorSuffixCommunity(community)
    ? `${building.name}号 / ${item.position}楼`
    : isFlatCommunity(community)
    ? `独立编号 ${item.position}`
    : `${getBuildingDisplayName(building, community)} / ${item.position}`;

  if (!confirm(`确定删除 ${label} 吗？`)) return;

  pushHistory();
  building.positions = building.positions.filter((position) => position.id !== item.id);
  selectedPositions.delete(item.position);

  if (community && building.positions.length === 0) {
    const deleteGroup = confirm(isGroupFullCommunity(community)
      ? `楼组 ${building.name} 里面已经没有号码，是否同时删除这个楼组？`
      : `这里已经没有号码，是否同时删除这个标记？`);
    if (deleteGroup) {
      community.buildings = community.buildings.filter((target) => target.id !== building.id);
      selectedBuildingId = null;
      closeBuildingPanel();
    }
  } else if (isGroupFullCommunity(community)) {
    refreshGroupBuildingDisplay(building);
  }

  saveData();
  renderMap();
  if (selectedBuildingId) openBuildingPanel(selectedBuildingId);
  updateLocationStatus(`已删除 ${label}`, "success");
}

function openBuildingPanel(buildingId) {
  const building = getBuildingById(buildingId);
  if (!building) return;

  selectedBuildingId = buildingId;
  attachRightClickOrLongPressDelete(buildingPanelTitle, () => deleteBuildingOrGroupById(buildingId));
  const community = getActiveCommunity();
  const bulkDeletePositionsBtn = document.getElementById("bulkDeletePositions");
  if (bulkDeletePositionsBtn) {
    if (isGroupFullCommunity(community)) {
      bulkDeletePositionsBtn.style.display = "";
      bulkDeletePositionsBtn.innerText = "批量删除";
    } else if (isFlatCommunity(community)) {
      bulkDeletePositionsBtn.style.display = "";
      bulkDeletePositionsBtn.innerText = "批量添加";
    } else {
      bulkDeletePositionsBtn.style.display = "none";
      bulkDeletePositionsBtn.innerText = "批量删除";
    }
  }

  if (isFlatCommunity(community)) {
    buildingPanelTitle.innerText = "独立编号";
    buildingPanelHint.innerText = "右击号码可直接删除；手机可长按号码触发删除";
    showSelectedPositions.innerText = "只显示选中";
    showAllPositions.innerText = "显示全部";
    restoreBuildings.innerText = "恢复楼栋";
    deleteSelectedPositions.innerText = "删除选中";
  } else if (isGroupFullCommunity(community)) {
    const groupTitle = getGroupDisplayLines(building).join(" / ");
    buildingPanelTitle.innerText = `楼组：${groupTitle}`;
    buildingPanelHint.innerText = "右击号码可删除单个号码；右击楼组标题或地图楼组标记可删除整个楼组";
    showSelectedPositions.innerText = "只显示选中号码";
    showAllPositions.innerText = "展开并微调号码";
    restoreBuildings.innerText = "保存并收起";
    deleteSelectedPositions.innerText = "删除选中号码";
  } else if (isTwoFloorSuffixCommunity(community)) {
    buildingPanelTitle.innerText = `${building.name}号`;
    buildingPanelHint.innerText = "选择 1楼 或 2楼；右击号码可直接删除";
    showSelectedPositions.innerText = "只显示选中";
    showAllPositions.innerText = "显示全部";
    restoreBuildings.innerText = "恢复楼栋";
    deleteSelectedPositions.innerText = "删除选中";
  } else {
    const displayName = getBuildingDisplayName(building, community);
    buildingPanelTitle.innerText = displayName;
    buildingPanelHint.innerText = "选择号码；右击号码可删除单个号码，右击标题或地图标记可删除这一组";
    showSelectedPositions.innerText = "只显示选中";
    showAllPositions.innerText = "显示全部";
    restoreBuildings.innerText = "恢复楼栋";
    deleteSelectedPositions.innerText = "删除选中";
  }
  positionList.innerHTML = "";
  positionList.classList.toggle("group-floor-layout", isGroupFullCommunity(community));

  updateBuildingPhotoButton(building);

  const positions = getSortedPositions(building);

  if (positions.length === 0) {
    positionList.innerHTML = `<div class="empty-position">这里还没有号码</div>`;
  }

  function createPanelNumberButton(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = isFlatCommunity(community) ? "position-btn flat-position-btn" : isGroupFullCommunity(community) ? "position-btn group-full-position-btn" : "position-btn";
    button.dataset.position = item.position;
    button.innerHTML = isGroupFullCommunity(community)
      ? `<strong>${item.position}</strong>`
      : isTwoFloorSuffixCommunity(community)
      ? `<strong>${item.position}楼</strong><small>${item.originals.join(", ")}</small>`
      : isFlatCommunity(community)
      ? `<strong>${item.position}</strong>`
      : `<strong>${item.position}</strong><small>${item.originals.join(", ")}</small>`;
    if (selectedPositions.has(item.position)) button.classList.add("is-selected");

    button.addEventListener("click", () => {
      if (selectedPositions.has(item.position)) {
        selectedPositions.delete(item.position);
        button.classList.remove("is-selected");
      } else {
        selectedPositions.add(item.position);
        button.classList.add("is-selected");
      }
    });

    attachRightClickOrLongPressDelete(button, () => deleteSinglePositionFromBuilding(building.id, item.position));

    return button;
  }

  function createPanelNumberItem(item) {
    return createPanelNumberButton(item);
  }

  if (isGroupFullCommunity(community) && positions.length > 0) {
    const floorGroups = new Map();

    positions.forEach((item) => {
      const text = String(item.position || "").trim();
      const floorKey = getGroupFullFloorKey(text) || "其他";
      if (!floorGroups.has(floorKey)) floorGroups.set(floorKey, []);
      floorGroups.get(floorKey).push(item);
    });

    Array.from(floorGroups.keys())
      .sort((a, b) => {
        if (a === "其他") return 1;
        if (b === "其他") return -1;
        return Number(a) - Number(b);
      })
      .forEach((floorKey) => {
        const floorColumn = document.createElement("section");
        floorColumn.className = "floor-column";

        const floorTitle = document.createElement("div");
        floorTitle.className = "floor-column-title";
        floorTitle.innerText = floorKey === "其他" ? "其他" : `${floorKey}楼`;
        floorColumn.appendChild(floorTitle);

        const floorGrid = document.createElement("div");
        floorGrid.className = "floor-number-grid";
        floorGroups.get(floorKey).forEach((item) => {
          floorGrid.appendChild(createPanelNumberItem(item));
        });
        floorColumn.appendChild(floorGrid);
        positionList.appendChild(floorColumn);
      });

    buildingPanel.classList.add("is-open");
    return;
  }

  if (normalizeCommunityType(community?.type) === "universal" && positions.some((item) => String(item?.universal?.physicalStackKey || "").trim())) {
    const physicalGroups = new Map();
    const independent = [];
    positions.forEach((item) => {
      const key = String(item?.universal?.physicalStackKey || "").trim();
      if (!key) {
        independent.push(item);
        return;
      }
      if (!physicalGroups.has(key)) physicalGroups.set(key, []);
      physicalGroups.get(key).push(item);
    });

    Array.from(physicalGroups.values())
      .sort((a, b) => String(a[0]?.position || "").localeCompare(String(b[0]?.position || ""), "zh-CN", { numeric: true }))
      .forEach((groupItems) => {
        const sortedGroupItems = [...groupItems].sort((a, b) => String(a.position).localeCompare(String(b.position), "zh-CN", { numeric: true }));
        const representative = String(sortedGroupItems[0]?.position || "");
        const section = document.createElement("section");
        section.className = "universal-physical-panel-group";

        const title = document.createElement("div");
        title.className = "universal-physical-panel-title";
        title.innerHTML = `<strong>物理位置 · ${representative}</strong><span>${sortedGroupItems.length} 个号码</span>`;
        section.appendChild(title);

        const grid = document.createElement("div");
        grid.className = "universal-physical-panel-grid";
        sortedGroupItems.forEach((item) => grid.appendChild(createPanelNumberItem(item)));
        section.appendChild(grid);
        positionList.appendChild(section);
      });

    if (independent.length) {
      const section = document.createElement("section");
      section.className = "universal-physical-panel-group is-independent";
      const title = document.createElement("div");
      title.className = "universal-physical-panel-title";
      title.innerHTML = `<strong>独立号码</strong><span>${independent.length} 个</span>`;
      section.appendChild(title);
      const grid = document.createElement("div");
      grid.className = "universal-physical-panel-grid";
      independent.forEach((item) => grid.appendChild(createPanelNumberItem(item)));
      section.appendChild(grid);
      positionList.appendChild(section);
    }

    buildingPanel.classList.add("is-open");
    return;
  }

  positions.forEach((item) => {
    positionList.appendChild(createPanelNumberItem(item));
  });

  buildingPanel.classList.add("is-open");
}

function closeBuildingPanel() {
  buildingPanel.classList.remove("is-open");
}

function showSelectedPositionsForCurrentBuilding() {
  if (!selectedBuildingId) return;
  const building = getBuildingById(selectedBuildingId);
  if (!building) return;

  if (selectedPositions.size === 0) {
    alert("请先选择至少一个位置号");
    return;
  }

  displayMode = "selected";
  closeBuildingPanel();
  renderMap();
}

function showAllPositionsForCurrentBuilding() {
  if (!selectedBuildingId) return;
  const building = getBuildingById(selectedBuildingId);
  if (!building) return;

  selectedPositions.clear();
  building.positions.forEach((item) => selectedPositions.add(item.position));
  displayMode = "selected";
  closeBuildingPanel();
  renderMap();
}

function restoreBuildingsMode() {
  if (displayMode === "selected") {
    displayMode = "buildings";
    selectedPositions.clear();
    closeBuildingPanel();
    renderMap();
    updateLocationStatus(isGroupFullCommunity() ? "已保存并收起楼组号码" : "已恢复楼栋显示", "info");
    return;
  }

  showCommunityCardsMode();
}

function deleteSelectedPositionsForCurrentBuilding() {
  if (!selectedBuildingId) {
    alert("请先打开一个楼组或楼栋");
    return;
  }

  const building = getBuildingById(selectedBuildingId);
  if (!building) return;

  if (selectedPositions.size === 0) {
    alert(isGroupFullCommunity() ? "请先选择要删除的号码" : "请先选择要删除的位置号");
    return;
  }

  const selectedList = Array.from(selectedPositions);
  const label = isGroupFullCommunity() ? "号码" : isTwoFloorSuffixCommunity() ? "楼层" : "位置号";
  if (!confirm(`确定删除选中的 ${selectedList.length} 个${label}吗？\n\n${selectedList.join(", ")}`)) return;

  pushHistory();
  const selectedSet = new Set(selectedList);
  building.positions = building.positions.filter((item) => !selectedSet.has(item.position));
  selectedPositions.clear();

  const community = getActiveCommunity();
  if (community && building.positions.length === 0) {
    const deleteEmpty = confirm(isGroupFullCommunity() ? `楼组 ${building.name} 已经没有号码，是否同时删除这个楼组？` : `这个楼栋已经没有位置号，是否同时删除这个楼栋？`);
    if (deleteEmpty) {
      community.buildings = community.buildings.filter((item) => item.id !== building.id);
      selectedBuildingId = null;
      closeBuildingPanel();
    }
  }

  saveData();
  renderMap();
  if (selectedBuildingId) openBuildingPanel(selectedBuildingId);
  updateLocationStatus(`已删除 ${selectedList.length} 个${label}`, "success");
}



function deleteCommunityById(communityId) {
  const community = appData.communities.find((item) => item.id === communityId);
  if (!community) return;

  const buildingCount = getCommunityBuildingCount(community);
  const numberCount = getCommunityNumberCount(community);
  const ok = confirm(`确定删除整个公寓群吗？

${community.name}
里面共有 ${buildingCount} 栋 / ${numberCount} 个号码，删除后可以用“撤”恢复上一步。`);
  if (!ok) return;

  pushHistory();
  appData.communities = appData.communities.filter((item) => item.id !== communityId);
  if (appData.activeCommunityId === communityId) {
    appData.activeCommunityId = appData.communities[0]?.id || null;
  }
  selectedBuildingId = null;
  selectedPositions.clear();
  displayMode = "communities";
  closeBuildingPanel();
  saveData();
  renderCommunitySelector();
  renderMap();
  updateLocationStatus(`已删除公寓群：${community.name}`, "success");
}

function deleteBuildingOrGroupById(buildingId) {
  const building = getBuildingById(buildingId);
  const community = getActiveCommunity();
  if (!building || !community) return;

  const label = isGroupFullCommunity(community)
    ? `楼组 ${getGroupDisplayLines(building).join(" / ")}`
    : isFlatCommunity(community)
    ? `当前公寓的全部独立编号`
    : isTwoFloorSuffixCommunity(community)
    ? `${building.name}号`
    : getBuildingDisplayName(building, community);

  const count = Array.isArray(building.positions) ? building.positions.length : 0;
  const ok = confirm(`确定一次性删除 ${label} 吗？\n\n里面共有 ${count} 个号码，删除后可以用“撤”恢复上一步。`);
  if (!ok) return;

  pushHistory();
  community.buildings = community.buildings.filter((item) => item.id !== building.id);
  selectedBuildingId = null;
  selectedPositions.clear();
  displayMode = "buildings";
  closeBuildingPanel();
  saveData();
  renderMap();
  renderCommunitySelector();
  updateLocationStatus(`已删除 ${label}`, "success");
}

function getFloorKeyForBulkDelete(numberText) {
  return getGroupFullFloorKey(numberText);
}

function getBulkDeleteTargetsFromInput(text, building) {
  const existing = new Set((building.positions || []).map((item) => String(item.position)));
  const targets = new Set();
  const rawText = String(text || "").trim();

  if (/^(全部|全删|all)$/i.test(rawText)) {
    existing.forEach((value) => targets.add(value));
    return Array.from(targets).sort((a, b) => Number(a) - Number(b));
  }

  const floorTokens = rawText.match(/(?:第\s*)?\d+\s*(?:楼|层)/g) || [];
  floorTokens.forEach((token) => {
    const match = token.match(/\d+/);
    if (!match) return;
    const floorKey = String(Number(match[0]));
    (building.positions || []).forEach((item) => {
      if (getFloorKeyForBulkDelete(item.position) === floorKey) targets.add(String(item.position));
    });
  });

  const textWithoutFloorWords = rawText.replace(/(?:第\s*)?\d+\s*(?:楼|层)/g, " ");
  expandNumberInput(textWithoutFloorWords).forEach((number) => {
    if (existing.has(number)) targets.add(number);
  });

  return Array.from(targets).sort((a, b) => Number(a) - Number(b));
}

function parseFlatBulkAddNumbers(text) {
  const rawText = String(text || "").trim();
  if (!rawText) return [];

  let normalized = normalizeChineseNumberText(rawText)
    .replace(/从/g, "")
    .replace(/号/g, "")
    .replace(/至|到/g, "-")
    .replace(/[~～—－]/g, "-");

  const simpleRange = normalized.match(/^\s*(\d+)\s*-\s*(\d+)\s*$/);
  if (simpleRange) normalized = `${simpleRange[1]}-${simpleRange[2]}`;

  return expandNumberInput(normalized)
    .filter((value) => /^\d+$/.test(value))
    .map((value) => String(Number(value)))
    .filter((value, index, array) => array.indexOf(value) === index)
    .sort((a, b) => Number(a) - Number(b));
}

function getFlatBulkAddLatLng(center, index, total) {
  const columns = Math.min(10, Math.ceil(Math.sqrt(Math.max(total, 1))));
  const row = Math.floor(index / columns);
  const col = index % columns;
  const rows = Math.ceil(total / columns);
  const gap = 24;

  if (map && typeof map.latLngToContainerPoint === "function" && typeof map.containerPointToLatLng === "function") {
    const point = map.latLngToContainerPoint(center);
    const x = point.x + (col - (columns - 1) / 2) * gap;
    const y = point.y + (row - (rows - 1) / 2) * gap;
    const latlng = map.containerPointToLatLng([x, y]);
    return { lat: latlng.lat, lng: latlng.lng };
  }

  return {
    lat: Number(center.lat) + row * 0.00002,
    lng: Number(center.lng) + col * 0.00002
  };
}

function findFlatCommunityByName(name) {
  const normalizedName = String(name || "").trim().toLowerCase();
  if (!normalizedName) return null;
  return (Array.isArray(appData.communities) ? appData.communities : []).find((community) =>
    normalizeCommunityType(community.type) === "flat" &&
    String(community.name || "").trim().toLowerCase() === normalizedName
  ) || null;
}

function getOrCreateFlatCommunityAtLatLng(name, latlng) {
  const communityName = String(name || "").trim();
  let community = findFlatCommunityByName(communityName);

  if (!community) {
    community = createCommunity(communityName, "flat", latlng);
  } else {
    community.type = "flat";
    community.lat = Number(latlng.lat);
    community.lng = Number(latlng.lng);
    appData.activeCommunityId = community.id;
  }

  return community;
}

function bulkAddFlatNumbersForCommunityAtLatLng(community, latlng, inputText = null) {
  if (!community) return;

  const input = inputText === null
    ? prompt(
      `请输入要一次生成的独立编号范围：\n\n可以输入：\n1-50\n1-100\n1 2 3 8 9\n1-20 35-50\n\n生成后会先排列在你刚才双击的位置附近，你可以一个一个拖到正确位置。`,
      "1-100"
    )
    : inputText;
  if (!input || !String(input).trim()) return;
  const numbers = parseFlatBulkAddNumbers(input);
  if (numbers.length === 0) {
    alert("没有识别到可添加的号码。请使用 1-50、1-100 或用空格分开的数字。");
    return;
  }

  if (numbers.length > 300) {
    alert("一次最多生成 300 个号码。请分批添加，避免地图太卡。");
    return;
  }

  let building = (community.buildings || []).find((item) => item.name === "独立编号");
  const existing = new Set((building?.positions || []).map((item) => String(item.position)));
  const toAdd = numbers.filter((number) => !existing.has(String(number)));
  const skipped = numbers.length - toAdd.length;

  if (toAdd.length === 0) {
    alert(`这些号码已经存在，没有新增。\n\n已存在：${numbers.join(", ")}`);
    return;
  }

  const preview = toAdd.length > 80 ? `${toAdd.slice(0, 80).join(", ")} ...` : toAdd.join(", ");
  const ok = confirm(
    `确定在“${community.name}”里批量添加 ${toAdd.length} 个独立编号吗？\n\n${preview}\n\n${skipped ? `其中 ${skipped} 个已存在，会自动跳过。\n\n` : ""}生成后会排列在刚才双击的位置附近，方便你逐个拖动。`
  );
  if (!ok) return;

  pushHistory();

  const center = latlng || (map && typeof map.getCenter === "function" ? map.getCenter() : { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1] });

  if (!building) {
    building = {
      id: makeId("building"),
      name: "独立编号",
      lat: center.lat,
      lng: center.lng,
      color: markerColor,
      size: markerSize,
      fontSize,
      shape: markerShape,
      positions: []
    };
    community.buildings.push(building);
  }

  toAdd.forEach((number, index) => {
    const pointLatLng = getFlatBulkAddLatLng(center, index, toAdd.length);
    building.positions.push({
      id: makeId("position"),
      position: String(number),
      lat: pointLatLng.lat,
      lng: pointLatLng.lng,
      originals: [String(number)]
    });
  });

  building.lat = center.lat;
  building.lng = center.lng;
  community.lat = center.lat;
  community.lng = center.lng;
  appData.activeCommunityId = community.id;
  selectedBuildingId = building.id;
  selectedPositions.clear();
  displayMode = "buildings";
  saveData();
  renderCommunitySelector();
  renderMap();
  openBuildingPanel(building.id);
  updateLocationStatus(`已在双击位置附近批量添加 ${toAdd.length} 个独立编号${skipped ? `，跳过 ${skipped} 个已存在号码` : ""}`, "success");
}

function bulkAddFlatNumbersForActiveCommunity(latlng = null) {
  const community = ensureActiveCommunity();

  if (!isFlatCommunity(community)) {
    alert("批量添加号码只用于“独立编号”模式。请先把当前公寓的编号模式设为“独立编号”。");
    return;
  }

  const center = latlng || (map && typeof map.getCenter === "function" ? map.getCenter() : { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1] });
  bulkAddFlatNumbersForCommunityAtLatLng(community, center);
}


function parseBuildingBulkAddNumbers(text, community) {
  const rawText = String(text || "").trim();
  if (!rawText) return [];

  let normalized = normalizeChineseNumberText(rawText)
    .replace(/从/g, "")
    .replace(/号楼/g, "")
    .replace(/楼/g, "")
    .replace(/号/g, "")
    .replace(/至|到/g, "-")
    .replace(/[~～—－]/g, "-");

  const seen = new Set();
  const parsedItems = [];

  expandNumberInput(normalized).forEach((number) => {
    const original = String(number).trim();
    const parsed = parseNumberByCommunity(original, community);
    if (!parsed) return;
    const key = `${parsed.building}:${parsed.position}:${parsed.original}`;
    if (seen.has(key)) return;
    seen.add(key);
    parsedItems.push(parsed);
  });

  return parsedItems;
}

function getBulkBuildingCenterLatLng(center, index, total) {
  const columns = Math.min(4, Math.ceil(Math.sqrt(Math.max(total, 1))));
  const row = Math.floor(index / columns);
  const col = index % columns;
  const rows = Math.ceil(total / columns);
  const gap = 44;

  if (map && typeof map.latLngToContainerPoint === "function" && typeof map.containerPointToLatLng === "function") {
    const point = map.latLngToContainerPoint(center);
    const x = point.x + (col - (columns - 1) / 2) * gap;
    const y = point.y + (row - (rows - 1) / 2) * gap;
    const latlng = map.containerPointToLatLng([x, y]);
    return { lat: latlng.lat, lng: latlng.lng };
  }

  return {
    lat: Number(center.lat) + row * 0.00004,
    lng: Number(center.lng) + col * 0.00004
  };
}


function getUniversalFloorRowLatLng(center, rowIndex, rowCount, columnIndex, columnCount, maxTextLength = 2) {
  const safeRowCount = Math.max(1, Number(rowCount) || 1);
  const safeColumnCount = Math.max(1, Number(columnCount) || 1);
  const safeTextLength = Math.max(1, Number(maxTextLength) || 1);
  const gapX = safeTextLength > 3 ? Math.max(34, 18 + safeTextLength * 8) : 24;
  const gapY = safeTextLength > 3 ? 32 : 28;

  if (map && typeof map.latLngToContainerPoint === "function" && typeof map.containerPointToLatLng === "function") {
    const point = map.latLngToContainerPoint(center);
    const x = point.x + (columnIndex - (safeColumnCount - 1) / 2) * gapX;
    const y = point.y + (rowIndex - (safeRowCount - 1) / 2) * gapY;
    const latlng = map.containerPointToLatLng([x, y]);
    return { lat: latlng.lat, lng: latlng.lng };
  }

  const lngGap = safeTextLength > 3 ? 0.000038 : 0.000025;
  const latGap = safeTextLength > 3 ? 0.00003 : 0.000025;
  return {
    lat: Number(center.lat) + (rowIndex - (safeRowCount - 1) / 2) * latGap,
    lng: Number(center.lng) + (columnIndex - (safeColumnCount - 1) / 2) * lngGap
  };
}

function getUniversalInitialPositionMap(center, itemsForBuilding) {
  const items = Array.isArray(itemsForBuilding) ? itemsForBuilding : [];
  const floorKeys = [];
  const floorGroups = new Map();

  items.forEach((item) => {
    const floorKey = String(item?.universal?.floor || "").trim();
    if (!floorGroups.has(floorKey)) {
      floorGroups.set(floorKey, []);
      floorKeys.push(floorKey);
    }
    floorGroups.get(floorKey).push(item);
  });

  const positionMap = new Map();
  const hasRealFloorRows = floorKeys.some((key) => key !== "");

  // 大楼 + 号码、只有号码：没有楼层时，全部号码默认叠在同一个点。
  // 这样不会铺满屏幕，用户可以按顺序一个个拖开。
  if (!hasRealFloorRows) {
    items
      .slice()
      .sort((a, b) => String(a.unit || a.position).localeCompare(String(b.unit || b.position), "zh-CN", { numeric: true }))
      .forEach((item) => {
        positionMap.set(item, { lat: Number(center.lat), lng: Number(center.lng) });
      });
    return positionMap;
  }

  floorKeys.sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return String(a).localeCompare(String(b), "zh-CN", { numeric: true });
  });

  floorKeys.forEach((floorKey, rowIndex) => {
    const rowItems = (floorGroups.get(floorKey) || [])
      .slice()
      .sort((a, b) => String(a.unit || a.position).localeCompare(String(b.unit || b.position), "zh-CN", { numeric: true }));

    // 大楼 + 楼层 + 号码、楼层 + 号码：同一层全部叠在一起，不同楼层分成不同堆。
    // 渲染时会让最小号码在最上面，方便从 1/01 开始依次拖开。
    const floorLatLng = getUniversalFloorRowLatLng(center, rowIndex, floorKeys.length, 0, 1, 2);
    rowItems.forEach((item) => {
      positionMap.set(item, floorLatLng);
    });
  });

  return positionMap;
}

function bulkAddBuildingNumbersForCommunityAtLatLng(community, latlng, inputText = null) {
  if (!community) return false;

  const input = inputText === null
    ? prompt(
      `请输入要一次添加的楼栋式公寓号码：\n\n可以输入：\n1201-1216\n1301-1316\n123 124 125 126\n1201-1216 1301-1316\n\n系统会按现有“楼栋式”规则归类到楼栋和位置号里。`,
      "1201-1216"
    )
    : inputText;

  if (!input || !String(input).trim()) return false;

  const parsedItems = parseBuildingBulkAddNumbers(input, community);
  if (parsedItems.length === 0) {
    alert("没有识别到可添加的楼栋式号码。请使用 1201-1216、123 124 125 这种格式。");
    return false;
  }

  if (parsedItems.length > 500) {
    alert("一次最多添加 500 个号码。请分批添加，避免地图太卡。");
    return false;
  }

  const previewList = parsedItems.map((item) => item.original);
  const preview = previewList.length > 100 ? `${previewList.slice(0, 100).join(", ")} ...` : previewList.join(", ");
  const ok = confirm(
    `确定在“${community.name}”里批量添加 ${parsedItems.length} 个楼栋式号码吗？\n\n${preview}\n\n生成后会先排列在你刚才双击的位置附近；如果某些号码已经存在，会自动合并或跳过。`
  );
  if (!ok) return false;

  pushHistory();

  if (!Array.isArray(community.buildings)) community.buildings = [];

  const buildingOrder = [];
  const grouped = new Map();
  parsedItems.forEach((parsed) => {
    if (!grouped.has(parsed.building)) {
      grouped.set(parsed.building, []);
      buildingOrder.push(parsed.building);
    }
    grouped.get(parsed.building).push(parsed);
  });

  let added = 0;
  let merged = 0;
  let skipped = 0;
  const createdOrTouchedBuildings = [];

  buildingOrder.forEach((buildingName, buildingIndex) => {
    let building = community.buildings.find((item) => item.name === buildingName);
    const isNewBuilding = !building;
    const buildingCenter = isNewBuilding
      ? getBulkBuildingCenterLatLng(latlng, buildingIndex, buildingOrder.length)
      : { lat: Number(latlng.lat), lng: Number(latlng.lng) };

    if (!building) {
      building = {
        id: makeId("building"),
        name: buildingName,
        lat: buildingCenter.lat,
        lng: buildingCenter.lng,
        color: markerColor,
        size: markerSize,
        fontSize,
        shape: markerShape,
        positions: []
      };
      community.buildings.push(building);
    }

    const numbersForBuilding = grouped.get(buildingName);
    numbersForBuilding.forEach((parsed, index) => {
      let position = building.positions.find((item) => item.position === parsed.position);
      if (!position) {
        const pointLatLng = getFlatBulkAddLatLng(buildingCenter, index, numbersForBuilding.length);
        position = {
          id: makeId("position"),
          position: parsed.position,
          lat: pointLatLng.lat,
          lng: pointLatLng.lng,
          originals: []
        };
        building.positions.push(position);
        added += 1;
      }

      if (!Array.isArray(position.originals)) position.originals = [];
      if (!position.originals.includes(parsed.original)) {
        position.originals.push(parsed.original);
        if (position.originals.length > 1) merged += 1;
      } else {
        skipped += 1;
      }
    });

    createdOrTouchedBuildings.push(building.id);
  });

  community.lat = Number(latlng.lat);
  community.lng = Number(latlng.lng);
  appData.activeCommunityId = community.id;
  selectedBuildingId = createdOrTouchedBuildings[0] || null;
  selectedPositions.clear();
  displayMode = "buildings";
  saveData();
  renderCommunitySelector();
  renderMap();
  if (selectedBuildingId) openBuildingPanel(selectedBuildingId);
  updateLocationStatus(`已批量添加楼栋式号码：新增 ${added} 个位置${merged ? `，合并 ${merged} 个号码` : ""}${skipped ? `，跳过 ${skipped} 个已存在号码` : ""}`, "success");
  return true;
}

function bulkAddBuildingNumbersForActiveCommunity(latlng = null) {
  const community = ensureActiveCommunity();
  if (isFlatCommunity(community) || isTwoFloorSuffixCommunity(community) || isGroupFullCommunity(community)) {
    alert("楼栋式批量添加只用于“楼栋式”编号模式。请先把当前公寓的编号模式设为“楼栋式”。");
    return false;
  }

  const center = latlng || (map && typeof map.getCenter === "function" ? map.getCenter() : { lat: DEFAULT_CENTER[0], lng: DEFAULT_CENTER[1] });
  return bulkAddBuildingNumbersForCommunityAtLatLng(community, center);
}

function addFlatNumberCommunityFromMapPoint(latlng) {
  const defaultName = getActiveCommunity()?.name || "";
  const name = prompt(
    "请输入这个公寓群的办公室地址或名称：\n\n例如：Park Place Office / 1700 Office / The Trails Leasing Office",
    defaultName
  );

  if (!name || !name.trim()) return false;

  const input = prompt(
    `请输入要一次生成的独立编号范围：\n\n可以输入：\n1-50\n1-100\n1 2 3 8 9\n1-20 35-50\n\n生成后会先排列在你刚才双击的位置附近，你可以一个一个拖到正确位置。`,
    "1-100"
  );

  if (!input || !input.trim()) return false;

  const community = getOrCreateFlatCommunityAtLatLng(name.trim(), latlng);
  bulkAddFlatNumbersForCommunityAtLatLng(community, latlng, input);
  return true;
}

function handleBulkPositionsAction() {
  const community = getActiveCommunity();
  if (isFlatCommunity(community)) {
    bulkAddFlatNumbersForActiveCommunity();
    return;
  }
  bulkDeletePositionsForCurrentBuilding();
}

function bulkDeletePositionsForCurrentBuilding() {
  if (!selectedBuildingId) {
    alert("请先打开一个楼组");
    return;
  }

  const building = getBuildingById(selectedBuildingId);
  if (!building) return;

  const community = getActiveCommunity();
  if (!isGroupFullCommunity(community)) {
    alert("批量删除主要用于楼组完整号码模式。");
    return;
  }

  const sampleLines = getGroupDisplayLines(building).join("\n");
  const input = prompt(
    `请输入要批量删除的号码或范围：\n\n可以输入：\n101-116\n201-216\n3楼\n303 304\n全部\n\n当前楼组：\n${sampleLines}`,
    ""
  );
  if (!input || !input.trim()) return;

  const targets = getBulkDeleteTargetsFromInput(input, building);
  if (targets.length === 0) {
    alert("没有找到匹配的号码，请检查输入。\n例如：101-116、201-216、3楼、303 304");
    return;
  }

  const preview = targets.length > 60 ? `${targets.slice(0, 60).join(", ")} ...` : targets.join(", ");
  if (!confirm(`确定一次性删除 ${targets.length} 个号码吗？\n\n${preview}`)) return;

  pushHistory();
  const targetSet = new Set(targets);
  building.positions = building.positions.filter((item) => !targetSet.has(String(item.position)));
  targets.forEach((value) => selectedPositions.delete(value));

  if (community && building.positions.length === 0) {
    const deleteEmpty = confirm(`楼组 ${building.name} 已经没有号码，是否同时删除这个楼组？`);
    if (deleteEmpty) {
      community.buildings = community.buildings.filter((item) => item.id !== building.id);
      selectedBuildingId = null;
      closeBuildingPanel();
    }
  } else {
    refreshGroupBuildingDisplay(building);
  }

  saveData();
  renderMap();
  if (selectedBuildingId) openBuildingPanel(selectedBuildingId);
  updateLocationStatus(`已批量删除 ${targets.length} 个号码`, "success");
}

function serializeData() {
  return JSON.parse(JSON.stringify(appData));
}

function getCurrentState() {
  return {
    appData: serializeData(),
    markerSize,
    fontSize,
    markerColor,
    markerShape,
    rotation,
    displayMode,
    selectedBuildingId,
    selectedPositions: Array.from(selectedPositions)
  };
}

function updateUndoButton() {
  const undoBtn = document.getElementById("undoBtn");
  if (undoBtn) undoBtn.disabled = historyStack.length === 0;
}

function pushHistory() {
  historyStack.push(JSON.stringify(getCurrentState()));
  if (historyStack.length > MAX_HISTORY) historyStack.shift();
  updateUndoButton();
}

function restoreState(snapshot) {
  appData = normalizeLoadedData(snapshot.appData || { version: 3, communities: [] });
  markerSize = clampMarkerSizeValue(snapshot.markerSize, DESKTOP_DEFAULT_MARKER_SIZE);
  fontSize = clampFontSizeValue(snapshot.fontSize, DESKTOP_DEFAULT_FONT_SIZE);
  markerColor = snapshot.markerColor || "#1479e8";
  markerShape = snapshot.markerShape || "circle";
  displayMode = snapshot.displayMode || "communities";
  selectedBuildingId = snapshot.selectedBuildingId || null;
  selectedPositions = new Set(snapshot.selectedPositions || []);
  setMapBearing(snapshot.rotation || 0);
  syncControlValues();
  saveData();
  renderCommunitySelector();
  renderMap();
}

function undoLastAction() {
  if (historyStack.length === 0) return;
  restoreState(JSON.parse(historyStack.pop()));
  updateUndoButton();
}

function saveData(options = {}) {
  localStorage.setItem("communityBuildingMapData", JSON.stringify(appData));
  if (!options.skipCloudSync && initialDataLoadDone) {
    cloudLocalDirtySinceMs = Date.now();
    cloudLocalPendingJson = getLocalCloudJson();
    queueCloudAutoUpload();
  }
}

function normalizeBuildingList(buildings) {
  return (Array.isArray(buildings) ? buildings : []).map((building) => {
    const groupDisplayLines = Array.isArray(building.groupDisplayLines)
      ? building.groupDisplayLines.map(String).filter(Boolean)
      : undefined;

    let positions = Array.isArray(building.positions) ? building.positions.map((item) => ({
      id: item.id || makeId("position"),
      position: String(item.position),
      lat: Number(item.lat),
      lng: Number(item.lng),
      color: item.color || undefined,
      size: Number.isFinite(Number(item.size)) ? Number(item.size) : undefined,
      fontSize: Number.isFinite(Number(item.fontSize)) ? Number(item.fontSize) : undefined,
      shape: ["circle", "square", "rectangle"].includes(item.shape) ? item.shape : undefined,
      originals: Array.isArray(item.originals) ? item.originals.map(String) : []
    })).filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng)) : [];

    // 修复旧版本数据：如果楼组显示行写成 201-316，实际应理解为 201-216 + 301-316，
    // 同时移除旧版本可能错误生成的 217-300 这类中间号码。
    if (groupDisplayLines && groupDisplayLines.length) {
      const expectedNumbers = parseGroupFullRows(groupDisplayLines.join("\n")).numbers;
      if (expectedNumbers.length) {
        const expectedSet = new Set(expectedNumbers);
        positions = positions.filter((item) => expectedSet.has(String(item.position)));
        const existing = new Set(positions.map((item) => String(item.position)));
        expectedNumbers.forEach((number) => {
          if (!existing.has(number)) {
            positions.push({
              id: makeId("position"),
              position: number,
              lat: Number(building.lat),
              lng: Number(building.lng),
              originals: [number]
            });
          }
        });
      }
    }

    return {
      id: building.id || makeId("building"),
      name: String(building.name),
      lat: Number(building.lat),
      lng: Number(building.lng),
      color: building.color || markerColor,
      size: building.size || markerSize,
      fontSize: building.fontSize || fontSize,
      shape: building.shape || markerShape,
      groupDisplayLines,
      photo: normalizeBuildingPhotoMeta(building.photo),
      positions
    };
  }).filter((building) => Number.isFinite(building.lat) && Number.isFinite(building.lng));
}
function convertFlatMarkersToCommunity(data, name = "默认公寓") {
  const converted = {
    version: 3,
    activeCommunityId: null,
    communities: []
  };

  const community = {
    id: makeId("community"),
    name,
    type: "building",
    createdAt: new Date().toISOString(),
    lat: DEFAULT_CENTER[0],
    lng: DEFAULT_CENTER[1],
    buildings: []
  };

  (Array.isArray(data) ? data : []).forEach((item) => {
    const lat = item.lat;
    const lng = item.lng;
    const parsed = parseApartmentNumber(item.number);
    if (!parsed || typeof lat !== "number" || typeof lng !== "number") return;

    let building = community.buildings.find((b) => b.name === parsed.building);
    if (!building) {
      building = {
        id: makeId("building"),
        name: parsed.building,
        lat,
        lng,
        color: item.color || markerColor,
        size: item.size || markerSize,
        fontSize: item.fontSize || fontSize,
        shape: item.shape || markerShape,
        positions: []
      };
      community.buildings.push(building);
    }

    let position = building.positions.find((p) => p.position === parsed.position);
    if (!position) {
      position = { id: makeId("position"), position: parsed.position, lat, lng, originals: [] };
      building.positions.push(position);
    }
    if (!position.originals.includes(parsed.original)) position.originals.push(parsed.original);
  });

  converted.communities.push(community);
  converted.activeCommunityId = community.id;
  return converted;
}

function normalizeLoadedData(data) {
  if (Array.isArray(data)) return convertFlatMarkersToCommunity(data);

  if (data && Array.isArray(data.communities)) {
    const normalized = {
      version: 3,
      activeCommunityId: data.activeCommunityId || null,
      communities: data.communities.map((community) => ({
        id: community.id || makeId("community"),
        name: String(community.name || "未命名公寓"),
        type: normalizeCommunityType(community.type),
        createdAt: community.createdAt || new Date().toISOString(),
        lat: Number.isFinite(Number(community.lat)) ? Number(community.lat) : (getCommunityCenterLatLng(community) || DEFAULT_CENTER)[0],
        lng: Number.isFinite(Number(community.lng)) ? Number(community.lng) : (getCommunityCenterLatLng(community) || DEFAULT_CENTER)[1],
        officePhoto: getCommunityOfficePhotoMeta(community),
        buildings: normalizeBuildingList(community.buildings)
      }))
    };

    if (!normalized.communities.some((item) => item.id === normalized.activeCommunityId)) {
      normalized.activeCommunityId = normalized.communities[0]?.id || null;
    }

    return normalized;
  }

  if (data && Array.isArray(data.buildings)) {
    const community = {
      id: makeId("community"),
      name: data.communityName || "默认公寓",
      type: normalizeCommunityType(data.type),
      createdAt: new Date().toISOString(),
      lat: (getCommunityCenterLatLng({ buildings: data.buildings }) || DEFAULT_CENTER)[0],
      lng: (getCommunityCenterLatLng({ buildings: data.buildings }) || DEFAULT_CENTER)[1],
      buildings: normalizeBuildingList(data.buildings)
    };

    return {
      version: 3,
      activeCommunityId: community.id,
      communities: [community]
    };
  }

  return { version: 3, activeCommunityId: null, communities: [] };
}


function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeUniqueCommunityName(baseName, existingCommunities) {
  const base = String(baseName || "导入公寓").trim() || "导入公寓";
  let name = base;
  let index = 2;
  const existingNames = new Set(existingCommunities.map((item) => item.name));
  while (existingNames.has(name)) {
    name = `${base}（导入${index}）`;
    index += 1;
  }
  return name;
}

function mergePosition(targetBuilding, incomingPosition) {
  const targetPosition = targetBuilding.positions.find((item) => item.position === incomingPosition.position);

  if (!targetPosition) {
    targetBuilding.positions.push(cloneData(incomingPosition));
    return "added";
  }

  const beforeCount = targetPosition.originals.length;
  (incomingPosition.originals || []).forEach((original) => {
    if (!targetPosition.originals.includes(original)) targetPosition.originals.push(original);
  });

  // 不覆盖原来已经手动调整过的位置坐标，只合并号码资料，避免导入旧文件把新位置冲掉。
  return targetPosition.originals.length > beforeCount ? "merged" : "skipped";
}

function mergeBuilding(targetCommunity, incomingBuilding) {
  let targetBuilding = targetCommunity.buildings.find((item) => item.name === incomingBuilding.name);

  if (!targetBuilding) {
    targetCommunity.buildings.push(cloneData(incomingBuilding));
    return { added: incomingBuilding.positions.length, merged: 0, skipped: 0 };
  }

  if (!getBuildingPhotoMeta(targetBuilding) && getBuildingPhotoMeta(incomingBuilding)) {
    targetBuilding.photo = normalizeBuildingPhotoMeta(incomingBuilding.photo);
  }

  let stats = { added: 0, merged: 0, skipped: 0 };
  (incomingBuilding.positions || []).forEach((position) => {
    const result = mergePosition(targetBuilding, position);
    stats[result] += 1;
  });
  return stats;
}


function getCommunityTypeLabel(type) {
  const normalized = normalizeCommunityType(type);
  if (normalized === "flat") return "独立编号";
  if (normalized === "twofloor_suffix") return "两层后缀编号";
  if (normalized === "group_full") return "整组号码";
  return "万用表格";
}

function applyImportOptionsToData(importedData, options = {}) {
  const data = normalizeLoadedData(cloneData(importedData));
  const preserveNames = options.preserveNames !== false;
  const overrideName = String(options.name || "").trim();
  const overrideType = options.type ? normalizeCommunityType(options.type) : "";

  data.communities.forEach((community, index) => {
    // 多公寓 JSON 必须保留每个 community 自己的名字。
    // 旧代码会先把所有名字用“、”连接，再把整串名字写回每个 community，
    // 这正是“所有公寓变成一长串统一名称”的根因。
    if (!preserveNames && overrideName) {
      community.name = data.communities.length === 1 ? overrideName : `${overrideName}-${index + 1}`;
    } else {
      community.name = String(community.name || "").trim() || `导入公寓-${index + 1}`;
    }

    if (overrideType) community.type = overrideType;
    else community.type = normalizeCommunityType(community.type);
  });

  return data;
}

function promptImportOptions(importedData, fileName = "") {
  const communities = Array.isArray(importedData.communities) ? importedData.communities : [];
  if (!communities.length) return null;

  // 多公寓文件：绝对不再把所有公寓名称拼成一个名字。
  if (communities.length > 1) {
    const previewNames = communities
      .slice(0, 6)
      .map((item, index) => String(item?.name || "").trim() || `未命名公寓-${index + 1}`);
    const moreText = communities.length > previewNames.length ? `\n……另外还有 ${communities.length - previewNames.length} 个公寓` : "";
    const ok = confirm(
      `检测到这是一个包含 ${communities.length} 个公寓的 JSON：\n\n${previewNames.join("\n")}${moreText}\n\n将保留每个公寓原来的独立名称和编号模式，不会再把所有地址拼成一个名称。\n\n确认后会合并导入，不会清空原来的资料。`
    );
    if (!ok) return null;
    return { preserveNames: true };
  }

  // 单公寓文件仍允许用户在导入时改名，但默认保留检测到的名称和类型。
  const sourceCommunity = communities[0] || {};
  const detectedName = String(sourceCommunity.name || "").trim();
  const defaultName = detectedName || getActiveCommunity()?.name || fileName.replace(/\.json$/i, "") || "导入公寓";
  const name = prompt(
    `请输入这个导入文件对应的公寓名称或地址：\n\n文件名：${fileName || "未命名文件"}\n检测到：${detectedName || "没有检测到公寓名称"}\n\n直接确定即可保留当前名称。`,
    defaultName
  );
  if (!name || !name.trim()) return null;

  const ok = confirm(
    `确认导入设置：\n\n公寓/地址：${name.trim()}\n编号模式：${getCommunityTypeLabel(sourceCommunity.type)}\n\n确认后会合并导入，不会清空原来的资料。`
  );
  if (!ok) return null;

  return {
    preserveNames: false,
    name: name.trim(),
    type: normalizeCommunityType(sourceCommunity.type)
  };
}

function mergeImportedData(currentData, importedData) {
  const merged = normalizeLoadedData(cloneData(currentData));
  const incoming = normalizeLoadedData(cloneData(importedData));
  const stats = { communitiesAdded: 0, communitiesMerged: 0, numbersAdded: 0, numbersMerged: 0, numbersSkipped: 0 };

  if (!Array.isArray(merged.communities)) merged.communities = [];

  incoming.communities.forEach((incomingCommunity) => {
    const incomingId = String(incomingCommunity.id || "");
    const incomingNameKey = normalizeCommunitySearchText(incomingCommunity.name);
    let targetCommunity = incomingId
      ? merged.communities.find((item) => String(item.id || "") === incomingId)
      : null;

    // 只有没有可用 ID 时，才用“规范化名称 + 类型”作为兼容旧文件的回退匹配。
    if (!targetCommunity && incomingNameKey) {
      targetCommunity = merged.communities.find((item) =>
        normalizeCommunitySearchText(item.name) === incomingNameKey &&
        normalizeCommunityType(item.type) === normalizeCommunityType(incomingCommunity.type)
      );
    }

    if (!targetCommunity) {
      const communityToAdd = cloneData(incomingCommunity);
      communityToAdd.id = makeId("community");
      communityToAdd.name = merged.communities.some((item) => item.name === communityToAdd.name)
        ? makeUniqueCommunityName(communityToAdd.name, merged.communities)
        : communityToAdd.name;
      merged.communities.push(communityToAdd);
      stats.communitiesAdded += 1;
      stats.numbersAdded += communityToAdd.buildings.reduce((sum, building) => sum + building.positions.length, 0);
      return;
    }

    stats.communitiesMerged += 1;
    if (!getCommunityOfficePhotoMeta(targetCommunity) && getCommunityOfficePhotoMeta(incomingCommunity)) {
      targetCommunity.officePhoto = getCommunityOfficePhotoMeta(incomingCommunity);
    }
    (incomingCommunity.buildings || []).forEach((building) => {
      const result = mergeBuilding(targetCommunity, building);
      stats.numbersAdded += result.added;
      stats.numbersMerged += result.merged;
      stats.numbersSkipped += result.skipped;
    });
  });

  if (!merged.activeCommunityId || !merged.communities.some((item) => item.id === merged.activeCommunityId)) {
    merged.activeCommunityId = merged.communities[0]?.id || null;
  }

  return { data: merged, stats };
}

function saveSafetyBackup() {
  try {
    localStorage.setItem("communityBuildingMapDataBackup", JSON.stringify(appData));
    localStorage.setItem("communityBuildingMapDataBackupTime", new Date().toISOString());
  } catch (error) {
    console.warn("备份本地数据失败：", error);
  }
}


function loadData() {
  const saved = localStorage.getItem("communityBuildingMapData") || localStorage.getItem("buildingMapData") || localStorage.getItem("mapMarkers");

  if (saved) {
    try {
      appData = normalizeLoadedData(JSON.parse(saved));
      if (appData.communities.length === 0) createCommunity("默认公寓");
      saveData();
      return;
    } catch (error) {
      console.error("读取本地数据失败：", error);
      localStorage.removeItem("communityBuildingMapData");
    }
  }

  createCommunity("默认公寓");
  saveData();
}

function getDefaultJsonFileName() {
  const community = getActiveCommunity();
  const safeName = community ? community.name.replace(/[\\/:*?"<>|]/g, "-").slice(0, 40) : "all";
  return `${safeName}-community-map-data.json`;
}

function createExportJsonBlob() {
  return new Blob([JSON.stringify(serializeData(), null, 2)], {
    type: "application/json"
  });
}

function downloadJsonFileFallback(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportMarkers() {
  const fileName = getDefaultJsonFileName();
  const blob = createExportJsonBlob();

  const useDrive = confirm(
    "是否导出 JSON 到 Google Drive？\n\n接下来会打开系统保存窗口。请在保存位置里选择 Google Drive / 云端硬盘。\n\n如果当前浏览器不支持直接另存为，会改为下载 JSON 文件，你可以再手动上传到 Google Drive。"
  );
  if (!useDrive) return;

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{
          description: "JSON 地图资料",
          accept: { "application/json": [".json"] }
        }]
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      updateLocationStatus("JSON 已保存；如果你选择的是 Google Drive，就已经导出到云盘", "success");
      return;
    } catch (error) {
      if (error && error.name === "AbortError") {
        updateLocationStatus("已取消导出 JSON", "info");
        return;
      }
      console.warn("系统另存为失败，改用普通下载：", error);
    }
  }

  alert("当前浏览器不能直接打开另存为窗口。现在会下载 JSON 文件；下载后请在系统分享/文件管理里保存到 Google Drive。");
  downloadJsonFileFallback(blob, fileName);
}

function openJsonImportPicker() {
  const ok = confirm(
    "是否从 Google Drive 导入 JSON？\n\n接下来会打开系统文件选择窗口。请在文件来源里选择 Google Drive / 云端硬盘，然后选择你的 JSON 文件。"
  );
  if (!ok) return;
  const input = document.getElementById("importInput");
  if (input) input.click();
}

function importMarkers(file) {
  const reader = new FileReader();
  reader.onload = function (event) {
    try {
      const rawData = JSON.parse(event.target.result);
      const detectedImport = normalizeLoadedData(rawData);
      if (!detectedImport.communities.length) {
        alert("导入失败：文件里面没有可用的公寓数据");
        return;
      }

      const importOptions = promptImportOptions(detectedImport, file?.name || "");
      if (!importOptions) {
        alert("已取消导入，原来的资料没有改变。");
        return;
      }

      const imported = applyImportOptionsToData(detectedImport, importOptions);

      pushHistory();
      saveSafetyBackup();
      const result = mergeImportedData(appData, imported);
      appData = result.data;
      saveData();
      renderCommunitySelector();
      restoreBuildingsMode();
      alert(`合并导入成功：

公寓/地址：${importOptions.name}
编号模式：${getCommunityTypeLabel(importOptions.type)}

新增 ${result.stats.communitiesAdded} 个公寓，合并 ${result.stats.communitiesMerged} 个公寓，新增 ${result.stats.numbersAdded} 个编号，已存在 ${result.stats.numbersSkipped} 个编号。

原来的公寓和新加地址都已保留，没有清空。`);
    } catch (error) {
      console.error(error);
      alert("导入失败：JSON 格式不正确");
    }
  };
  reader.readAsText(file);
}




/* 云端自动同步（Firebase Firestore + Authentication）
   固定同步到同一份云端资料；首次在设备上使用时登录 Firebase，之后保持登录状态。
   Firestore 访问限定为指定 UID；只同步 appData 地图资料。 */
const CLOUD_DEVICE_ID_STORAGE_KEY = "communityMapCloudDeviceId";
const CLOUD_COLLECTION_NAME = "community_map_cloud_data";
const CLOUD_DOCUMENT_ID = "mainData";
const CLOUD_UPLOAD_DELAY_MS = 1200;
const CLOUD_LOCAL_EDIT_PROTECT_MS = 10000;
const CLOUD_MIGRATION_VERSION = 1;
const FIREBASE_ALLOWED_UID = "I1AGzKoXMTQBEXTWdkLioDbl7Xs2";
const FIREBASE_LAST_EMAIL_STORAGE_KEY = "xunbaohuoFirebaseLoginEmail";
let cloudMigrationReady = false;

const firebaseConfig = {
  apiKey: "AIzaSyBuikOB_MbGp9RzBHby2a4xK-Tyy7DKsu8",
  authDomain: "ditudh-3c448.firebaseapp.com",
  projectId: "ditudh-3c448",
  storageBucket: "ditudh-3c448.firebasestorage.app",
  messagingSenderId: "161753142744",
  appId: "1:161753142744:web:3e890d94a7c98f52f48ead"
};

let initialDataLoadDone = false;
let cloudUploadTimer = null;
let cloudUploadBusy = false;
let cloudUploadQueued = false;
let cloudApplyingRemote = false;
let cloudListenerStarted = false;
let cloudSnapshotUnsubscribe = null;
let cloudLastSyncedJson = "";
let cloudLastRemoteUpdatedAtMs = 0;
let cloudLocalDirtySinceMs = 0;
let cloudLocalPendingJson = "";

const cloudSyncState = {
  app: null,
  auth: null,
  db: null,
  authReadyPromise: null
};

function getCloudDeviceId() {
  let id = localStorage.getItem(CLOUD_DEVICE_ID_STORAGE_KEY);
  if (!id) {
    id = `device-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(CLOUD_DEVICE_ID_STORAGE_KEY, id);
  }
  return id;
}

function formatCloudSyncTime(timeValue = Date.now()) {
  try {
    return new Date(timeValue).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch (error) {
    return "刚刚";
  }
}

function updateCloudSyncStatus(message, tone = "info") {
  if (!cloudSyncStatus) return;
  cloudSyncStatus.innerText = `云端：${message}`;
  cloudSyncStatus.className = "cloud-sync-status";
  if (tone !== "info") cloudSyncStatus.classList.add(tone);
}

function getLocalCloudJson() {
  return JSON.stringify(serializeData());
}

function hasUsefulLocalCloudData() {
  return Array.isArray(appData?.communities) && appData.communities.length > 0;
}

function getFirebaseAuthUi() {
  return {
    overlay: document.getElementById("firebaseAuthOverlay"),
    email: document.getElementById("firebaseAuthEmail"),
    password: document.getElementById("firebaseAuthPassword"),
    message: document.getElementById("firebaseAuthMessage"),
    loginBtn: document.getElementById("firebaseAuthLoginBtn"),
    resetBtn: document.getElementById("firebaseAuthResetBtn")
  };
}

function setFirebaseAuthMessage(message = "", success = false) {
  const { message: box } = getFirebaseAuthUi();
  if (!box) return;
  box.textContent = message;
  box.className = "firebase-auth-message" + (success ? " success" : "");
}

function showFirebaseAuthOverlay(message = "") {
  const ui = getFirebaseAuthUi();
  if (!ui.overlay) return;
  ui.overlay.hidden = false;
  if (ui.email && !ui.email.value) {
    try { ui.email.value = localStorage.getItem(FIREBASE_LAST_EMAIL_STORAGE_KEY) || ""; } catch (error) {}
  }
  if (ui.password) ui.password.value = "";
  setFirebaseAuthMessage(message);
  setTimeout(() => {
    if (ui.email && !ui.email.value) ui.email.focus();
    else if (ui.password) ui.password.focus();
  }, 0);
}

function hideFirebaseAuthOverlay() {
  const ui = getFirebaseAuthUi();
  if (ui.overlay) ui.overlay.hidden = true;
  if (ui.password) ui.password.value = "";
  setFirebaseAuthMessage("");
}

function getFirebaseAuthFriendlyError(error) {
  const code = String(error?.code || "");
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) {
    return "邮箱或密码不正确，请重新输入。";
  }
  if (code.includes("too-many-requests")) return "登录尝试过多，请稍后再试。";
  if (code.includes("network-request-failed")) return "网络连接失败，请检查网络后重试。";
  if (code.includes("invalid-email")) return "邮箱格式不正确。";
  return error?.message || "Firebase 登录失败。";
}

function ensureFirebaseApp() {
  if (!window.firebase || !firebase.initializeApp || !firebase.auth || !firebase.firestore) {
    throw new Error("Firebase SDK 没有加载成功，请检查网络或网页是否能访问 Google Firebase CDN。");
  }
  if (!cloudSyncState.app) {
    cloudSyncState.app = firebase.apps && firebase.apps.length ? firebase.app() : firebase.initializeApp(firebaseConfig);
    cloudSyncState.auth = firebase.auth();
    cloudSyncState.db = firebase.firestore();
  }
  return cloudSyncState;
}

async function ensureAuthorizedFirebaseUser() {
  const state = ensureFirebaseApp();
  if (state.auth.currentUser) {
    if (state.auth.currentUser.uid === FIREBASE_ALLOWED_UID) return state.auth.currentUser;
    await state.auth.signOut();
    throw new Error("当前 Firebase 登录账号不是这个地图允许的账号，请使用地图专用账号登录。");
  }

  if (!state.authReadyPromise) {
    state.authReadyPromise = new Promise((resolve, reject) => {
      let settled = false;
      const unsubscribe = state.auth.onAuthStateChanged(async (user) => {
        if (settled) return;
        if (!user) {
          settled = true;
          unsubscribe();
          resolve(null);
          return;
        }
        if (user.uid !== FIREBASE_ALLOWED_UID) {
          settled = true;
          unsubscribe();
          try { await state.auth.signOut(); } catch (error) {}
          reject(new Error("当前 Firebase 登录账号不是这个地图允许的账号，请使用地图专用账号登录。"));
          return;
        }
        settled = true;
        unsubscribe();
        resolve(user);
      }, reject);
    }).finally(() => {
      state.authReadyPromise = null;
    });
  }

  const restoredUser = await state.authReadyPromise;
  if (restoredUser) return restoredUser;
  throw new Error("需要登录 Firebase 后才能连接云端。");
}

async function loginFirebaseFromUi() {
  const ui = getFirebaseAuthUi();
  const email = String(ui.email?.value || "").trim();
  const password = String(ui.password?.value || "");
  if (!email || !password) {
    setFirebaseAuthMessage("请输入邮箱和密码。");
    return;
  }

  try {
    const state = ensureFirebaseApp();
    if (ui.loginBtn) ui.loginBtn.disabled = true;
    setFirebaseAuthMessage("正在登录...");
    await state.auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
    const credential = await state.auth.signInWithEmailAndPassword(email, password);
    if (!credential.user || credential.user.uid !== FIREBASE_ALLOWED_UID) {
      await state.auth.signOut();
      throw new Error("这个账号不是地图允许的 Firebase 用户。\n请使用正确账号登录。");
    }
    try { localStorage.setItem(FIREBASE_LAST_EMAIL_STORAGE_KEY, email); } catch (error) {}
    hideFirebaseAuthOverlay();
    updateCloudSyncStatus("登录成功，正在连接...", "success");
    cloudListenerStarted = false;
    await startCloudAutoSync();
  } catch (error) {
    console.error("Firebase 登录失败：", error);
    setFirebaseAuthMessage(getFirebaseAuthFriendlyError(error));
  } finally {
    if (ui.loginBtn) ui.loginBtn.disabled = false;
  }
}

async function sendFirebasePasswordResetFromUi() {
  const ui = getFirebaseAuthUi();
  const email = String(ui.email?.value || "").trim();
  if (!email) {
    setFirebaseAuthMessage("请先填写邮箱，再发送密码重置邮件。");
    return;
  }
  try {
    const state = ensureFirebaseApp();
    if (ui.resetBtn) ui.resetBtn.disabled = true;
    await state.auth.sendPasswordResetEmail(email);
    setFirebaseAuthMessage("密码重置邮件已经发送，请检查邮箱。", true);
  } catch (error) {
    setFirebaseAuthMessage(getFirebaseAuthFriendlyError(error));
  } finally {
    if (ui.resetBtn) ui.resetBtn.disabled = false;
  }
}

function setupFirebaseAuthUi() {
  const ui = getFirebaseAuthUi();
  if (ui.loginBtn) ui.loginBtn.addEventListener("click", loginFirebaseFromUi);
  if (ui.resetBtn) ui.resetBtn.addEventListener("click", sendFirebasePasswordResetFromUi);
  if (ui.password) {
    ui.password.addEventListener("keydown", (event) => {
      if (event.key === "Enter") loginFirebaseFromUi();
    });
  }
}

async function ensureCloudReady() {
  const state = ensureFirebaseApp();
  await ensureAuthorizedFirebaseUser();
  return state.db;
}

async function getCloudDocumentReference() {
  const db = await ensureCloudReady();
  return db.collection(CLOUD_COLLECTION_NAME).doc(CLOUD_DOCUMENT_ID);
}

function getCloudPayload() {
  return {
    appName: "xunbaohuo-map-navigation",
    schemaVersion: 3,
    migrationVersion: CLOUD_MIGRATION_VERSION,
    updatedAtMs: Date.now(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    deviceId: getCloudDeviceId(),
    data: serializeData()
  };
}

function getRemoteUpdatedTime(snapshotData) {
  return Number(snapshotData?.updatedAtMs || 0);
}

function normalizeRemoteCloudData(snapshotData) {
  const raw = snapshotData?.data || snapshotData?.appData || snapshotData;
  return normalizeLoadedData(raw || { version: 3, communities: [] });
}

function refreshMapAfterCloudDataChange() {
  if (selectedBuildingId && !getBuildingById(selectedBuildingId)) {
    selectedBuildingId = null;
    selectedPositions.clear();
    closeBuildingPanel();
  }

  if (communitySearchCommunityId && !getCommunityById(communitySearchCommunityId)) {
    communitySearchCommunityId = null;
    communitySearchTargets = [];
    deliveryDeliveredKeys = new Set();
    deliveryCancelledKeys = new Set();
    deliveryPendingPanelOpen = false;
    deliveryDeliveredPanelOpen = false;
    closeCommunitySearchPanel();
  }

  renderCommunitySelector();
  renderMap();
}

function hasProtectedLocalCloudEdit(localJson, remoteJson, remoteUpdatedAtMs, remoteDeviceId) {
  if (!cloudLocalDirtySinceMs || !cloudLocalPendingJson || remoteJson === localJson) return false;
  if (localJson !== cloudLocalPendingJson) return false;

  const now = Date.now();
  const remoteTime = Number(remoteUpdatedAtMs || 0);
  const isInsideProtectWindow = now - cloudLocalDirtySinceMs < CLOUD_LOCAL_EDIT_PROTECT_MS;
  const remoteIsOlderThanLocalEdit = remoteTime > 0 && remoteTime <= cloudLocalDirtySinceMs;
  const remoteIsFromThisDevice = remoteDeviceId === getCloudDeviceId();

  return isInsideProtectWindow || remoteIsOlderThanLocalEdit || remoteIsFromThisDevice || cloudUploadBusy || cloudUploadQueued || !!cloudUploadTimer;
}

function clearLocalCloudPendingEdit(currentJson = getLocalCloudJson()) {
  if (cloudLocalPendingJson && currentJson === cloudLocalPendingJson) {
    cloudLocalDirtySinceMs = 0;
    cloudLocalPendingJson = "";
  }
}

function applyCloudDataToLocal(remoteData, remoteUpdatedAtMs, remoteDeviceId) {
  const remoteJson = JSON.stringify(remoteData);
  const localJson = getLocalCloudJson();
  const remoteTime = Number(remoteUpdatedAtMs || Date.now());

  if (hasProtectedLocalCloudEdit(localJson, remoteJson, remoteTime, remoteDeviceId)) {
    updateCloudSyncStatus("本机刚修改，等待上传，暂不覆盖当前位置", "warning");
    return;
  }

  if (remoteJson === localJson) {
    if (cloudUploadBusy && cloudLocalPendingJson && localJson === cloudLocalPendingJson) {
      updateCloudSyncStatus("正在同步本机修改...", "info");
      return;
    }

    cloudLastRemoteUpdatedAtMs = remoteTime;
    cloudLastSyncedJson = remoteJson;
    clearLocalCloudPendingEdit(localJson);
    updateCloudSyncStatus(`已同步 ${formatCloudSyncTime(cloudLastRemoteUpdatedAtMs)}`, "success");
    return;
  }

  cloudLastRemoteUpdatedAtMs = remoteTime;
  cloudLastSyncedJson = remoteJson;

  cloudApplyingRemote = true;
  try {
    if (hasUsefulLocalCloudData()) saveSafetyBackup();
    appData = remoteData;
    saveData({ skipCloudSync: true });
    refreshMapAfterCloudDataChange();

    const sourceText = remoteDeviceId === getCloudDeviceId() ? "本机修改已同步" : "收到云端更新，已同步";
    updateCloudSyncStatus(`${sourceText} ${formatCloudSyncTime(cloudLastRemoteUpdatedAtMs)}`, "success");
  } finally {
    cloudApplyingRemote = false;
  }
}

async function uploadCurrentDataToCloud() {
  if (!initialDataLoadDone || cloudApplyingRemote) return;
  if (!cloudMigrationReady) {
    cloudUploadQueued = false;
    updateCloudSyncStatus("迁移保护中：旧云端数据不会覆盖本机；请先导入正确 JSON，再手动覆盖云端", "warning");
    return;
  }

  if (!navigator.onLine) {
    cloudUploadQueued = true;
    updateCloudSyncStatus("离线，本机已保存，联网后自动同步", "warning");
    return;
  }

  if (cloudUploadBusy) {
    cloudUploadQueued = true;
    return;
  }

  const currentJson = getLocalCloudJson();
  if (currentJson === cloudLastSyncedJson) {
    clearLocalCloudPendingEdit(currentJson);
    updateCloudSyncStatus(`已同步 ${formatCloudSyncTime(cloudLastRemoteUpdatedAtMs || Date.now())}`, "success");
    return;
  }

  if (!hasUsefulLocalCloudData() && !cloudLastSyncedJson) {
    updateCloudSyncStatus("已连接，暂无地图资料", "info");
    return;
  }

  cloudUploadBusy = true;
  updateCloudSyncStatus("正在同步本机修改...", "info");

  try {
    const ref = await getCloudDocumentReference();
    const payload = getCloudPayload();
    await ref.set(payload);
    cloudLastSyncedJson = currentJson;
    cloudLastRemoteUpdatedAtMs = payload.updatedAtMs;
    clearLocalCloudPendingEdit(currentJson);
    updateCloudSyncStatus(`本机修改已同步 ${formatCloudSyncTime(payload.updatedAtMs)}`, "success");
  } catch (error) {
    console.error("云端同步失败：", error);
    updateCloudSyncStatus(getCloudFriendlyError(error, "同步失败"), "error");
    cloudUploadQueued = true;
  } finally {
    cloudUploadBusy = false;
    if (cloudUploadQueued && navigator.onLine) {
      cloudUploadQueued = false;
      queueCloudAutoUpload();
    }
  }
}

function queueCloudAutoUpload() {
  if (!initialDataLoadDone || cloudApplyingRemote || !cloudMigrationReady) return;
  clearTimeout(cloudUploadTimer);
  cloudUploadTimer = setTimeout(() => {
    cloudUploadTimer = null;
    uploadCurrentDataToCloud();
  }, CLOUD_UPLOAD_DELAY_MS);
}

function getCloudFriendlyError(error, fallback) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");

  if (code.includes("permission-denied") || message.toLowerCase().includes("permission")) {
    return `${fallback}：Firebase 权限没有打开，请检查 Firestore 读写规则。`;
  }
  if (code.includes("unavailable") || message.toLowerCase().includes("network")) {
    return `${fallback}：网络连接不到 Firebase。`;
  }
  if (message.toLowerCase().includes("maximum") || message.toLowerCase().includes("too large")) {
    return `${fallback}：资料太大，超过 Firestore 单个文件限制。`;
  }
  return `${fallback}：${message || "未知错误"}`;
}

async function startCloudAutoSync() {
  if (cloudListenerStarted) return;
  cloudListenerStarted = true;
  updateCloudSyncStatus("正在连接...", "info");

  try {
    const ref = await getCloudDocumentReference();
    cloudSnapshotUnsubscribe = ref.onSnapshot(
      (snapshot) => {
        if (!snapshot.exists) {
          cloudMigrationReady = false;
          cloudLastSyncedJson = "";
          cloudLastRemoteUpdatedAtMs = 0;
          updateCloudSyncStatus("云端为空，迁移保护已开启。导入正确 JSON 后可手动建立新的云端资料", "warning");
          return;
        }

        const remote = snapshot.data() || {};
        const remoteMigrationVersion = Number(remote.migrationVersion || 0);
        if (remoteMigrationVersion < CLOUD_MIGRATION_VERSION) {
          cloudMigrationReady = false;
          cloudLastSyncedJson = "";
          cloudLastRemoteUpdatedAtMs = getRemoteUpdatedTime(remote) || 0;
          updateCloudSyncStatus("检测到旧云端数据，已自动锁定，不会覆盖本机。请导入正确 JSON 后点击‘覆盖云端’", "warning");
          return;
        }

        cloudMigrationReady = true;
        const remoteData = normalizeRemoteCloudData(remote);
        const remoteUpdatedAtMs = getRemoteUpdatedTime(remote) || Date.now();

        applyCloudDataToLocal(remoteData, remoteUpdatedAtMs, remote.deviceId);
      },
      (error) => {
        console.error("云端监听失败：", error);
        updateCloudSyncStatus(getCloudFriendlyError(error, "监听失败"), "error");
        cloudListenerStarted = false;
      }
    );
  } catch (error) {
    console.error("云端连接失败：", error);
    const message = String(error?.message || "");
    if (message.includes("需要登录 Firebase") || message.includes("不是这个地图允许的账号")) {
      updateCloudSyncStatus("等待 Firebase 登录", "warning");
      showFirebaseAuthOverlay(message.includes("不是这个地图允许的账号") ? message : "首次在此设备使用，请登录 Firebase。" );
    } else {
      updateCloudSyncStatus(getCloudFriendlyError(error, "连接失败"), "error");
    }
    cloudListenerStarted = false;
  }
}


function looksLikePollutedCommunityName(name) {
  const text = String(name || "");
  const separators = (text.match(/、/g) || []).length;
  return text.length > 140 || separators >= 3;
}

function validateMigrationData(data) {
  const communities = Array.isArray(data?.communities) ? data.communities : [];
  const useful = communities.filter((community) => Array.isArray(community.buildings) && community.buildings.length > 0);
  if (!useful.length) return { ok: false, message: "这个 JSON 没有可用的公寓/号码资料。" };
  const polluted = communities.filter((community) => looksLikePollutedCommunityName(community?.name));
  if (polluted.length) {
    return { ok: false, message: `检测到 ${polluted.length} 个公寓名称仍像旧的串接错误。请不要用这份文件覆盖云端。` };
  }
  return { ok: true, usefulCount: useful.length };
}

function openMigrationImportPicker() {
  const input = document.getElementById("migrationImportInput");
  if (input) input.click();
}

function importMigrationReplacementFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (event) {
    try {
      const rawData = JSON.parse(String(event.target?.result || "{}"));
      const replacement = normalizeLoadedData(rawData);
      const check = validateMigrationData(replacement);
      if (!check.ok) {
        alert(`迁移导入已阻止：${check.message}`);
        return;
      }

      const ok = confirm(
        `这一步会用所选 JSON 完全替换本机当前地图资料（不会上传云端）。\n\n检测到 ${replacement.communities.length} 个公寓，其中 ${check.usefulCount} 个有号码资料。\n\n确定继续吗？`
      );
      if (!ok) return;

      saveSafetyBackup();
      appData = replacement;
      selectedBuildingId = null;
      selectedPositions.clear();
      communitySearchCommunityId = null;
      communitySearchTargets = [];
      deliveryDeliveredKeys = new Set();
      deliveryCancelledKeys = new Set();
      displayMode = "communities";
      saveData({ skipCloudSync: true });
      refreshMapAfterCloudDataChange();
      updateCloudSyncStatus("正确 JSON 已载入本机；旧云端仍被锁定，尚未覆盖", "warning");
      alert("正确 JSON 已替换本机资料。请先检查地图和公寓名称；确认无误后，再点击‘用当前正确数据覆盖云端’。");
    } catch (error) {
      console.error(error);
      alert("迁移导入失败：JSON 格式不正确。\n" + (error?.message || error));
    } finally {
      const input = document.getElementById("migrationImportInput");
      if (input) input.value = "";
    }
  };
  reader.readAsText(file, "utf-8");
}

async function overwriteCloudWithCurrentMigrationData() {
  const check = validateMigrationData(appData);
  if (!check.ok) {
    alert(`不能覆盖云端：${check.message}\n\n请先用“迁移：导入正确 JSON（替换本机）”载入修好的文件。`);
    return;
  }

  const ok = confirm(
    `危险操作确认：\n\n将用当前本机的 ${appData.communities.length} 个公寓完整覆盖 Firebase 云端旧资料。\n覆盖后，旧的串接数据将不再作为主云端数据生效。\n\n请确认你已经检查过公寓名称和号码。是否继续？`
  );
  if (!ok) return;

  const buttons = [
    document.getElementById("migrationOverwriteCloudBtn"),
    document.getElementById("mobileMigrationOverwriteCloudBtn")
  ].filter(Boolean);
  buttons.forEach((button) => button.disabled = true);
  updateCloudSyncStatus("正在用当前正确数据覆盖旧云端...", "info");

  try {
    const ref = await getCloudDocumentReference();
    const payload = getCloudPayload();
    payload.migrationCompletedAtMs = Date.now();
    await ref.set(payload);
    cloudMigrationReady = true;
    cloudLastSyncedJson = getLocalCloudJson();
    cloudLastRemoteUpdatedAtMs = payload.updatedAtMs;
    clearLocalCloudPendingEdit(cloudLastSyncedJson);
    updateCloudSyncStatus(`迁移完成，云端已替换 ${formatCloudSyncTime(payload.updatedAtMs)}`, "success");
    alert("迁移完成：当前正确数据已经覆盖云端旧资料。以后打开这个新版网页，会恢复正常自动同步。");
  } catch (error) {
    console.error("迁移覆盖云端失败：", error);
    updateCloudSyncStatus(getCloudFriendlyError(error, "迁移覆盖失败"), "error");
    alert("覆盖云端失败：" + (error?.message || error));
  } finally {
    buttons.forEach((button) => button.disabled = false);
  }
}

function setupCloudNetworkWatchers() {
  window.addEventListener("online", function () {
    updateCloudSyncStatus("网络已恢复，正在同步...", "info");
    if (!cloudListenerStarted) startCloudAutoSync();
    if (cloudUploadQueued) {
      cloudUploadQueued = false;
      queueCloudAutoUpload();
    }
  });

  window.addEventListener("offline", function () {
    updateCloudSyncStatus("离线，本机修改会先保存", "warning");
  });
}

function initCloudSyncUi() {
  setupFirebaseAuthUi();
  setupCloudNetworkWatchers();
  startCloudAutoSync();
}

function applyCurrentSettingsToAllMarkers() {
  pushHistory();
  let changedCount = 0;
  getCurrentBuildings().forEach((building) => {
    (Array.isArray(building.positions) ? building.positions : []).forEach((position) => {
      position.size = markerSize;
      position.fontSize = fontSize;
      position.color = markerColor;
      position.shape = markerShape;
      changedCount += 1;
    });
  });
  saveData();
  renderMap();
  updateLocationStatus(`已应用到 ${changedCount} 个现有公寓号码`, changedCount ? "success" : "warning");
}

function syncControlValues() {
  document.getElementById("fontSize").value = fontSize;
  document.getElementById("fontSizeValue").innerText = String(fontSize);
  document.getElementById("markerSize").value = markerSize;
  document.getElementById("markerSizeValue").innerText = String(markerSize);
  document.getElementById("markerColor").value = markerColor;
  document.getElementById("markerShape").value = markerShape;
}

function openNumberPad(latlng) {
  openUniversalNumberPanel(latlng);
}

function closeNumberPad() {
  closeUniversalNumberPanel();
}

function updateNumberDisplay() {}

function appendInputChar(value) {}

function createArrowIcon() {
  return L.divIcon({
    className: "",
    html: `
      <div class="my-location-wrap">
        <div class="my-location-heading" style="transform: rotate(0deg);">
          <div class="my-location-tip"></div>
          <div class="my-location"></div>
        </div>
      </div>
    `,
    iconSize: [24, 32],
    iconAnchor: [12, 21]
  });
}

function updateMyLocationMarkerHeading() {
  if (!myLocationMarker) return;
  const markerElement = myLocationMarker.getElement();
  const headingElement = markerElement?.querySelector(".my-location-heading");
  if (!headingElement) {
    myLocationMarker.setIcon(createArrowIcon());
    return;
  }
  headingElement.style.transform = followHeading ? "rotate(0deg)" : `rotate(${getDisplayHeading()}deg)`;
}

function getScreenOrientationAngle() {
  if (screen?.orientation && typeof screen.orientation.angle === "number") return screen.orientation.angle;
  if (typeof window.orientation === "number") return window.orientation;
  return 0;
}

function getDeviceHeading(event) {
  if (typeof event.webkitCompassHeading === "number" && !Number.isNaN(event.webkitCompassHeading)) {
    return normalizeHeading(event.webkitCompassHeading);
  }
  if (typeof event.alpha === "number" && !Number.isNaN(event.alpha)) {
    return normalizeHeading(360 - event.alpha + getScreenOrientationAngle());
  }
  return null;
}

function handleDeviceOrientation(event) {
  const heading = getDeviceHeading(event);
  if (heading === null) return;
  headingReady = true;
  myHeading = heading;
  if (headingWatchdogTimer) {
    clearTimeout(headingWatchdogTimer);
    headingWatchdogTimer = null;
  }
  updateHeadingText();
  if (followHeading) setMapBearing(360 - myHeading);
  else updateMyLocationMarkerHeading();
}

function armHeadingWatchdog() {
  if (headingWatchdogTimer) clearTimeout(headingWatchdogTimer);
  headingWatchdogTimer = setTimeout(function () {
    if (!headingReady && followHeading) {
      updateLocationStatus("没有读取到方向，请移动手机或重试", "warning");
      updateMobileStatus("没有读取到方向，请重试", "重试");
    }
  }, 3000);
}

function startOrientationTracking() {
  window.addEventListener("deviceorientationabsolute", handleDeviceOrientation, true);
  window.addEventListener("deviceorientation", handleDeviceOrientation, true);
  armHeadingWatchdog();
}

function requestOrientationIfNeeded() {
  if (typeof DeviceOrientationEvent === "undefined") {
    updateLocationStatus("当前浏览器不支持方向感应", "warning");
    updateMobileStatus("浏览器不支持方向感应", "不支持");
    return;
  }
  if (typeof DeviceOrientationEvent.requestPermission !== "function") {
    startOrientationTracking();
    return;
  }
  if (headingPermissionRequested) {
    startOrientationTracking();
    return;
  }
  headingPermissionRequested = true;
  updateLocationStatus("请允许方向权限", "info");
  DeviceOrientationEvent.requestPermission()
    .then((state) => {
      if (state === "granted") {
        startOrientationTracking();
        return;
      }
      headingPermissionRequested = false;
      updateLocationStatus("方向权限未开启", "warning");
      updateMobileStatus("方向权限未开启", "未开启");
    })
    .catch((error) => {
      console.error("方向权限获取失败：", error);
      headingPermissionRequested = false;
      updateLocationStatus("方向权限获取失败", "warning");
      updateMobileStatus("方向权限获取失败", "重试");
    });
}

function shouldUseLocationReading(accuracy) {
  if (typeof accuracy !== "number") return true;
  if (!Number.isFinite(bestAccuracySeen)) return true;
  if (accuracy <= bestAccuracySeen + ACCURACY_DOWNGRADE_TOLERANCE) return true;
  if (bestAccuracySeen <= GOOD_ACCURACY) return false;
  return accuracy <= MAX_ACCEPTABLE_ACCURACY;
}

function startMyLocation() {
  if (locationWatchId !== null) return;
  if (!navigator.geolocation) {
    updateLocationStatus("当前浏览器不支持定位", "error");
    updateMobileStatus("浏览器不支持定位", "失败");
    return;
  }

  updateLocationStatus("正在获取定位...", "info");
  updateMobileStatus("正在获取当前位置...", "定位中");
  navButton.classList.add("is-locating");

  locationWatchId = navigator.geolocation.watchPosition(
    function (position) {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      const accuracy = position.coords.accuracy;
      const roundedAccuracy = typeof accuracy === "number" ? Math.round(accuracy) : null;

      if (!shouldUseLocationReading(accuracy)) {
        updateLocationStatus(`已保留更精准蓝点，新读数约 ${roundedAccuracy} 米`, "warning");
        return;
      }

      if (typeof accuracy === "number") bestAccuracySeen = Math.min(bestAccuracySeen, accuracy);
      lastAcceptedAccuracy = roundedAccuracy;
      myLatLng = [lat, lng];
      if (communitySelect && document.activeElement !== communitySelect) renderCommunitySelector("nearby");

      if (myLocationMarker) myLocationMarker.setLatLng(myLatLng);
      else {
        myLocationMarker = L.marker(myLatLng, {
          icon: createArrowIcon(),
          interactive: false
        }).addTo(map);
      }

      updateMyLocationMarkerHeading();
      navButton.classList.remove("is-locating");
      const message = lastAcceptedAccuracy === null ? "定位成功" : `定位成功，精度约 ${lastAcceptedAccuracy} 米`;
      updateLocationStatus(message, accuracy > 80 ? "warning" : "success");

      if (!hasCenteredOnMyLocation || followHeading) {
        hasCenteredOnMyLocation = true;
        map.setView(myLatLng, Math.max(map.getZoom(), 18), { animate: true });
      }

      if (followHeading) updateMobileStatus("正在跟随当前位置和方向", "跟随中");
      else updateMobileStatus("点击指南针开启方向跟随", "已定位");
    },
    function (error) {
      navButton.classList.remove("is-locating", "is-following");
      followHeading = false;
      if (error.code === error.PERMISSION_DENIED) {
        updateLocationStatus("定位权限被拒绝", "error");
        updateMobileStatus("定位权限被拒绝", "失败");
        return;
      }
      if (error.code === error.POSITION_UNAVAILABLE) {
        updateLocationStatus("暂时无法获取当前位置", "error");
        updateMobileStatus("无法获取当前位置", "失败");
        return;
      }
      if (error.code === error.TIMEOUT) {
        updateLocationStatus("定位超时，请重试", "error");
        updateMobileStatus("定位超时，请重试", "失败");
        return;
      }
      updateLocationStatus("定位失败，请检查系统定位服务", "error");
      updateMobileStatus("定位失败", "失败");
    },
    {
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 20000
    }
  );
}

function toggleNavigation() {
  startMyLocation();
  if (!myLatLng) {
    updateLocationStatus("正在定位，稍等一下...", "info");
    updateMobileStatus("正在定位，稍等一下...", "定位中");
    return;
  }
  followHeading = !followHeading;
  if (followHeading) {
    navButton.classList.add("is-following");
    requestOrientationIfNeeded();
    map.setView(myLatLng, Math.max(map.getZoom(), 18), { animate: true });
    updateLocationStatus("方向跟随已开启", "success");
    updateMobileStatus("正在跟随当前位置和方向", "跟随中");
    return;
  }
  navButton.classList.remove("is-following");
  setMapBearing(0);
  updateLocationStatus("方向跟随已关闭", "info");
  updateMobileStatus("点击指南针开启方向跟随", "已定位");
}


function expandSmartRange(startText, endText) {
  const startRaw = String(startText || "").trim();
  const endRaw = String(endText || "").trim();
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!/^\d+$/.test(startRaw) || !/^\d+$/.test(endRaw) || !Number.isFinite(start) || !Number.isFinite(end)) return [];

  // 万用公式补零规则：只看起始号码。
  // 1-20 生成 1,2...20；01-20 生成 01,02...20；500-505 生成 500...505。
  const shouldPad = /^0\d+$/.test(startRaw);
  const width = shouldPad ? startRaw.length : 0;

  const result = [];
  const step = start <= end ? 1 : -1;
  for (let n = start; step > 0 ? n <= end : n >= end; n += step) {
    const value = String(n);
    result.push(shouldPad ? value.padStart(width, "0") : value);
  }
  return result;
}

function expandNumberToken(token) {
  const rangeMatch = String(token || "").trim().match(/^(\d+)(?:[-－—~～]|到)(\d+)$/);
  if (rangeMatch) return expandSmartRange(rangeMatch[1], rangeMatch[2]);
  if (/^\d+$/.test(String(token || "").trim())) return [String(token).trim()];
  return [];
}

function alphaApartmentLabelToNumber(value) {
  const text = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]+$/.test(text)) return NaN;
  let result = 0;
  for (const ch of text) result = result * 26 + (ch.charCodeAt(0) - 64);
  return result;
}

function numberToAlphaApartmentLabel(value) {
  let n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return "";
  let result = "";
  while (n > 0) {
    n -= 1;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

function expandAlphaApartmentRange(startText, endText) {
  const start = alphaApartmentLabelToNumber(startText);
  const end = alphaApartmentLabelToNumber(endText);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const count = Math.abs(end - start) + 1;
  if (count > 1000) return [];
  const result = [];
  const step = start <= end ? 1 : -1;
  for (let n = start; step > 0 ? n <= end : n >= end; n += step) {
    result.push(numberToAlphaApartmentLabel(n));
  }
  return result;
}

function expandApartmentUnitToken(token) {
  const text = String(token || "").trim();
  const numeric = expandNumberToken(text);
  if (numeric.length) return numeric;
  const alphaRange = text.match(/^([A-Za-z]+)(?:[-－—~～]|到)([A-Za-z]+)$/);
  if (alphaRange) return expandAlphaApartmentRange(alphaRange[1], alphaRange[2]);
  if (/^[A-Za-z]+$/.test(text)) return [text.toUpperCase()];
  // 允许只在“公寓号”框输入 3A / 4B / 12C 这种号码。
  // 前面的数字代表楼层，后面的字母代表公寓号。
  if (/^\d+[A-Za-z]+$/.test(text)) return [text.toUpperCase()];
  return [];
}

function expandApartmentUnitInput(text) {
  const result = [];
  const seen = new Set();
  const tokens = String(text || "")
    .split(/[\s,，、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  tokens.forEach((token) => {
    expandApartmentUnitToken(token).forEach((value) => {
      const normalized = /^[A-Za-z]+$/.test(value) ? value.toUpperCase() : value;
      if (!seen.has(normalized)) {
        seen.add(normalized);
        result.push(normalized);
      }
    });
  });
  return result;
}

function expandNumberInput(text) {
  const result = [];
  const seen = new Set();
  const tokens = String(text || "")
    .split(/[\s,，、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  tokens.forEach((token) => {
    expandNumberToken(token).forEach((value) => {
      if (!seen.has(value)) {
        seen.add(value);
        result.push(value);
      }
    });
  });

  return result;
}

function cleanUniversalPart(value) {
  return String(value || "").trim().replace(/\s+/g, "");
}

function getUniversalUnitRangeLabel(units) {
  const rawList = (Array.isArray(units) ? units : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  if (!rawList.length) return "独立";
  const alphaList = rawList.filter((value) => /^[A-Za-z]+$/.test(value)).map((value) => value.toUpperCase());
  if (alphaList.length === rawList.length) {
    alphaList.sort((a, b) => alphaApartmentLabelToNumber(a) - alphaApartmentLabelToNumber(b));
    if (alphaList.length === 1) return alphaList[0];
    return `${alphaList[0]}-${alphaList[alphaList.length - 1]}`;
  }

  const numericList = rawList.filter((value) => /^\d+$/.test(value)).sort((a, b) => Number(a) - Number(b));
  if (numericList.length === rawList.length) {
    // 这里只生成“没有大楼时”的地图范围牌名称，不改真实公寓号码。
    // 去掉范围牌最左边无意义的前导 0：001-009 -> 1-9，010-020 -> 10-20。
    const displayNumber = (value) => String(Number(value));
    if (numericList.length === 1) return displayNumber(numericList[0]);
    return `${displayNumber(numericList[0])}-${displayNumber(numericList[numericList.length - 1])}`;
  }

  return rawList.length === 1 ? rawList[0] : "独立";
}

function getUniversalBuildingKey(buildingText, floorText, unitRangeLabel = "") {
  const building = cleanUniversalPart(buildingText);
  const floor = cleanUniversalPart(floorText);

  // 只要填写了“大楼”框，地图表面就先显示大楼号码牌。
  // 点开大楼后才显示小号码。
  if (building) return building;

  // 没有大楼时，地图表面不显示楼层牌，而是显示小号码范围牌。
  // 适用于“楼层 + 号码”和“只有号码”两种情况。
  return unitRangeLabel || (floor ? "号码组" : "独立号码");
}

function cleanUniversalRangeText(value) {
  return String(value || "")
    .trim()
    .replace(/至|到/g, "-")
    .replace(/[－—~～]/g, "-");
}

function parseUniversalBuildingSegments(buildingText) {
  const raw = cleanUniversalRangeText(buildingText)
    .replace(/号楼|號樓|楼|樓|号|號/g, "")
    .trim();

  if (!raw) return [""];
  if (!/^[\d\s,，、;；-]+$/.test(raw)) return null;

  const buildings = expandNumberInput(raw);
  return buildings.length ? buildings : null;
}

function parseUniversalFloorSegments(floorText) {
  const raw = cleanUniversalRangeText(floorText);
  if (!raw) return [""];
  if (!/^[\d\s,，、;；-]+$/.test(raw)) return null;
  const floors = expandNumberInput(raw);
  return floors.length ? floors : null;
}

function getUniversalBuildingLabelFromKey(key) {
  const text = String(key || "").trim();
  if (!text) return "未命名";
  if (text === "独立") return "独立号码";
  if (/^F\d+$/.test(text)) return `${text.slice(1)}楼`;
  if (/^\d+\s*-\s*\d+$/.test(text)) return text;
  if (/^\d+$/.test(text)) return `${text}号楼`;
  return text;
}

function getBuildingDisplayName(building, community = getActiveCommunity()) {
  if (normalizeCommunityType(community?.type) === "universal") {
    const positions = Array.isArray(building?.positions) ? building.positions : [];
    const allWithoutBuildingInput = positions.length > 0 && positions.every((position) => !String(position?.universal?.building || "").trim());
    if (allWithoutBuildingInput) return String(building?.name || "号码组");
    return getUniversalBuildingLabelFromKey(building?.name);
  }
  return String(building?.name || "楼栋");
}

function parseUniversalTableInput(buildingText, floorText, unitText) {
  const buildingRaw = cleanUniversalRangeText(buildingText)
    .replace(/号楼|號樓|楼|樓|号|號/g, "")
    .trim();
  const floorRaw = cleanUniversalRangeText(floorText);
  const unitsRaw = cleanUniversalRangeText(unitText);

  const buildings = parseUniversalBuildingSegments(buildingText);
  if (!buildings) return { error: "大楼框只能输入阿拉伯数字、范围或空格，例如：3、3 4 6、3-6；没有大楼请留空。" };
  if (!unitsRaw) return { error: "请在公寓号框输入号码，例如 01-10、101 103，或字母公寓号 A B C / A-G。" };

  const floors = parseUniversalFloorSegments(floorRaw);
  if (!floors) return { error: "楼层框只能输入阿拉伯数字、范围或空格，例如：1、1-2、1-3、1 3；没有明确楼层段请留空。" };

  const units = expandApartmentUnitInput(unitsRaw);
  if (!units.length) return { error: "没有识别到可生成的公寓号。可使用 01-10、101 103 105、A B C、A-G，或 3A 4A。" };
  const unitRangeLabel = getUniversalUnitRangeLabel(units);
  const parsedItems = [];
  buildings.forEach((building) => {
    floors.forEach((floor) => {
      units.forEach((unit) => {
        const unitText = String(unit || "").toUpperCase();
        // 当大楼、楼层都留空并输入 3A / 12B 时，数字部分自动作为楼层、字母作为公寓号。
        // 如果用户已经填写了大楼或楼层，则公寓号按原样保存；字母仍可正常参与尾号联动判断。
        const floorLetterMatch = !building && !floor ? unitText.match(/^(\d+)([A-Z]+)$/) : null;
        const effectiveFloor = floorLetterMatch ? floorLetterMatch[1] : floor;
        const effectiveUnit = floorLetterMatch ? floorLetterMatch[2] : unitText;
        const fullNumber = floorLetterMatch ? unitText : `${building}${floor}${unitText}`;
        const groupKey = getUniversalBuildingKey(building, floor, unitRangeLabel);
        parsedItems.push({
          original: fullNumber,
          building: groupKey,
          position: fullNumber,
          unit: effectiveUnit,
          universal: { building, floor: effectiveFloor, unit: effectiveUnit, inferredFloorFromUnit: Boolean(floorLetterMatch) }
        });
      });
    });
  });

  return { parsedItems, building: buildingRaw, buildings, floor: floorRaw, floors, units, groupKey: parsedItems[0]?.building || "独立" };
}

function getExistingNumbersInCommunity(community) {
  const existing = new Set();
  (Array.isArray(community?.buildings) ? community.buildings : []).forEach((building) => {
    (Array.isArray(building.positions) ? building.positions : []).forEach((position) => {
      existing.add(String(position.position));
      (Array.isArray(position.originals) ? position.originals : []).forEach((original) => existing.add(String(original)));
    });
  });
  return existing;
}

function getUniversalUnitGroupRows() {
  if (!universalUnitGroups) return [];
  return Array.from(universalUnitGroups.querySelectorAll(".universal-unit-group")).map((row, index) => ({
    row,
    id: String(row.dataset.unitGroupId || index + 1),
    input: row.querySelector(".universal-unit-group-input"),
    physical: row.querySelector(".universal-unit-group-physical"),
    remove: row.querySelector(".universal-unit-group-remove"),
    index
  }));
}

function refreshUniversalUnitGroupRows() {
  const rows = getUniversalUnitGroupRows();
  rows.forEach((item, index) => {
    item.row.dataset.unitGroupId = String(index + 1);
    const badge = item.row.querySelector(".universal-unit-group-index");
    if (badge) badge.innerText = `规则 ${index + 1}`;
    if (item.remove) item.remove.disabled = rows.length <= 1;
  });
}

function createUniversalUnitGroupRow(value = "", samePhysical = true) {
  if (!universalUnitGroups) return null;
  const row = document.createElement("div");
  row.className = "universal-unit-group";
  row.innerHTML = `
    <span class="universal-unit-group-index">规则</span>
    <input class="universal-unit-group-input" type="text" inputmode="text" placeholder="逗号分物理位置：001-009, 010-019, 020-029" autocomplete="off">
    <label class="universal-physical-check">
      <input class="universal-unit-group-physical" type="checkbox">
      <span>每段同一物理位置</span>
    </label>
    <button class="universal-unit-group-remove" type="button" aria-label="删除这个公寓号位置组">删除</button>
  `;
  const input = row.querySelector(".universal-unit-group-input");
  const physical = row.querySelector(".universal-unit-group-physical");
  if (input) input.value = String(value || "");
  if (physical) physical.checked = Boolean(samePhysical);
  universalUnitGroups.appendChild(row);
  refreshUniversalUnitGroupRows();
  return row;
}

function resetUniversalUnitGroups() {
  if (!universalUnitGroups) return;
  universalUnitGroups.innerHTML = "";
  createUniversalUnitGroupRow("", true);
}

function splitUniversalPhysicalPositionSegments(value) {
  // 公寓号框中：英文逗号 / 中文逗号 = 下一个物理位置。
  // 同一段内部仍可用空格、分号等输入多个号码，例如：001 003 005, 010-019。
  return String(value || "")
    .split(/[,，]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function collectUniversalInputGroups() {
  const building = universalBuildingInput ? universalBuildingInput.value : "";
  const floor = universalFloorInput ? universalFloorInput.value : "";
  const rows = getUniversalUnitGroupRows();
  const groups = [];

  for (const row of rows) {
    const unitText = row.input ? row.input.value : "";
    if (!String(unitText || "").trim()) continue;

    const segments = splitUniversalPhysicalPositionSegments(unitText);
    if (!segments.length) continue;

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      const segmentText = segments[segmentIndex];
      const parsed = parseUniversalTableInput(building, floor, segmentText);
      if (parsed.error) {
        return { error: `第 ${row.index + 1} 组 · 物理位置 ${segmentIndex + 1}：${parsed.error}` };
      }

      const physicalGroupNo = groups.length + 1;
      parsed.parsedItems.forEach((item) => {
        item.universal = item.universal || {};
        item.universal.inputPositionGroup = physicalGroupNo;
        item.universal.inputRuleGroup = row.index + 1;
        item.universal.inputPhysicalSegment = segmentIndex + 1;
        item.universal.samePhysicalPosition = Boolean(row.physical?.checked);
      });

      groups.push({
        id: `${row.index + 1}.${segmentIndex + 1}`,
        index: physicalGroupNo - 1,
        sourceRowIndex: row.index,
        segmentIndex,
        sourceText: segmentText,
        samePhysical: Boolean(row.physical?.checked),
        parsed
      });
    }
  }

  if (!groups.length) return { error: "请至少填写一个公寓号位置组。" };
  return { building, floor, groups };
}

function getUniversalPreviewText() {
  const collected = collectUniversalInputGroups();
  if (collected.error) return collected.error;
  const allItems = collected.groups.flatMap((group) => group.parsed.parsedItems);
  const buildingNames = new Set(allItems.map((item) => String(item.universal?.building || "")).filter(Boolean));
  const physicalCount = collected.groups.filter((group) => group.samePhysical).length;
  const summaries = collected.groups.map((group, index) => {
    const values = group.parsed.parsedItems.map((item) => item.original);
    const preview = values.length > 6 ? `${values.slice(0, 6).join("、")}…` : values.join("、");
    return `位置${index + 1}${group.samePhysical ? "（叠放）" : "（独立）"}：${preview}`;
  });
  const buildingText = buildingNames.size > 1 ? `${buildingNames.size} 栋大楼，` : "";
  return `将生成 ${buildingText}${allItems.length} 个号码；${physicalCount} 个勾选的物理位置组。${summaries.join(" ｜ ")}`;
}

function updateUniversalPreview() {
  if (universalPreview) universalPreview.innerText = getUniversalPreviewText();
}

function openUniversalNumberPanel(latlng) {
  pendingLatLng = latlng;
  const community = ensureActiveCommunity();
  if (universalNumberTitle) universalNumberTitle.innerText = `万用号码输入：${community.name}`;
  if (universalBuildingInput) universalBuildingInput.value = "";
  if (universalFloorInput) universalFloorInput.value = "";
  resetUniversalUnitGroups();
  updateUniversalPreview();
  if (universalNumberPanel) universalNumberPanel.classList.add("is-open");
  setTimeout(() => universalBuildingInput && universalBuildingInput.focus(), 80);
}

function closeUniversalNumberPanel() {
  pendingLatLng = null;
  if (universalNumberPanel) universalNumberPanel.classList.remove("is-open");
}

function normalizePhysicalTailLabel(value) {
  const text = String(value || "").trim().toUpperCase();
  if (!text) return "";
  const letterTail = text.match(/([A-Z]+)$/);
  if (letterTail) return `alpha:${letterTail[1]}`;
  if (/^\d+$/.test(text)) return `numExact:${text}`;
  return "";
}

function getPhysicalUnitDisplayLabel(key) {
  const text = String(key || "").split("|building:")[0];
  if (text.startsWith("alpha:")) return text.slice(6);
  if (text.startsWith("numExact:")) return text.slice(9);
  if (text.startsWith("num:")) return text.slice(4);
  return text;
}

function getPositionPhysicalCandidate(position) {
  const universal = position?.universal || {};
  const building = String(universal.building || "").trim();
  const floor = String(universal.floor || "").trim();
  const unit = String(universal.unit || "").trim().toUpperCase();
  const positionText = String(position?.position || position?.original || "").trim().toUpperCase();

  // 只要“公寓号”本身带有英文字母，就看最后的英文字母作为可能的公用尾号。
  // 例如 A、1A、12A 都归入 A 候选组。是否真正联动仍由用户确认。
  const alphaKey = normalizePhysicalTailLabel(unit || positionText);
  if (alphaKey.startsWith("alpha:")) {
    return building ? `${alphaKey}|building:${building}` : alphaKey;
  }

  // 用户明确填写了大楼或楼层时，“公寓号”字段本身就是公用号码候选。
  // 例如 1楼/01、2楼/01，或者 5号楼/1楼/01 与 5号楼/2楼/01。
  if ((building || floor) && /^\d+$/.test(unit)) {
    return building ? `numExact:${unit}|building:${building}` : `numExact:${unit}`;
  }

  // 没有大楼、没有楼层，且只是直接输入完整纯数字号码（101/201/301）时，
  // 交给 collectPhysicalUnitGroups 自动寻找最长的重复数字尾号。
  return "";
}

function collectPhysicalUnitGroups(community) {
  const refs = [];
  (Array.isArray(community?.buildings) ? community.buildings : []).forEach((building) => {
    (Array.isArray(building?.positions) ? building.positions : []).forEach((position) => {
      refs.push({ building, position });
    });
  });

  const groups = new Map();
  const assignedNumericIds = new Set();

  // 第一类：明确的公寓号字段（数字或字母）。字母看最后的英文字母；数字看完整公寓号字段。
  refs.forEach((ref) => {
    const key = getPositionPhysicalCandidate(ref.position);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ref);
  });

  // 第二类：没有大楼、没有楼层，只直接输入完整纯数字号码，例如 101/201/301。
  // 从 3 位尾号到 1 位尾号寻找“最长且重复”的尾号。
  const numericRefs = refs.filter(({ position }) => {
    const universal = position?.universal || {};
    const text = String(position?.position || "").trim();
    return !String(universal.building || "").trim()
      && !String(universal.floor || "").trim()
      && /^\d{2,}$/.test(text);
  });

  [3, 2, 1].forEach((suffixLength) => {
    const candidates = new Map();
    numericRefs.forEach((ref) => {
      if (assignedNumericIds.has(ref.position.id)) return;
      const text = String(ref.position.position || "").trim();
      if (text.length <= suffixLength) return;
      const suffix = text.slice(-suffixLength);
      if (!candidates.has(suffix)) candidates.set(suffix, []);
      candidates.get(suffix).push(ref);
    });

    candidates.forEach((items, suffix) => {
      if (items.length < 2) return;
      const prefixes = new Set(items.map(({ position }) => String(position.position).slice(0, -suffixLength)));
      if (prefixes.size < 2) return;
      const key = `num:${suffix}`;
      groups.set(key, items);
      items.forEach(({ position }) => assignedNumericIds.add(position.id));
    });
  });

  // 至少两个不同完整号码才需要询问联动。
  return new Map(Array.from(groups.entries()).filter(([, items]) => {
    const numbers = new Set(items.map(({ position }) => String(position.position)));
    return items.length >= 2 && numbers.size >= 2;
  }));
}

function arrangePhysicalUnitGroup(key, refs) {
  if (!refs.length) return;
  const anchor = refs.find(({ position }) => Number.isFinite(Number(position?.lat)) && Number.isFinite(Number(position?.lng)));
  if (!anchor) return;
  const lat = Number(anchor.position.lat);
  const lng = Number(anchor.position.lng);
  refs.forEach(({ position }) => {
    position.lat = lat;
    position.lng = lng;
    if (!position.universal) position.universal = {};
    position.universal.physicalStackKey = key;
  });
}

function clearPhysicalUnitGroupBinding(refs) {
  refs.forEach(({ position }) => {
    if (position?.universal) delete position.universal.physicalStackKey;
  });
}

function askAndApplyPhysicalUnitGrouping(community) {
  const groups = collectPhysicalUnitGroups(community);
  if (!groups.size) return 0;

  let linkedCount = 0;
  Array.from(groups.entries()).forEach(([key, refs]) => {
    const nums = refs
      .map(({ position }) => String(position.position))
      .sort((a, b) => String(a).localeCompare(String(b), "zh-CN", { numeric: true }));
    const tail = getPhysicalUnitDisplayLabel(key);
    const samePlace = confirm(
      `检测到公寓号尾号“${tail}”相同：\n\n${nums.join(" / ")}\n\n这些号码在现实中是否处于同一个物理位置？\n\n确定 = 是：绑定为一组，拖动其中任意一个时整组一起移动。\n取消 = 否：这些号码保持各自独立。`
    );

    if (samePlace) {
      arrangePhysicalUnitGroup(key, refs);
      linkedCount += 1;
    } else {
      clearPhysicalUnitGroupBinding(refs);
    }
  });
  return linkedCount;
}

function getLinkedPhysicalPositions(community, item) {
  const key = String(item?.universal?.physicalStackKey || "").trim();
  if (!key) return [item];
  const linked = [];
  (Array.isArray(community?.buildings) ? community.buildings : []).forEach((building) => {
    (Array.isArray(building?.positions) ? building.positions : []).forEach((position) => {
      if (String(position?.universal?.physicalStackKey || "") === key) linked.push(position);
    });
  });
  return linked.length ? linked : [item];
}

function applyPositionDragWithPhysicalGroup(building, item, startLatLng, endLatLng) {
  const oldLat = Number(startLatLng?.lat ?? item?.lat);
  const oldLng = Number(startLatLng?.lng ?? item?.lng);
  const newLat = Number(endLatLng?.lat);
  const newLng = Number(endLatLng?.lng);
  if (![oldLat, oldLng, newLat, newLng].every(Number.isFinite)) return;

  const deltaLat = newLat - oldLat;
  const deltaLng = newLng - oldLng;
  const community = getActiveCommunity();
  const linked = getLinkedPhysicalPositions(community, item);
  linked.forEach((position) => {
    position.lat = Number(position.lat) + deltaLat;
    position.lng = Number(position.lng) + deltaLng;
  });
}

function addUniversalNumbersAtLatLng(latlng, buildingText, floorText, inputGroups) {
  const community = ensureActiveCommunity();
  const groups = Array.isArray(inputGroups) ? inputGroups : [];
  if (!groups.length) {
    alert("请至少填写一个公寓号位置组。");
    return false;
  }

  const parsedItems = groups.flatMap((group) => group.parsed?.parsedItems || []);
  if (parsedItems.length > 500) {
    alert("一次最多生成 500 个号码。请分批添加，避免地图太卡。");
    return false;
  }

  if (!Array.isArray(community.buildings)) community.buildings = [];
  const existing = getExistingNumbersInCommunity(community);
  const seenInThisBatch = new Set();
  const toAdd = [];
  let skipped = 0;

  groups.forEach((group, groupIndex) => {
    (group.parsed?.parsedItems || []).forEach((item) => {
      const full = String(item.original);
      if (existing.has(full) || seenInThisBatch.has(full)) {
        skipped += 1;
        return;
      }
      seenInThisBatch.add(full);
      item.universal = item.universal || {};
      item.universal.inputPositionGroup = groupIndex + 1;
      item.universal.samePhysicalPosition = Boolean(group.samePhysical);
      toAdd.push(item);
    });
  });

  if (!toAdd.length) {
    alert("这些号码在当前公寓名牌里已经存在，没有新增。\n\n同一个公寓名牌内完整号码不能重复。");
    return false;
  }

  const previewValues = toAdd.map((item) => item.original);
  const preview = previewValues.length > 80 ? `${previewValues.slice(0, 80).join(", ")} ...` : previewValues.join(", ");
  const checkedGroupCount = groups.filter((group) => group.samePhysical).length;
  const ok = confirm(
    `确定在“${community.name}”里生成 ${toAdd.length} 个号码吗？

${preview}

${skipped ? `其中 ${skipped} 个重复号码会自动跳过。

` : ""}本次有 ${checkedGroupCount} 个“同一物理位置”组；每个勾选组里的全部完整号码会使用完全相同的经纬度。`
  );
  if (!ok) return false;

  pushHistory();

  const groupedToAdd = new Map();
  toAdd.forEach((item) => {
    if (!groupedToAdd.has(item.building)) groupedToAdd.set(item.building, []);
    groupedToAdd.get(item.building).push(item);
  });

  const physicalBatchId = makeId("physicalBatch");
  let firstTouchedBuildingId = null;
  let physicalStackCount = 0;

  Array.from(groupedToAdd.entries()).forEach(([buildingKey, itemsForBuilding], buildingIndex) => {
    let building = community.buildings.find((item) => item.name === buildingKey);
    const existingBuildingLat = Number(building?.lat);
    const existingBuildingLng = Number(building?.lng);
    const buildingLatLng = building && Number.isFinite(existingBuildingLat) && Number.isFinite(existingBuildingLng)
      ? { lat: existingBuildingLat, lng: existingBuildingLng }
      : groupedToAdd.size > 1
      ? getBulkBuildingCenterLatLng(latlng, buildingIndex, groupedToAdd.size)
      : latlng;

    if (!building) {
      building = {
        id: makeId("building"),
        name: buildingKey,
        lat: buildingLatLng.lat,
        lng: buildingLatLng.lng,
        color: markerColor,
        size: markerSize,
        fontSize,
        shape: markerShape,
        positions: []
      };
      community.buildings.push(building);
    }

    if (!firstTouchedBuildingId) firstTouchedBuildingId = building.id;

    const inputGroupsForBuilding = new Map();
    itemsForBuilding.forEach((item) => {
      const groupNo = Number(item.universal?.inputPositionGroup) || 1;
      if (!inputGroupsForBuilding.has(groupNo)) inputGroupsForBuilding.set(groupNo, []);
      inputGroupsForBuilding.get(groupNo).push(item);
    });

    const groupEntries = Array.from(inputGroupsForBuilding.entries()).sort((a, b) => a[0] - b[0]);
    groupEntries.forEach(([groupNo, groupItems], localGroupIndex) => {
      const groupCenter = groupEntries.length > 1
        ? getBulkBuildingCenterLatLng(buildingLatLng, localGroupIndex, groupEntries.length)
        : buildingLatLng;
      const samePhysical = groupItems.some((item) => Boolean(item.universal?.samePhysicalPosition));
      const physicalStackKey = samePhysical ? `${physicalBatchId}|building:${building.id}|positionGroup:${groupNo}` : "";
      const independentPositionMap = samePhysical ? null : getUniversalInitialPositionMap(groupCenter, groupItems);
      if (samePhysical) physicalStackCount += 1;

      groupItems.forEach((item, index) => {
        const pointLatLng = samePhysical
          ? { lat: Number(groupCenter.lat), lng: Number(groupCenter.lng) }
          : independentPositionMap?.get(item) || getFlatBulkAddLatLng(groupCenter, index, groupItems.length);
        const universal = { ...(item.universal || {}) };
        if (physicalStackKey) universal.physicalStackKey = physicalStackKey;
        else delete universal.physicalStackKey;
        building.positions.push({
          id: makeId("position"),
          position: item.position,
          lat: pointLatLng.lat,
          lng: pointLatLng.lng,
          originals: [item.original],
          universal
        });
        existing.add(String(item.original));
      });
    });
  });

  community.type = "universal";
  community.lat = Number(latlng.lat);
  community.lng = Number(latlng.lng);
  appData.activeCommunityId = community.id;
  selectedBuildingId = firstTouchedBuildingId;
  selectedPositions.clear();
  displayMode = "buildings";
  saveData();
  renderCommunitySelector();
  closeBuildingPanel();
  renderMap();
  const touchedBuildingCount = groupedToAdd.size;
  updateLocationStatus(`已生成 ${touchedBuildingCount} 栋大楼 / ${toAdd.length} 个号码${skipped ? `，跳过 ${skipped} 个重复号码` : ""}。已建立 ${physicalStackCount} 个物理位置组；每组最小完整号码会显示在最上层。`, "success");
  return true;
}

function confirmUniversalNumberInput() {
  if (!pendingLatLng) return;
  const collected = collectUniversalInputGroups();
  if (collected.error) {
    alert(collected.error);
    return;
  }
  const ok = addUniversalNumbersAtLatLng(
    pendingLatLng,
    collected.building,
    collected.floor,
    collected.groups
  );
  if (ok) closeUniversalNumberPanel();
}

function splitNumberInputRows(text) {
  return String(text || "")
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function getGroupFullFloorKey(numberText) {
  const text = String(numberText || "").trim();
  if (!/^\d{3,}$/.test(text)) return "";
  if (text.length === 4) return String(Number(text[0]));
  return String(Number(text.slice(0, -2)));
}

function isContinuousNumberList(numbers) {
  if (!Array.isArray(numbers) || numbers.length <= 1) return true;
  const numeric = numbers.map((value) => Number(value));
  if (numeric.some((value) => !Number.isFinite(value))) return false;
  const step = numeric[1] >= numeric[0] ? 1 : -1;
  for (let index = 1; index < numeric.length; index += 1) {
    if (numeric[index] - numeric[index - 1] !== step) return false;
  }
  return true;
}

function groupNumbersByFloorRange(numbers) {
  const groups = new Map();
  (numbers || []).forEach((number) => {
    const text = String(number || "").trim();
    if (!/^\d{3,}$/.test(text)) return;
    const floorKey = getGroupFullFloorKey(text);
    if (!groups.has(floorKey)) groups.set(floorKey, []);
    groups.get(floorKey).push(text);
  });

  return Array.from(groups.keys())
    .sort((a, b) => Number(a) - Number(b))
    .map((floorKey) => compactNumberRange(groups.get(floorKey)))
    .filter(Boolean);
}

function makeGroupDisplayLinesFromRow(rowText, numbers) {
  const text = String(rowText || "").trim();
  if (!numbers.length) return [];

  const singleRange = text.match(/^\s*\d+\s*(?:[-－—~～]|到)\s*\d+\s*$/);
  if (singleRange) {
    const rangeParts = text.match(/(\d+)\s*(?:[-－—~～]|到)\s*(\d+)/);
    if (rangeParts) {
      const startText = rangeParts[1];
      const endText = rangeParts[2];
      const width = Math.max(startText.length, endText.length);
      const startPadded = String(Number(startText)).padStart(width, "0");
      const endPadded = String(Number(endText)).padStart(width, "0");
      if (width >= 3 && startPadded[0] !== endPadded[0]) {
        const floorLines = groupNumbersByFloorRange(numbers);
        if (floorLines.length) return floorLines;
      }
    }
    return [compactNumberRange(numbers)];
  }

  if (isContinuousNumberList(numbers)) return [compactNumberRange(numbers)];

  if (numbers.length <= 4) return [numbers.join(" ")];
  return [`${numbers[0]}-${numbers[numbers.length - 1]}`];
}

function parseGroupFullRows(text) {
  let rows = splitNumberInputRows(text);
  if (rows.length === 0 && String(text || "").trim()) rows = [String(text).trim()];

  const seen = new Set();
  const numbers = [];
  const displayLines = [];

  rows.forEach((row) => {
    const rowNumbers = expandNumberInput(row);
    if (!rowNumbers.length) return;

    makeGroupDisplayLinesFromRow(row, rowNumbers).forEach((line) => {
      if (line) displayLines.push(line);
    });

    rowNumbers.forEach((number) => {
      if (!seen.has(number)) {
        seen.add(number);
        numbers.push(number);
      }
    });
  });

  return { numbers, displayLines };
}

function guessSecondFloorStart(firstNumber) {
  const text = String(firstNumber || "");
  if (!/^\d+$/.test(text)) return "";
  if (text.length >= 4) return String(Number(text) + 1000);
  if (text.length >= 3) return String(Number(text) + 100);
  return "";
}

function makeShiftedNumberList(numbers, secondStartText) {
  if (!numbers.length || !/^\d+$/.test(String(secondStartText || ""))) return [];
  const first = Number(numbers[0]);
  const secondStart = Number(secondStartText);
  const shift = secondStart - first;
  return numbers.map((number) => String(Number(number) + shift).padStart(String(secondStartText).length, "0"));
}

function makeInitialGroupLatLng(center, index, total) {
  // 楼组完整号码模式：新生成的号码默认全部放在楼组同一个中心点。
  // 这样 101/201、1001/2001 这类上下楼对应号码不会被系统自动错开。
  // 如果需要单独调整某一个号码，可在底部面板选择该号码后只显示选中，再拖动微调。
  return {
    lat: center.lat,
    lng: center.lng
  };
}

function addFullNumberGroup(latlng) {
  const community = ensureActiveCommunity();
  const rowsText = prompt(
    "请输入楼组每一层/每一行的号码：\n\n一行代表地图楼组标记上的一行。\n\n例，两层：\n101-116\n201-216\n\n例，三层：\n101-116\n201-216\n301-316\n\n也可以粘贴不连续号码：\n101 102 103 104 109 110\n201 202 203 204 209 210",
    "101-116\n201-216"
  );
  if (!rowsText || !rowsText.trim()) return false;

  const parsed = parseGroupFullRows(rowsText);
  const numbers = parsed.numbers;
  const displayLines = parsed.displayLines;

  if (!numbers.length) {
    alert("没有识别到可用号码。可以输入 101-116，或每行输入一层号码。\n例如：\n101-116\n201-216\n301-316");
    return false;
  }

  const groupName = displayLines.length ? displayLines.join(" / ") : compactNumberRange(numbers) || "楼组";

  if (!confirm(`楼组显示：\n${displayLines.join("\n")}\n\n将添加 ${numbers.length} 个号码：\n${numbers.join(", ")}\n\n确认添加吗？`)) return false;

  pushHistory();
  const building = {
    id: makeId("building"),
    name: groupName,
    lat: latlng.lat,
    lng: latlng.lng,
    color: markerColor,
    size: Math.max(markerSize, 16),
    fontSize: Math.max(fontSize, 8),
    shape: "rectangle",
    groupDisplayLines: displayLines.length ? displayLines : [groupName],
    positions: numbers.map((number, index) => {
      const initial = makeInitialGroupLatLng(latlng, index, numbers.length);
      return {
        id: makeId("position"),
        position: number,
        lat: initial.lat,
        lng: initial.lng,
        originals: [number]
      };
    })
  };

  community.buildings.push(building);
  selectedBuildingId = building.id;
  selectedPositions.clear();
  displayMode = "buildings";
  saveData();
  renderMap();
  openBuildingPanel(building.id);
  updateLocationStatus(`楼组 ${groupName} 已添加 ${numbers.length} 个号码，号码默认重叠在楼组点`, "success");
  return true;
}

function openAddFlow(latlng) {
  ensureActiveCommunity();
  openUniversalNumberPanel(latlng);
}

function addMarkerAtCenter() {
  if (isMobileKeypadOnlyMode() && !mobileEditMode) {
    updateLocationStatus("手机端送包裹模式不能新增标记，请在菜单中进入编辑模式", "warning");
    openMobileModePanel();
    return;
  }
  addHereBtn.classList.add("is-pressed");
  setTimeout(() => addHereBtn.classList.remove("is-pressed"), 180);
  openAddFlow(map.getCenter());
}



function isNumberPadOpen() {
  const pad = document.getElementById("numberPad");
  return Boolean(pad && pad.classList.contains("is-open") && pendingLatLng);
}

function confirmNumberPadInput() {
  if (!pendingLatLng || !currentInput) return;
  const ok = addApartmentNumber(pendingLatLng, currentInput);
  if (ok) closeNumberPad();
}

window.addEventListener("keydown", function (event) {
  if (!isNumberPadOpen()) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;

  if (/^\d$/.test(event.key)) {
    event.preventDefault();
    appendInputChar(event.key);
    return;
  }

  if (event.key === "Backspace") {
    event.preventDefault();
    appendInputChar("⌫");
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    confirmNumberPadInput();
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    closeNumberPad();
  }
});

document.querySelectorAll(".numBtn").forEach((button) => {
  button.addEventListener("click", function () {
    appendInputChar(this.innerText);
  });
});

const confirmNumberBtn = document.getElementById("confirmNumber");
if (confirmNumberBtn) confirmNumberBtn.addEventListener("click", confirmNumberPadInput);

const cancelNumberBtn = document.getElementById("cancelNumber");
if (cancelNumberBtn) cancelNumberBtn.addEventListener("click", closeNumberPad);

[universalBuildingInput, universalFloorInput].forEach((input) => {
  if (!input) return;
  input.addEventListener("input", updateUniversalPreview);
  input.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmUniversalNumberInput();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeUniversalNumberPanel();
    }
  });
});
if (universalUnitGroups) {
  universalUnitGroups.addEventListener("input", updateUniversalPreview);
  universalUnitGroups.addEventListener("change", updateUniversalPreview);
  universalUnitGroups.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmUniversalNumberInput();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeUniversalNumberPanel();
    }
  });
  universalUnitGroups.addEventListener("click", function (event) {
    const removeBtn = event.target.closest(".universal-unit-group-remove");
    if (!removeBtn) return;
    const row = removeBtn.closest(".universal-unit-group");
    if (!row || getUniversalUnitGroupRows().length <= 1) return;
    row.remove();
    refreshUniversalUnitGroupRows();
    updateUniversalPreview();
  });
}
if (addUniversalUnitGroupBtn) addUniversalUnitGroupBtn.addEventListener("click", function () {
  const row = createUniversalUnitGroupRow("", true);
  updateUniversalPreview();
  const input = row && row.querySelector(".universal-unit-group-input");
  if (input) input.focus();
});
if (confirmUniversalNumberBtn) confirmUniversalNumberBtn.addEventListener("click", confirmUniversalNumberInput);
if (cancelUniversalNumberBtn) cancelUniversalNumberBtn.addEventListener("click", closeUniversalNumberPanel);
if (closeUniversalNumberPanelBtn) closeUniversalNumberPanelBtn.addEventListener("click", closeUniversalNumberPanel);
document.getElementById("menuBtn").addEventListener("click", function () {
  if (isMobileKeypadOnlyMode()) openMobileModePanel();
  else settingsPanel.classList.toggle("is-open");
});
if (closeMobileModePanelBtn) closeMobileModePanelBtn.addEventListener("click", closeMobileModePanel);
if (mobileToggleEditModeBtn) mobileToggleEditModeBtn.addEventListener("click", toggleMobileEditMode);
if (mobileImportJsonBtn) mobileImportJsonBtn.addEventListener("click", openJsonImportPicker);
if (mobileExportJsonBtn) mobileExportJsonBtn.addEventListener("click", exportMarkers);
if (mobileOpenSettingsBtn) mobileOpenSettingsBtn.addEventListener("click", function () {
  closeMobileModePanel();
  settingsPanel.classList.toggle("is-open");
});

document.getElementById("settingsBtn").addEventListener("click", function () {
  settingsPanel.classList.toggle("is-open");
});
const closeSettingsPanelBtn = document.getElementById("closeSettingsPanelBtn");
if (closeSettingsPanelBtn) {
  closeSettingsPanelBtn.addEventListener("click", function () {
    settingsPanel.classList.remove("is-open");
  });
}



// 关闭规则：各窗口使用自身的关闭键，不使用点击空白处自动关闭。

document.getElementById("undoBtn").addEventListener("click", undoLastAction);
document.getElementById("exportBtn").addEventListener("click", exportMarkers);
const importJsonBtn = document.getElementById("importJsonBtn");
if (importJsonBtn) importJsonBtn.addEventListener("click", openJsonImportPicker);
const migrationImportBtn = document.getElementById("migrationImportBtn");
const migrationImportInput = document.getElementById("migrationImportInput");
const migrationOverwriteCloudBtn = document.getElementById("migrationOverwriteCloudBtn");
const mobileMigrationImportBtn = document.getElementById("mobileMigrationImportBtn");
const mobileMigrationOverwriteCloudBtn = document.getElementById("mobileMigrationOverwriteCloudBtn");
if (migrationImportBtn) migrationImportBtn.addEventListener("click", openMigrationImportPicker);
if (mobileMigrationImportBtn) mobileMigrationImportBtn.addEventListener("click", openMigrationImportPicker);
if (migrationImportInput) migrationImportInput.addEventListener("change", (event) => importMigrationReplacementFile(event.target.files && event.target.files[0]));
if (migrationOverwriteCloudBtn) migrationOverwriteCloudBtn.addEventListener("click", overwriteCloudWithCurrentMigrationData);
if (mobileMigrationOverwriteCloudBtn) mobileMigrationOverwriteCloudBtn.addEventListener("click", overwriteCloudWithCurrentMigrationData);
document.getElementById("applySettingsBtn").addEventListener("click", applyCurrentSettingsToAllMarkers);
document.getElementById("navButton").addEventListener("click", toggleNavigation);
document.getElementById("addHereBtn").addEventListener("click", addMarkerAtCenter);
document.getElementById("closeBuildingPanel").addEventListener("click", closeBuildingPanel);
document.getElementById("showSelectedPositions").addEventListener("click", showSelectedPositionsForCurrentBuilding);
document.getElementById("showAllPositions").addEventListener("click", showAllPositionsForCurrentBuilding);
document.getElementById("restoreBuildings").addEventListener("click", restoreBuildingsMode);
document.getElementById("deleteSelectedPositions").addEventListener("click", deleteSelectedPositionsForCurrentBuilding);
document.getElementById("bulkDeletePositions").addEventListener("click", handleBulkPositionsAction);
if (addBuildingPhotoBtn) addBuildingPhotoBtn.addEventListener("click", () => {
  const building = getBuildingById(selectedBuildingId);
  if (!building) return;
  if (getBuildingPhotoMeta(building)) openBuildingPhotoViewer(building.id);
  else requestBuildingPhotoFile(building.id);
});
if (buildingPhotoInput) buildingPhotoInput.addEventListener("change", handleBuildingPhotoFileSelected);
if (closeBuildingPhotoViewerBtn) closeBuildingPhotoViewerBtn.addEventListener("click", closeBuildingPhotoViewer);
if (replaceBuildingPhotoBtn) replaceBuildingPhotoBtn.addEventListener("click", replaceCurrentBuildingPhoto);
if (deleteBuildingPhotoBtn) deleteBuildingPhotoBtn.addEventListener("click", deleteCurrentBuildingPhoto);
if (closeCommunitySearchPanelBtn) closeCommunitySearchPanelBtn.addEventListener("click", closeCommunitySearchPanel);
if (confirmCommunityNumberSearchBtn) confirmCommunityNumberSearchBtn.addEventListener("click", showCommunityNumberSearchResults);
if (showAllCommunityNumbersBtn) showAllCommunityNumbersBtn.addEventListener("click", showAllNumbersForCommunity);
if (showCommunityBuildingsOnlyBtn) showCommunityBuildingsOnlyBtn.addEventListener("click", showCommunityBuildingsOnly);
if (togglePendingRouteListBtn) togglePendingRouteListBtn.addEventListener("click", togglePendingDeliveryPanel);
if (closePendingRoutePanelBtn) closePendingRoutePanelBtn.addEventListener("click", function (event) {
  event.preventDefault();
  event.stopPropagation();
  deliveryPendingPanelOpen = false;
  deliveryDeliveredPanelOpen = false;
  renderDeliveryRoutePanel();
});
if (toggleDeliveredRouteListBtn) toggleDeliveredRouteListBtn.addEventListener("click", toggleDeliveredDeliveryPanel);
if (addDeliveryRouteNumberBtn) addDeliveryRouteNumberBtn.addEventListener("click", promptAddDeliveryRouteNumber);
if (planDeliveryRouteBtn) planDeliveryRouteBtn.addEventListener("click", () => planDeliveryRoute({ reason: "manual" }));
if (changeRoutesApiKeyBtn) changeRoutesApiKeyBtn.addEventListener("click", changeRoutesApiKey);
if (clearRoutesApiKeyBtn) clearRoutesApiKeyBtn.addEventListener("click", clearRoutesApiKey);
if (endDeliveryRouteBtn) endDeliveryRouteBtn.addEventListener("click", finishCurrentDeliveryRoute);
updateRoutesApiMiniStatus();
if (finishDeliveryRouteBtn) finishDeliveryRouteBtn.addEventListener("click", finishCurrentDeliveryRoute);
if (undoDeliveryHideBtn) undoDeliveryHideBtn.addEventListener("click", undoLastDeliveryHide);
if (closeDeliveryToastBtn) closeDeliveryToastBtn.addEventListener("click", hideDeliveryToast);
function deleteCommunitySearchText() {
  if (!communityNumberSearchInput) return;

  const start = typeof communityNumberSearchInput.selectionStart === "number" ? communityNumberSearchInput.selectionStart : communityNumberSearchInput.value.length;
  const end = typeof communityNumberSearchInput.selectionEnd === "number" ? communityNumberSearchInput.selectionEnd : communityNumberSearchInput.value.length;

  if (start !== end) {
    communityNumberSearchInput.value = communityNumberSearchInput.value.slice(0, start) + communityNumberSearchInput.value.slice(end);
    communityNumberSearchInput.setSelectionRange(start, start);
  } else if (start > 0) {
    communityNumberSearchInput.value = communityNumberSearchInput.value.slice(0, start - 1) + communityNumberSearchInput.value.slice(start);
    communityNumberSearchInput.setSelectionRange(start - 1, start - 1);
  }

  if (!isMobileKeypadOnlyMode()) communityNumberSearchInput.focus();
}

function runCommunitySearchKeyButton(button) {
  if (!button) return;
  if (button.dataset.searchInsert !== undefined) {
    insertCommunitySearchText(button.dataset.searchInsert || "");
    return;
  }
  if (button.dataset.searchAction === "backspace") {
    deleteCommunitySearchText();
    return;
  }
  if (button.dataset.searchAction === "letters") {
    if (communitySearchKeypad) communitySearchKeypad.classList.add("is-letter-mode");
    return;
  }
  if (button.dataset.searchAction === "numbers") {
    if (communitySearchKeypad) communitySearchKeypad.classList.remove("is-letter-mode");
  }
}

// 手机端九宫格改用 pointerdown/touchstart 先触发，避免全局“双击防放大”拦截快速连续点击。
// 触摸触发后，浏览器通常还会补发一次 click；这里专门忽略这次补发，避免点一次出现两个数字。
// 电脑端鼠标仍走 click，方便正常点击。
document.querySelectorAll(".community-search-keypad button").forEach((button) => {
  button.addEventListener("pointerdown", function (event) {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    this.dataset.ignoreNextClickUntil = String(Date.now() + 650);
    runCommunitySearchKeyButton(this);
  });

  if (!window.PointerEvent) {
    button.addEventListener("touchstart", function (event) {
      event.preventDefault();
      this.dataset.ignoreNextClickUntil = String(Date.now() + 650);
      runCommunitySearchKeyButton(this);
    }, { passive: false });
  }

  button.addEventListener("click", function () {
    const ignoreUntil = Number(this.dataset.ignoreNextClickUntil || 0);
    if (Date.now() < ignoreUntil) return;
    runCommunitySearchKeyButton(this);
  });
});
if (communityNumberSearchInput) {
  configureMobileSearchInputKeyboard();
  communityNumberSearchInput.addEventListener("pointerdown", function (event) {
    if (!isMobileKeypadOnlyMode()) return;
    event.preventDefault();
    communityNumberSearchInput.blur();
  });
  communityNumberSearchInput.addEventListener("touchstart", function (event) {
    if (!isMobileKeypadOnlyMode()) return;
    event.preventDefault();
    communityNumberSearchInput.blur();
  }, { passive: false });
  window.addEventListener("resize", configureMobileSearchInputKeyboard);
  communityNumberSearchInput.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") showCommunityNumberSearchResults();
    if (event.key === "Escape") closeCommunitySearchPanel();
  });
}

document.getElementById("bgToggleBtn").addEventListener("click", restoreBuildingsMode);
if (communitySelect) {
  function openNearbyCommunityAddressSuggestions() {
    const active = getActiveCommunity();
    communityInputPreviousValue = active ? active.name : String(communitySelect.value || "");
    communitySelect.placeholder = active ? `当前：${active.name} / 输入地址搜索` : "输入地址搜索";

    // 点旁边的下拉按钮：只显示附近 2-3 个公寓地址，不弹手机键盘。
    renderCommunityOptions(getNearbyCommunities(3), true);
  }

  function prepareCommunityAddressTyping() {
    clearCommunitySuggestionCloseTimer();
    const active = getActiveCommunity();
    communitySelect.placeholder = active ? `当前：${active.name} / 输入地址搜索` : "输入地址搜索";
    // 点输入框只负责输入搜索，不自动弹出附近地址下拉。
    // 如果用户开始输入，input 事件会显示全记录匹配结果。
    if (!String(communitySelect.value || "").trim()) hideCommunitySuggestionPanel();
  }

  communitySelect.addEventListener("pointerdown", function (event) {
    event.stopPropagation();
    prepareCommunityAddressTyping();
  });

  communitySelect.addEventListener("touchstart", function (event) {
    event.stopPropagation();
    prepareCommunityAddressTyping();
  }, { passive: true });

  communitySelect.addEventListener("focus", function () {
    prepareCommunityAddressTyping();
  });

  communitySelect.addEventListener("click", function (event) {
    event.stopPropagation();
    prepareCommunityAddressTyping();
  });

  communitySelect.addEventListener("blur", function () {
    clearCommunitySuggestionCloseTimer();
    setTimeout(() => {
      const active = getActiveCommunity();
      if (!String(communitySelect.value || "").trim()) {
        communitySelect.placeholder = active ? `当前：${active.name} / 输入地址搜索` : "输入地址搜索";
      }
    }, 260);
  });

  if (communityDropdownBtn) {
    // 手机端会同时触发 pointerdown / touchstart / click。
    // 之前用“打开/关闭切换”会导致第一次打开后，第二个事件又马上关闭，
    // 所以这里改成：下拉按钮永远只负责“打开附近公寓”，不负责关闭。
    let lastDropdownOpenAt = 0;

    function handleNearbyDropdownOpen(event) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }

      const now = Date.now();
      if (now - lastDropdownOpenAt < 180) return;
      lastDropdownOpenAt = now;

      clearCommunitySuggestionCloseTimer();
      if (communitySelect) communitySelect.blur();
      openNearbyCommunityAddressSuggestions();
    }

    communityDropdownBtn.addEventListener("pointerdown", handleNearbyDropdownOpen, { passive: false });

    communityDropdownBtn.addEventListener("touchstart", handleNearbyDropdownOpen, { passive: false });

    communityDropdownBtn.addEventListener("click", handleNearbyDropdownOpen);
  }

  if (communitySuggestionPanel) {
    communitySuggestionPanel.addEventListener("pointerdown", function (event) {
      event.stopPropagation();
      clearCommunitySuggestionCloseTimer();
    });
    communitySuggestionPanel.addEventListener("touchstart", function (event) {
      event.stopPropagation();
      clearCommunitySuggestionCloseTimer();
    }, { passive: true });
  }

  communitySelect.addEventListener("input", updateCommunityOptionsForInput);

  communitySelect.addEventListener("change", commitCommunityInput);

  communitySelect.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitCommunityInput();
      this.blur();
    }
    if (event.key === "Escape") hideCommunitySuggestionPanel();
  });

  window.addEventListener("resize", function () {
    if (isCommunitySuggestionPanelOpen()) positionCommunitySuggestionPanel();
  });
  window.addEventListener("orientationchange", function () {
    setTimeout(() => {
      if (isCommunitySuggestionPanelOpen()) positionCommunitySuggestionPanel();
    }, 180);
  });
}

if (addCommunityBtn) addCommunityBtn.addEventListener("click", addCommunityFromUser);
if (renameCommunityBtn) renameCommunityBtn.addEventListener("click", renameActiveCommunity);

document.getElementById("importInput").addEventListener("change", function (event) {
  const file = event.target.files[0];
  if (!file) return;
  importMarkers(file);
  event.target.value = "";
});

document.getElementById("fontSize").addEventListener("input", function () {
  fontSize = clampFontSizeValue(this.value, fontSize);
  this.value = fontSize;
  document.getElementById("fontSizeValue").innerText = String(fontSize);
});

document.getElementById("markerSize").addEventListener("input", function () {
  markerSize = clampMarkerSizeValue(this.value, markerSize);
  this.value = markerSize;
  document.getElementById("markerSizeValue").innerText = String(markerSize);
});

document.getElementById("markerColor").addEventListener("input", function () {
  markerColor = this.value;
});

document.getElementById("markerShape").addEventListener("change", function () {
  markerShape = this.value;
});

map.on("dblclick", function (event) {
  if (isMobileKeypadOnlyMode() && !mobileEditMode) return;
  openAddFlow(event.latlng);
});

let pressTimer = null;
const mapContainer = map.getContainer();

mapContainer.addEventListener(
  "touchstart",
  function (event) {
    if (event.target.closest("button")) return;
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    pressTimer = setTimeout(function () {
      if (isMobileKeypadOnlyMode() && !mobileEditMode) return;
      const rect = mapContainer.getBoundingClientRect();
      const point = L.point(touch.clientX - rect.left, touch.clientY - rect.top);
      openAddFlow(map.containerPointToLatLng(point));
    }, 700);
  },
  { passive: true }
);

mapContainer.addEventListener("touchend", () => clearTimeout(pressTimer), { passive: true });
mapContainer.addEventListener("touchmove", () => clearTimeout(pressTimer), { passive: true });

const zoomDisplay = document.createElement("div");
zoomDisplay.className = "zoom-display";
document.body.appendChild(zoomDisplay);

function updateZoomDisplay() {
  zoomDisplay.innerText = `Zoom: ${map.getZoom().toFixed(1)}`;
}

map.on("zoom", updateZoomDisplay);
map.on("rotate", function () {
  rotation = getMapBearing();
  navButton.style.setProperty("--bearing", `${normalizeHeading(42 - rotation)}deg`);
  updateMyLocationMarkerHeading();
});

loadData();
applyMobileReadableMarkerDefaults();
initialDataLoadDone = true;
initCloudSyncUi();
renderCommunitySelector();
startMyLocation();
renderMap();
updateUndoButton();
syncControlValues();
updateHeadingText();
updateZoomDisplay();
setMapBearing(0);
applyMobileModeUi();
