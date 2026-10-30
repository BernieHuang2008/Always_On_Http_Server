const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const ALL_FOLDER_ID = "folder-all";

let state = { folders: [], logic: [], routes: [], summary: {}, logs: [] };
let selectedFolderId = localStorage.getItem("selectedFolderId") || ALL_FOLDER_ID;
let linkDrag = null;
let sortDrag = null;
let suppressNextCardClick = false;
let folderDragId = null;
let expandedLogIds = new Set();

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function folders() {
  return state.folders || [];
}

function selectedFolder() {
  return folders().find((folder) => folder.id === selectedFolderId) || folders()[0] || {
    id: ALL_FOLDER_ID,
    name: "All Endpoints",
    icon: "🌐",
    path_prefix: "",
    theme_color: "#ffffff",
  };
}

function folderById(id) {
  return folders().find((folder) => folder.id === (id || ALL_FOLDER_ID)) || selectedFolder();
}

function folderTheme(folderId) {
  return folderById(folderId).theme_color || "#ffffff";
}

function routesForSelectedFolder() {
  if (selectedFolderId === ALL_FOLDER_ID) return state.routes || [];
  return (state.routes || []).filter((route) => (route.folder_id || ALL_FOLDER_ID) === selectedFolderId);
}

function logicForSelectedFolder() {
  if (selectedFolderId === ALL_FOLDER_ID) return state.logic || [];
  const logicIds = new Set(routesForSelectedFolder().map((route) => route.logic_id));
  return (state.logic || []).filter((logic) => logicIds.has(logic.id));
}

function logicLabel(logicId) {
  const logic = (state.logic || []).find((item) => item.id === logicId);
  return logic ? logic.name : "未连接";
}

function logicTypeLabel(type) {
  return {
    static_page: "静态内容",
    static_file: "静态文件",
    python_script: "Python 脚本",
  }[type] || type;
}

function scopeLabel(scope) {
  return scope === "temporary" ? "临时" : "长期";
}

function folderIcon(folder) {
  return folder.icon || (folder.id === ALL_FOLDER_ID ? "🌐" : "▣");
}

function selectedMethods() {
  return [...document.querySelectorAll("#methodGrid input:checked")].map((box) => box.value);
}

function setSelectedMethods(values) {
  document.querySelectorAll("#methodGrid input").forEach((box) => {
    box.checked = values.includes(box.value);
  });
}

function showEditor(kind, mode) {
  $("editorCover").hidden = false;
  $("folderForm").hidden = kind !== "folder";
  $("routeForm").hidden = kind !== "route";
  $("logicForm").hidden = kind !== "logic";
  const label = kind === "route" ? "API" : kind === "logic" ? "Logic" : "Folder";
  $("editorTitle").textContent = `${mode === "edit" ? "编辑" : "新建"} ${label}`;
  $("editorSubtitle").textContent = kind === "folder"
    ? "文件夹可以设置 path 前缀；All Endpoints 永远固定在第一位。"
    : kind === "route"
      ? "API 会创建在当前选中的文件夹内，并自动应用该文件夹前缀。"
      : "配置静态内容、静态文件，或一段自定义 Python 处理脚本。";
}

function closeEditor() {
  $("editorCover").hidden = true;
}

function renderMethodGrid() {
  $("methodGrid").innerHTML = methods.map((method) => `
    <label>
      <input type="checkbox" value="${method}" ${method === "GET" ? "checked" : ""}>
      ${method}
    </label>
  `).join("");
}

function renderLogicFields(config = {}) {
  const type = $("logicType").value;
  if (type === "static_file") {
    $("logicFields").innerHTML = `
      <label>
        文件路径
        <input id="logicFilePath" autocomplete="off" placeholder="hello.txt" value="${escapeHtml(config.file_path || "")}">
      </label>
      <div class="file-import-row">
        <button type="button" class="ghost small-button" id="importStaticFile">选择并导入文件</button>
        <input id="staticFilePicker" type="file" hidden>
        <span id="staticFileStatus" class="muted"></span>
      </div>
    `;
    return;
  }

  if (type === "python_script") {
    $("logicFields").innerHTML = `
      <label>
        Python 代码
        <textarea id="logicCode" spellcheck="false">${escapeHtml(config.code || "def handle(context):\n    return {'json': {'ok': True, 'path': context['path']}, 'status': 200}\n")}</textarea>
      </label>
    `;
    return;
  }

  $("logicFields").innerHTML = `
    <label>
      HTTP 状态码
      <input id="logicStatus" type="number" min="100" max="599" value="${escapeHtml(config.status || 200)}">
    </label>
    <label>
      Content-Type
      <input id="logicContentType" autocomplete="off" value="${escapeHtml(config.content_type || "text/html; charset=utf-8")}">
    </label>
    <label>
      内容
      <textarea id="logicBody" spellcheck="false">${escapeHtml(config.body || "")}</textarea>
    </label>
  `;
}

function renderFolderSelects() {
  $("routeFolder").innerHTML = folders().map((folder) => `
    <option value="${escapeHtml(folder.id)}">${escapeHtml(folder.name)}${folder.path_prefix ? ` · ${escapeHtml(folder.path_prefix)}` : ""}</option>
  `).join("");
}

function renderLogicSelect() {
  $("routeLogic").innerHTML = (state.logic || []).map((logic) => `
    <option value="${escapeHtml(logic.id)}">${escapeHtml(logic.name)} · ${escapeHtml(scopeLabel(logic.scope))}</option>
  `).join("");
}

function renderSummary() {
  const s = state.summary || {};
  const visibleRoutes = routesForSelectedFolder();
  const visibleLogic = logicForSelectedFolder();
  $("summary").textContent = `文件夹 ${folders().length || 1} · 当前 API ${visibleRoutes.length} · 当前 Logic ${visibleLogic.length} · 长期接口 ${s.persistent_routes || 0} · 临时接口 ${s.temporary_routes || 0}`;
  $("routeCount").textContent = visibleRoutes.length;
  $("logicCount").textContent = visibleLogic.length;
}

function renderFolders() {
  document.documentElement.style.setProperty("--folder-theme", selectedFolder().theme_color || "#ffffff");
  $("folderList").innerHTML = folders().map((folder) => {
    const active = folder.id === selectedFolderId ? "active" : "";
    const locked = folder.id === ALL_FOLDER_ID ? "locked" : "";
    const draggable = folder.id === ALL_FOLDER_ID ? "false" : "true";
    return `
      <button class="folder-chip ${active} ${locked}" data-folder-id="${escapeHtml(folder.id)}" draggable="${draggable}" style="--chip-theme: ${escapeHtml(folder.theme_color || "#ffffff")}" type="button">
        <span class="folder-icon">${folderIcon(folder)}</span>
        <span class="folder-name">${escapeHtml(folder.name)}</span>
        ${folder.path_prefix ? `<span class="folder-prefix">${escapeHtml(folder.path_prefix)}</span>` : ""}
        ${folder.id === ALL_FOLDER_ID ? "" : `<span class="folder-edit" data-edit-folder="${escapeHtml(folder.id)}">✎</span>`}
      </button>
    `;
  }).join("");
}

function formatLogTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusClass(status) {
  return Number(status) >= 400 ? "status-error" : "";
}

function routeRegex(pathTemplate) {
  const escaped = String(pathTemplate || "")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\{[a-zA-Z_][a-zA-Z0-9_]*\\\}/g, "[^/]+");
  return new RegExp(`^${escaped}$`);
}

function matchedRouteForLog(entry) {
  return (state.routes || []).find((route) => (
    (route.methods || []).includes(entry.method) &&
    routeRegex(route.effective_path || route.path).test(entry.path)
  ));
}

function renderLogs() {
  const logs = state.logs || [];
  $("logList").innerHTML = logs.length ? logs.slice(0, 120).map((entry) => {
    const query = entry.query ? `?${entry.query}` : "";
    const route = matchedRouteForLog(entry);
    const logic = route ? (state.logic || []).find((item) => item.id === route.logic_id) : null;
    const expanded = expandedLogIds.has(String(entry.id));
    const match = route ? `
      <div class="log-match">
        <button type="button" class="log-chip" data-log-route="${escapeHtml(route.id)}">API · ${escapeHtml(route.name)}</button>
        ${logic ? `<button type="button" class="log-chip" data-log-logic="${escapeHtml(logic.id)}">Logic · ${escapeHtml(logic.name)}</button>` : ""}
      </div>
    ` : "";
    const details = expanded ? `
      <div class="log-details">
        <div><strong>Remote</strong> ${escapeHtml(entry.remote_addr || "")}</div>
        <div><strong>Request</strong> ${escapeHtml(entry.content_type || "")}</div>
        ${entry.body ? `<pre class="log-body">${escapeHtml(entry.body)}</pre>` : ""}
        <div><strong>Response</strong> ${escapeHtml(entry.response_content_type || "")}</div>
        ${entry.response_body ? `<pre class="log-body">${escapeHtml(entry.response_body)}</pre>` : ""}
      </div>
    ` : "";
    return `
      <article class="log-entry ${statusClass(entry.status)} ${expanded ? "expanded" : ""}" data-log-id="${escapeHtml(entry.id)}">
        <span class="log-time">${escapeHtml(formatLogTime(entry.time))}</span>
        <span class="log-method">${escapeHtml(entry.method)}</span>
        <span class="log-path">${escapeHtml(entry.path)}${escapeHtml(query)}</span>
        <span class="log-status">${escapeHtml(entry.status)}</span>
        <span class="log-duration">${escapeHtml(entry.duration_ms ?? "")} ms</span>
        ${match}
        ${details}
      </article>
    `;
  }).join("") : `<p class="log-empty">还没有请求记录。</p>`;
}

function addLogEntry(entry) {
  state.logs = [entry, ...(state.logs || [])].slice(0, 160);
  renderLogs();
}

function setLiveStatus(online) {
  $("liveStatus").textContent = online ? "Live connected" : "Live reconnecting";
  $("liveStatus").classList.toggle("offline", !online);
}

function renderCards() {
  const visibleRoutes = routesForSelectedFolder();
  const visibleLogic = logicForSelectedFolder();
  $("routeList").innerHTML = visibleRoutes.map((route) => `
    <article class="card route-card" data-kind="routes" data-id="${escapeHtml(route.id)}" data-logic="${escapeHtml(route.logic_id)}" data-enabled="${route.enabled ? "true" : "false"}" style="--card-theme: ${escapeHtml(folderTheme(route.folder_id))}" tabindex="0">
      <div class="card-head">
        <div class="card-title">
          <span class="drag-grip" title="拖动排序">⋮⋮</span>
          <h3>${escapeHtml(route.name)}</h3>
        </div>
        <span class="badge ${escapeHtml(route.scope)}">${escapeHtml(scopeLabel(route.scope))}</span>
      </div>
      <p>${escapeHtml(route.effective_path || route.path)} → ${escapeHtml(logicLabel(route.logic_id))}</p>
      <div class="method-row">
        ${(route.methods || []).map((method) => `<span class="method">${escapeHtml(method)}</span>`).join("")}
        ${route.enabled ? "" : `<span class="method muted">DISABLED</span>`}
      </div>
      <div class="card-actions">
        <button type="button" class="danger" data-delete-route="${escapeHtml(route.id)}">删除</button>
      </div>
    </article>
  `).join("") || `<p class="muted">暂无接口</p>`;

  $("logicList").innerHTML = visibleLogic.map((logic) => `
    <article class="card logic-card" data-kind="logic" data-id="${escapeHtml(logic.id)}" style="--card-theme: ${escapeHtml(selectedFolder().theme_color || "#ffffff")}" tabindex="0">
      <div class="card-head">
        <div class="card-title">
          <span class="drag-grip" title="拖动排序">⋮⋮</span>
          <h3>${escapeHtml(logic.name)}</h3>
        </div>
        <span class="badge ${escapeHtml(logic.scope)}">${escapeHtml(scopeLabel(logic.scope))}</span>
      </div>
      <p>${escapeHtml(logicTypeLabel(logic.type))}</p>
      <div class="card-actions">
        <button type="button" class="danger" data-delete-logic="${escapeHtml(logic.id)}">删除</button>
      </div>
    </article>
  `).join("") || `<p class="muted">暂无关联逻辑</p>`;
}

function routeAnchor(routeCard) {
  const boardRect = $("board").getBoundingClientRect();
  const rect = routeCard.getBoundingClientRect();
  return { x: rect.right - boardRect.left, y: rect.top + rect.height / 2 - boardRect.top };
}

function logicAnchor(logicCard) {
  const boardRect = $("board").getBoundingClientRect();
  const rect = logicCard.getBoundingClientRect();
  return { x: rect.left - boardRect.left, y: rect.top + rect.height / 2 - boardRect.top };
}

function linkPath(x1, y1, x2, y2) {
  const mid = Math.max(42, (x2 - x1) * 0.42);
  return `M ${x1} ${y1} C ${x1 + mid} ${y1}, ${x2 - mid} ${y2}, ${x2} ${y2}`;
}

function svgEl(name, attrs) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

function drawLinks() {
  const board = $("board");
  const svg = $("links");
  const rect = board.getBoundingClientRect();
  svg.innerHTML = "";
  svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);

  document.querySelectorAll(".route-card:not(.sorting-source)").forEach((routeCard) => {
    const logicCard = document.querySelector(`.logic-card[data-id="${CSS.escape(routeCard.dataset.logic)}"]:not(.sorting-source)`);
    if (!logicCard) return;
    const a = routeAnchor(routeCard);
    const b = logicAnchor(logicCard);
    const color = routeCard.dataset.enabled === "false"
      ? "hsl(210 12% 78%)"
      : "hsl(154 48% 28%)";
    svg.appendChild(svgEl("path", {
      d: linkPath(a.x, a.y, b.x, b.y),
      fill: "none",
      stroke: color,
      "stroke-width": "2.5",
      "stroke-linecap": "round",
      class: "link-path",
      "data-route": routeCard.dataset.id,
    }));
    svg.appendChild(svgEl("circle", {
      cx: a.x,
      cy: a.y,
      r: 6,
      fill: "hsl(43 42% 97%)",
      stroke: color,
      "stroke-width": "2.5",
      class: "link-endpoint",
      "data-route": routeCard.dataset.id,
    }));
    svg.appendChild(svgEl("circle", {
      cx: b.x,
      cy: b.y,
      r: 8,
      fill: "hsl(43 42% 97%)",
      stroke: color,
      "stroke-width": "2.8",
      class: "link-endpoint link-endpoint-target",
      "data-route": routeCard.dataset.id,
    }));
  });
}

function render() {
  renderFolders();
  renderSummary();
  renderFolderSelects();
  renderLogicSelect();
  renderCards();
  renderLogs();
  requestAnimationFrame(drawLinks);
}

async function loadConfig() {
  const logs = state.logs || [];
  const res = await fetch("/__admin__/config");
  state = await res.json();
  state.logs = logs;
  if (!folders().some((folder) => folder.id === selectedFolderId)) {
    selectedFolderId = ALL_FOLDER_ID;
    localStorage.setItem("selectedFolderId", selectedFolderId);
  }
  render();
}

async function loadLogs() {
  const res = await fetch("/__admin__/logs");
  const body = await res.json();
  state.logs = body.logs || [];
  renderLogs();
}

function connectEvents() {
  if (!window.EventSource) {
    setLiveStatus(false);
    return;
  }
  const source = new EventSource("/__admin__/events");
  source.addEventListener("open", () => setLiveStatus(true));
  source.addEventListener("ready", () => setLiveStatus(true));
  source.addEventListener("request", (event) => addLogEntry(JSON.parse(event.data)));
  source.addEventListener("config", () => loadConfig().catch(() => setLiveStatus(false)));
  source.addEventListener("error", () => setLiveStatus(false));
}

function routePayloadFrom(route, overrides = {}) {
  return {
    name: route.name,
    path: route.path,
    methods: route.methods || ["GET"],
    logic_id: route.logic_id,
    folder_id: route.folder_id || ALL_FOLDER_ID,
    enabled: route.enabled,
    scope: route.scope,
    order: route.order,
    ...overrides,
  };
}

function routePayload() {
  return {
    name: $("routeName").value,
    path: $("routePath").value,
    methods: selectedMethods(),
    logic_id: $("routeLogic").value,
    folder_id: $("routeFolder").value || selectedFolderId,
    enabled: $("routeEnabled").checked,
    scope: $("routeTemporary").checked ? "temporary" : "persistent",
    order: (state.routes || []).find((item) => item.id === $("routeId").value)?.order,
  };
}

function logicConfigPayload() {
  const type = $("logicType").value;
  if (type === "static_file") return { file_path: $("logicFilePath").value };
  if (type === "python_script") return { code: $("logicCode").value };
  return {
    status: Number($("logicStatus").value || 200),
    content_type: $("logicContentType").value,
    body: $("logicBody").value,
  };
}

function logicPayload() {
  return {
    name: $("logicName").value,
    type: $("logicType").value,
    scope: $("logicTemporary").checked ? "temporary" : "persistent",
    config: logicConfigPayload(),
    order: (state.logic || []).find((item) => item.id === $("logicId").value)?.order,
  };
}

function folderPayload() {
  return {
    name: $("folderName").value,
    icon: $("folderIcon").value,
    path_prefix: $("folderPrefix").value,
    theme_color: $("folderTheme").value || "#ffffff",
    order: folders().find((item) => item.id === $("folderId").value)?.order,
  };
}

async function submitJson(url, method, payload) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "保存失败");
  return body;
}

async function uploadStaticFile(file) {
  const data = new FormData();
  data.append("file", file);
  const res = await fetch("/__admin__/upload-static-file", {
    method: "POST",
    body: data,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "导入失败");
  return body;
}

async function updateRouteLogic(routeId, logicId) {
  const route = (state.routes || []).find((item) => item.id === routeId);
  if (!route || route.logic_id === logicId) return;
  await submitJson(`/__admin__/routes/${encodeURIComponent(routeId)}`, "PUT", routePayloadFrom(route, { logic_id: logicId }));
  await loadConfig();
}

async function persistOrder(kind, ids) {
  await submitJson("/__admin__/order", "PUT", { kind, ids });
  await loadConfig();
}

function resetRouteForm() {
  $("routeForm").reset();
  $("routeId").value = "";
  $("routeFolder").value = selectedFolderId;
  $("routeEnabled").checked = true;
  $("routeTemporary").checked = false;
  setSelectedMethods(["GET"]);
}

function resetLogicForm() {
  $("logicForm").reset();
  $("logicId").value = "";
  $("logicTemporary").checked = false;
  renderLogicFields();
}

function resetFolderForm() {
  $("folderForm").reset();
  $("folderId").value = "";
  $("folderIcon").value = "▣";
  $("folderTheme").value = "#ffffff";
  $("deleteFolder").hidden = true;
}

function newRoute() {
  resetRouteForm();
  showEditor("route", "new");
}

function newLogic() {
  resetLogicForm();
  showEditor("logic", "new");
}

function newFolder() {
  resetFolderForm();
  showEditor("folder", "new");
}

function editRoute(id) {
  const route = (state.routes || []).find((item) => item.id === id);
  if (!route) return;
  $("routeId").value = route.id;
  $("routeFolder").value = route.folder_id || ALL_FOLDER_ID;
  $("routeName").value = route.name;
  $("routePath").value = route.path;
  $("routeLogic").value = route.logic_id;
  $("routeTemporary").checked = route.scope === "temporary";
  $("routeEnabled").checked = route.enabled;
  setSelectedMethods(route.methods || []);
  showEditor("route", "edit");
}

function editLogic(id) {
  const logic = (state.logic || []).find((item) => item.id === id);
  if (!logic) return;
  $("logicId").value = logic.id;
  $("logicName").value = logic.name;
  $("logicType").value = logic.type;
  $("logicTemporary").checked = logic.scope === "temporary";
  renderLogicFields(logic.config || {});
  showEditor("logic", "edit");
}

function editFolder(id) {
  const folder = folders().find((item) => item.id === id);
  if (!folder || folder.id === ALL_FOLDER_ID) return;
  $("folderId").value = folder.id;
  $("folderName").value = folder.name;
  $("folderIcon").value = folder.icon || "▣";
  $("folderPrefix").value = folder.path_prefix || "";
  $("folderTheme").value = folder.theme_color || "#ffffff";
  $("deleteFolder").hidden = false;
  showEditor("folder", "edit");
}

async function deleteItem(kind, id) {
  await fetch(`/__admin__/${kind}/${encodeURIComponent(id)}`, { method: "DELETE" });
  await loadConfig();
}

function clearLogicDropTargets() {
  document.querySelectorAll(".logic-card.drop-target").forEach((card) => card.classList.remove("drop-target"));
}

function logicCardAtPoint(x, y) {
  return document.elementsFromPoint(x, y).find((element) => element.classList?.contains("logic-card"));
}

function beginLinkDrag(event) {
  const routeId = event.target.dataset.route;
  const routeCard = document.querySelector(`.route-card[data-id="${CSS.escape(routeId)}"]`);
  if (!routeCard) return;
  linkDrag = { routeId, start: routeAnchor(routeCard) };
  suppressNextCardClick = true;
  document.body.classList.add("is-link-dragging");
  event.preventDefault();
  event.stopPropagation();
}

function updateLinkDrag(event) {
  if (!linkDrag) return;
  const boardRect = $("board").getBoundingClientRect();
  const x = event.clientX - boardRect.left;
  const y = event.clientY - boardRect.top;
  const svg = $("links");
  let preview = document.getElementById("linkPreview");
  if (!preview) {
    preview = svgEl("path", {
      id: "linkPreview",
      fill: "none",
      stroke: "hsl(228 40% 66%)",
      "stroke-width": "3",
      "stroke-linecap": "round",
      "stroke-dasharray": "8 7",
      class: "link-preview",
    });
    svg.appendChild(preview);
  }
  preview.setAttribute("d", linkPath(linkDrag.start.x, linkDrag.start.y, x, y));
  clearLogicDropTargets();
  const logicCard = logicCardAtPoint(event.clientX, event.clientY);
  if (logicCard) logicCard.classList.add("drop-target");
}

async function finishLinkDrag(event) {
  if (!linkDrag) return;
  const routeId = linkDrag.routeId;
  const logicCard = logicCardAtPoint(event.clientX, event.clientY);
  linkDrag = null;
  document.body.classList.remove("is-link-dragging");
  document.getElementById("linkPreview")?.remove();
  clearLogicDropTargets();
  if (logicCard) await updateRouteLogic(routeId, logicCard.dataset.id);
  else drawLinks();
}

function beginSortPointer(event) {
  if (event.button !== 0 || linkDrag) return;
  const card = event.target.closest(".card");
  if (!card || event.target.closest("button, input, select, textarea, label")) return;
  sortDrag = {
    active: false,
    id: card.dataset.id,
    kind: card.dataset.kind,
    source: card,
    container: card.parentElement,
    startX: event.clientX,
    startY: event.clientY,
    placeholder: null,
  };
}

function startSortDrag() {
  if (!sortDrag || sortDrag.active) return;
  const placeholder = sortDrag.source.cloneNode(true);
  placeholder.classList.add("card-placeholder");
  placeholder.removeAttribute("tabindex");
  placeholder.setAttribute("aria-hidden", "true");
  placeholder.querySelectorAll("button").forEach((button) => {
    button.disabled = true;
  });
  sortDrag.placeholder = placeholder;
  sortDrag.active = true;
  sortDrag.source.insertAdjacentElement("afterend", placeholder);
  sortDrag.source.classList.add("sorting-source");
  sortDrag.container.classList.add("sorting-container");
  document.body.classList.add("is-card-sorting");
  suppressNextCardClick = true;
}

function cardAtPoint(kind, x, y) {
  return document.elementsFromPoint(x, y).find((element) => (
    element.classList?.contains("card") &&
    element.dataset.kind === kind &&
    !element.classList.contains("sorting-source") &&
    !element.classList.contains("card-placeholder")
  ));
}

function sortableChildren(container) {
  return [...container.querySelectorAll(".card:not(.sorting-source)")];
}

function sortKey(element) {
  return `${element.dataset.kind}:${element.dataset.id}`;
}

function snapshotPositions(container) {
  const positions = new Map();
  sortableChildren(container).forEach((element) => positions.set(sortKey(element), element.getBoundingClientRect()));
  return positions;
}

function animateRearrange(container, mutate) {
  const before = snapshotPositions(container);
  mutate();
  const animated = [];
  sortableChildren(container).forEach((element) => {
    const previous = before.get(sortKey(element));
    if (!previous) return;
    const current = element.getBoundingClientRect();
    const dx = previous.left - current.left;
    const dy = previous.top - current.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    element.style.transition = "none";
    element.style.transform = `translate(${dx}px, ${dy}px)`;
    animated.push(element);
  });
  requestAnimationFrame(() => {
    animated.forEach((element) => {
      element.style.transition = "transform 190ms ease, border-color 160ms ease, box-shadow 160ms ease, opacity 160ms ease";
      element.style.transform = "";
    });
  });
}

function placePlaceholder(container, placeholder, beforeNode) {
  if (placeholder.nextSibling === beforeNode && placeholder.parentElement === container) return;
  animateRearrange(container, () => container.insertBefore(placeholder, beforeNode));
}

function updateSortDrag(event) {
  if (!sortDrag) return;
  const distance = Math.hypot(event.clientX - sortDrag.startX, event.clientY - sortDrag.startY);
  if (!sortDrag.active && distance < 7) return;
  startSortDrag();
  event.preventDefault();
  const { container, placeholder, source, kind } = sortDrag;
  const target = cardAtPoint(kind, event.clientX, event.clientY);
  if (target && target !== source) {
    const rect = target.getBoundingClientRect();
    const placeAfter = event.clientY > rect.top + rect.height / 2;
    placePlaceholder(container, placeholder, placeAfter ? target.nextSibling : target);
  } else if (!placeholder.isConnected) {
    placePlaceholder(container, placeholder, null);
  }
  drawLinks();
}

function orderedIdsFromContainer(container, draggedId) {
  const ids = [];
  [...container.children].forEach((child) => {
    if (child.classList.contains("card-placeholder")) ids.push(draggedId);
    else if (child.classList.contains("card") && child.dataset.id !== draggedId) ids.push(child.dataset.id);
  });
  return ids;
}

function cleanupSortDrag() {
  if (!sortDrag) return;
  sortDrag.placeholder?.remove();
  sortDrag.source.classList.remove("sorting-source");
  sortDrag.container.classList.remove("sorting-container");
  document.body.classList.remove("is-card-sorting");
  sortDrag = null;
}

function commitSortDrag() {
  if (!sortDrag) return;
  const { container, placeholder, source } = sortDrag;
  animateRearrange(container, () => {
    container.insertBefore(source, placeholder);
    source.classList.remove("sorting-source");
    placeholder.remove();
  });
  container.classList.remove("sorting-container");
  document.body.classList.remove("is-card-sorting");
  sortDrag = null;
}

async function finishSortDrag(event) {
  if (!sortDrag) return;
  if (!sortDrag.active) {
    sortDrag = null;
    return;
  }
  event.preventDefault();
  const { container, id, kind, placeholder } = sortDrag;
  if (!placeholder?.isConnected) {
    cleanupSortDrag();
    drawLinks();
    return;
  }
  const ids = orderedIdsFromContainer(container, id);
  commitSortDrag();
  await persistOrder(kind, ids);
}

function selectFolder(id) {
  selectedFolderId = id || ALL_FOLDER_ID;
  localStorage.setItem("selectedFolderId", selectedFolderId);
  render();
}

function beginFolderDrag(event) {
  const chip = event.target.closest(".folder-chip");
  if (!chip || chip.dataset.folderId === ALL_FOLDER_ID || event.target.closest(".folder-edit")) return;
  folderDragId = chip.dataset.folderId;
  chip.classList.add("dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", folderDragId);
}

function updateFolderDrag(event) {
  if (!folderDragId) return;
  const target = event.target.closest(".folder-chip");
  if (!target || target.dataset.folderId === ALL_FOLDER_ID || target.dataset.folderId === folderDragId) return;
  event.preventDefault();
  document.querySelectorAll(".folder-chip.folder-drop").forEach((chip) => chip.classList.remove("folder-drop"));
  target.classList.add("folder-drop");
}

async function finishFolderDrop(event) {
  if (!folderDragId) return;
  const target = event.target.closest(".folder-chip");
  event.preventDefault();
  const draggedId = folderDragId;
  folderDragId = null;
  document.querySelectorAll(".folder-chip.dragging, .folder-chip.folder-drop").forEach((chip) => chip.classList.remove("dragging", "folder-drop"));
  if (!target || target.dataset.folderId === ALL_FOLDER_ID || target.dataset.folderId === draggedId) return;
  const ids = folders().map((folder) => folder.id).filter((id) => id !== draggedId && id !== ALL_FOLDER_ID);
  const targetIndex = ids.indexOf(target.dataset.folderId);
  ids.splice(targetIndex + 1, 0, draggedId);
  await persistOrder("folders", [ALL_FOLDER_ID, ...ids]);
}

function bindEvents() {
  $("reloadButton").addEventListener("click", loadConfig);
  $("addFolder").addEventListener("click", newFolder);
  $("addRoute").addEventListener("click", newRoute);
  $("addLogic").addEventListener("click", newLogic);
  $("closeEditor").addEventListener("click", closeEditor);
  $("coverBackdrop").addEventListener("click", closeEditor);
  $("clearLogView").addEventListener("click", () => {
    state.logs = [];
    renderLogs();
  });
  $("resetRoute").addEventListener("click", resetRouteForm);
  $("resetLogic").addEventListener("click", resetLogicForm);
  $("deleteFolder").addEventListener("click", async () => {
    const id = $("folderId").value;
    if (id && confirm("删除这个文件夹？文件夹内的 API 会移回 All Endpoints。")) {
      await deleteItem("folders", id);
      if (selectedFolderId === id) selectedFolderId = ALL_FOLDER_ID;
      closeEditor();
    }
  });
  $("logicType").addEventListener("change", () => renderLogicFields());
  window.addEventListener("resize", drawLinks);
  window.addEventListener("pointermove", updateLinkDrag);
  window.addEventListener("pointermove", updateSortDrag);
  window.addEventListener("pointerup", finishLinkDrag);
  window.addEventListener("pointerup", finishSortDrag);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeEditor();
  });

  $("links").addEventListener("pointerdown", (event) => {
    if (event.target.classList.contains("link-endpoint")) beginLinkDrag(event);
  });

  document.body.addEventListener("click", async (event) => {
    if (event.target.id === "importStaticFile") {
      $("staticFilePicker")?.click();
      return;
    }

    if (suppressNextCardClick) {
      suppressNextCardClick = false;
      return;
    }
    const logRoute = event.target.dataset.logRoute;
    const logLogic = event.target.dataset.logLogic;
    if (logRoute) {
      const route = (state.routes || []).find((item) => item.id === logRoute);
      if (route) selectFolder(route.folder_id || ALL_FOLDER_ID);
      editRoute(logRoute);
      return;
    }
    if (logLogic) {
      editLogic(logLogic);
      return;
    }
    const logEntry = event.target.closest(".log-entry");
    if (logEntry && !event.target.closest("button")) {
      const id = String(logEntry.dataset.logId);
      if (expandedLogIds.has(id)) expandedLogIds.delete(id);
      else expandedLogIds.add(id);
      renderLogs();
      return;
    }

    const editId = event.target.dataset.editFolder;
    if (editId) {
      event.stopPropagation();
      editFolder(editId);
      return;
    }

    const routeDelete = event.target.dataset.deleteRoute;
    const logicDelete = event.target.dataset.deleteLogic;
    const routeCard = event.target.closest(".route-card");
    const logicCard = event.target.closest(".logic-card");
    const folderChip = event.target.closest(".folder-chip");

    if (routeDelete) {
      event.stopPropagation();
      if (confirm("删除这个接口？")) await deleteItem("routes", routeDelete);
      return;
    }
    if (logicDelete) {
      event.stopPropagation();
      if (confirm("删除这个逻辑？")) await deleteItem("logic", logicDelete);
      return;
    }
    if (folderChip) {
      selectFolder(folderChip.dataset.folderId);
      return;
    }
    if (routeCard) editRoute(routeCard.dataset.id);
    if (logicCard) editLogic(logicCard.dataset.id);
  });

  document.body.addEventListener("change", async (event) => {
    if (event.target.id !== "staticFilePicker") return;
    const file = event.target.files?.[0];
    if (!file) return;
    $("staticFileStatus").textContent = "导入中...";
    try {
      const result = await uploadStaticFile(file);
      $("logicFilePath").value = result.file_path;
      $("staticFileStatus").textContent = `已导入：${result.file_path}`;
    } catch (error) {
      $("staticFileStatus").textContent = error.message;
    } finally {
      event.target.value = "";
    }
  });

  $("folderList").addEventListener("dragstart", beginFolderDrag);
  $("folderList").addEventListener("dragover", updateFolderDrag);
  $("folderList").addEventListener("drop", finishFolderDrop);
  $("folderList").addEventListener("dragend", () => {
    folderDragId = null;
    document.querySelectorAll(".folder-chip.dragging, .folder-chip.folder-drop").forEach((chip) => chip.classList.remove("dragging", "folder-drop"));
  });

  $("folderForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = $("folderId").value;
    const url = id ? `/__admin__/folders/${encodeURIComponent(id)}` : "/__admin__/folders";
    const saved = await submitJson(url, id ? "PUT" : "POST", folderPayload());
    selectedFolderId = saved.id || selectedFolderId;
    localStorage.setItem("selectedFolderId", selectedFolderId);
    closeEditor();
    resetFolderForm();
    await loadConfig();
  });

  $("routeForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = $("routeId").value;
    const url = id ? `/__admin__/routes/${encodeURIComponent(id)}` : "/__admin__/routes";
    await submitJson(url, id ? "PUT" : "POST", routePayload());
    selectedFolderId = $("routeFolder").value || selectedFolderId;
    localStorage.setItem("selectedFolderId", selectedFolderId);
    closeEditor();
    resetRouteForm();
    await loadConfig();
  });

  $("logicForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const id = $("logicId").value;
    const url = id ? `/__admin__/logic/${encodeURIComponent(id)}` : "/__admin__/logic";
    await submitJson(url, id ? "PUT" : "POST", logicPayload());
    closeEditor();
    resetLogicForm();
    await loadConfig();
  });

  document.body.addEventListener("pointerdown", beginSortPointer);
  document.body.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const routeCard = event.target.closest(".route-card");
    const logicCard = event.target.closest(".logic-card");
    if (routeCard) editRoute(routeCard.dataset.id);
    if (logicCard) editLogic(logicCard.dataset.id);
  });
}

renderMethodGrid();
renderLogicFields();
bindEvents();
renderLogs();
loadConfig().catch((error) => {
  $("summary").textContent = error.message;
});
loadLogs().catch(() => {
  state.logs = [];
  renderLogs();
});
connectEvents();
