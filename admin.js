const $ = (id) => document.getElementById(id);

function formatInt(n) {
  const x = Number(n || 0);
  if (!Number.isFinite(x)) return "0";
  return Math.floor(x).toLocaleString("zh-CN");
}

async function getJson(url) {
  const resp = await fetch(url, { credentials: "include" });
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!resp.ok) throw new Error(data?.error || text || `HTTP ${resp.status}`);
  return data;
}

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    credentials: "include",
  });
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!resp.ok) throw new Error(data?.error || text || `HTTP ${resp.status}`);
  return data;
}

async function patchJson(url, body) {
  const resp = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    credentials: "include",
  });
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!resp.ok) throw new Error(data?.error || text || `HTTP ${resp.status}`);
  return data;
}

let state = {
  page: 1,
  pageSize: 20,
  q: "",
  total: 0,
  selectedId: null,
};

let payState = {
  page: 1,
  pageSize: 20,
  q: "",
  total: 0,
};

let payCache = [];

function showGate(msg, isError) {
  $("adminGate").textContent = msg;
  $("adminGate").classList.toggle("admin-gate--err", Boolean(isError));
  $("adminGate").classList.remove("hidden");
  $("adminMain").classList.add("hidden");
}

function showMain() {
  $("adminGate").classList.add("hidden");
  $("adminMain").classList.remove("hidden");
}

function renderRows(users) {
  const tbody = $("adminUserRows");
  tbody.innerHTML = "";
  if (!users.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="6" class="admin-empty">无数据</td>';
    tbody.appendChild(tr);
    return;
  }
  for (const u of users) {
    if (!u) continue;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(u.phone || "-")}</td>
      <td class="admin-mono">${escapeHtml(u.id || "-")}</td>
      <td>${formatInt(u.pointsBalance)}</td>
      <td>${formatInt(u.pointsSpent)}</td>
      <td>${u.accountDisabled ? '<span class="admin-badge admin-badge--off">已禁用</span>' : '<span class="admin-badge">正常</span>'}</td>
      <td><button type="button" class="ghost admin-row-btn" data-id="${escapeAttr(u.id || "")}">详情</button></td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll(".admin-row-btn").forEach((btn) => {
    btn.onclick = () => openDetail(btn.getAttribute("data-id"));
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

async function loadList() {
  const qs = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
  });
  if (state.q) qs.set("q", state.q);
  const data = await getJson(`/api/admin/users?${qs}`);
  state.total = data.total || 0;
  renderRows(data.users || []);
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  $("adminListMeta").textContent = `共 ${state.total} 人 · 第 ${state.page}/${pages} 页`;
  $("adminPageLabel").textContent = `${state.page} / ${pages}`;
  $("adminPrevPage").disabled = state.page <= 1;
  $("adminNextPage").disabled = state.page >= pages;
}

function renderPayRows(rows) {
  const tbody = $("adminPayRows");
  tbody.innerHTML = "";
  payCache = Array.isArray(rows) ? rows : [];
  $("adminPayDetail").textContent = "";
  if (!rows.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td colspan="10" class="admin-empty">无数据</td>';
    tbody.appendChild(tr);
    return;
  }
  for (const o of rows) {
    const tr = document.createElement("tr");
    const userText = o.userPhone ? `${o.userPhone}` : o.userId || "-";
    const credited = o.creditedAt ? "已入账" : o.creditError ? `失败(${o.creditError})` : "-";
    tr.innerHTML = `
      <td>${escapeHtml(o.createdAt || o.notifiedAt || "-")}</td>
      <td class="admin-mono">${escapeHtml(o.outTradeNo || "-")}</td>
      <td>${escapeHtml(o.channel || "-")}</td>
      <td>${escapeHtml(userText)}</td>
      <td>${escapeHtml(o.subject || "-")}</td>
      <td>${escapeHtml(String(o.totalAmount || "-"))}</td>
      <td>${formatInt(o.points || 0)}</td>
      <td>${escapeHtml(o.status || "-")}</td>
      <td>${escapeHtml(credited)}</td>
      <td><button type="button" class="ghost admin-pay-btn" data-out="${escapeAttr(o.outTradeNo || "")}">详情</button></td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll(".admin-pay-btn").forEach((btn) => {
    btn.onclick = () => {
      const out = btn.getAttribute("data-out");
      const row = (payCache || []).find((x) => String(x.outTradeNo) === String(out)) || null;
      $("adminPayDetail").textContent = row ? JSON.stringify(row, null, 2) : "未找到订单";
    };
  });
}

async function loadPayList() {
  const qs = new URLSearchParams({
    page: String(payState.page),
    pageSize: String(payState.pageSize),
  });
  if (payState.q) qs.set("q", payState.q);
  const from = String($("adminPayFrom")?.value || "").trim();
  const to = String($("adminPayTo")?.value || "").trim();
  const status = String($("adminPayStatus")?.value || "").trim();
  const credited = String($("adminPayCredited")?.value || "").trim();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (status) qs.set("status", status);
  if (credited) qs.set("credited", credited);
  const data = await getJson(`/api/admin/payments/alipay?${qs}`);
  payState.total = data.total || 0;
  renderPayRows(data.orders || []);
  const pages = Math.max(1, Math.ceil(payState.total / payState.pageSize));
  $("adminPayMeta").textContent = `共 ${payState.total} 单 · 第 ${payState.page}/${pages} 页`;

  const sumQs = new URLSearchParams(qs);
  sumQs.delete("page");
  sumQs.delete("pageSize");
  const summary = await getJson(`/api/admin/payments/alipay/summary?${sumQs}`).catch(() => null);
  if (summary?.ok) {
    $("adminPaySummary").textContent = `汇总：订单 ${summary.totalOrders} · PAID ${summary.paidCount} · 已入账 ${summary.creditedCount} · 金额合计 ¥${Number(summary.amountSum || 0).toFixed(
      2
    )} · 积分合计 ${formatInt(summary.pointsSum || 0)}`;
  } else {
    $("adminPaySummary").textContent = "";
  }
}

async function openDetail(userId) {
  state.selectedId = userId;
  $("adminDetailPlaceholder").classList.add("hidden");
  $("adminDetailBody").classList.remove("hidden");
  $("adminDelta").value = "";
  $("adminReason").value = "";
  const data = await getJson(`/api/admin/users/${encodeURIComponent(userId)}`);
  const u = data.user;
  $("adminDetailSummary").innerHTML = `
    <div><span class="admin-k">手机号</span>${escapeHtml(u.phone || "")}</div>
    <div><span class="admin-k">用户 ID</span><span class="admin-mono">${escapeHtml(u.id || "")}</span></div>
    <div><span class="admin-k">积分余额</span>${formatInt(u.pointsBalance)}</div>
    <div><span class="admin-k">累计消耗</span>${formatInt(u.pointsSpent)}</div>
    <div><span class="admin-k">注册时间</span>${escapeHtml(u.createdAt || "-")}</div>
    <div><span class="admin-k">最近计费更新</span>${escapeHtml(u.billingUpdatedAt || "-")}</div>
  `;
  $("adminDisabledToggle").checked = Boolean(u.accountDisabled);
  $("adminLogs").textContent = JSON.stringify(data.billingLogs || [], null, 2);
}

async function init() {
  try {
    const me = await getJson("/api/auth/me");
    $("adminSelfPhone").textContent = me.user?.phone ? `已登录：${me.user.phone}` : "";
    if (!me.user?.isAdmin) {
      showGate("当前账号不是管理员。请在服务端 .env 配置 ADMIN_PHONES（与登录手机号一致），并重启服务。", true);
      return;
    }
  } catch {
    window.location.href = "/login.html";
    return;
  }

  showMain();
  await loadList().catch((e) => {
    showGate(e.message || "加载用户列表失败", true);
  });
  await loadPayList().catch(() => {
    $("adminPayMeta").textContent = "支付订单加载失败";
  });
  await loadModelsList();
}

$("adminSearchBtn").onclick = () => {
  state.q = String($("adminSearch").value || "").trim();
  state.page = 1;
  loadList().catch((err) => alert(err.message));
};

$("adminSearch").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") $("adminSearchBtn").click();
});

$("adminPrevPage").onclick = () => {
  if (state.page > 1) {
    state.page -= 1;
    loadList().catch((err) => alert(err.message));
  }
};

$("adminNextPage").onclick = () => {
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  if (state.page < pages) {
    state.page += 1;
    loadList().catch((err) => alert(err.message));
  }
};

$("adminApplyPoints").onclick = async () => {
  if (!state.selectedId) return;
  const delta = Number($("adminDelta").value);
  const reason = String($("adminReason").value || "").trim();
  if (!Number.isFinite(delta) || delta === 0) {
    alert("请填写非零整数积分调整值");
    return;
  }
  if (reason.length < 2) {
    alert("请填写原因（至少 2 个字）");
    return;
  }
  try {
    await postJson(`/api/admin/users/${encodeURIComponent(state.selectedId)}/points`, { delta, reason });
    await loadList();
    await openDetail(state.selectedId);
    $("adminDelta").value = "";
    $("adminReason").value = "";
    alert("已保存");
  } catch (e) {
    alert(e.message);
  }
};

$("adminSaveDisabled").onclick = async () => {
  if (!state.selectedId) return;
  const accountDisabled = $("adminDisabledToggle").checked;
  try {
    await patchJson(`/api/admin/users/${encodeURIComponent(state.selectedId)}`, { accountDisabled });
    await loadList();
    await openDetail(state.selectedId);
    alert("账号状态已更新");
  } catch (e) {
    alert(e.message);
  }
};

$("adminLogoutBtn").onclick = async () => {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
  window.location.href = "/login.html";
};

$("adminPaySearchBtn").onclick = () => {
  payState.q = String($("adminPaySearch").value || "").trim();
  payState.page = 1;
  loadPayList().catch((err) => alert(err.message));
};

$("adminPaySearch").addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") $("adminPaySearchBtn").click();
});

function buildPayExportUrl() {
  const qs = new URLSearchParams();
  const q = String($("adminPaySearch")?.value || "").trim();
  const from = String($("adminPayFrom")?.value || "").trim();
  const to = String($("adminPayTo")?.value || "").trim();
  const status = String($("adminPayStatus")?.value || "").trim();
  const credited = String($("adminPayCredited")?.value || "").trim();
  if (q) qs.set("q", q);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  if (status) qs.set("status", status);
  if (credited) qs.set("credited", credited);
  return `/api/admin/payments/alipay/export.csv?${qs}`;
}

$("adminPayExportBtn").onclick = () => {
  window.location.href = buildPayExportUrl();
};

let modelsConfigCache = { textModels: [], imageModels: [] };

function renderModels() {
  const tBody = $("adminTextModelRows");
  tBody.innerHTML = "";
  for (const m of modelsConfigCache.textModels) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input class="admin-input" type="text" value="${escapeHtml(m.modelId || "")}" data-key="modelId" placeholder="如 gpt-4" /></td>
      <td><input class="admin-input" type="text" value="${escapeHtml(m.modelName || "")}" data-key="modelName" placeholder="前台名称" /></td>
      <td><input class="admin-input" type="text" value="${escapeHtml(m.hint || "")}" data-key="hint" /></td>
      <td><input class="admin-input" type="number" step="0.1" value="${m.promptCost || 3.0}" data-key="promptCost" /></td>
      <td><input class="admin-input" type="number" step="0.1" value="${m.completionCost || 24.0}" data-key="completionCost" /></td>
      <td><button type="button" class="ghost admin-remove-btn">✖ 移除</button></td>
    `;
    tr.querySelector(".admin-remove-btn").onclick = () => { tr.remove(); };
    tBody.appendChild(tr);
  }

  const iBody = $("adminImageModelRows");
  iBody.innerHTML = "";
  for (const m of modelsConfigCache.imageModels) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input class="admin-input" type="text" value="${escapeHtml(m.modelId || "")}" data-key="modelId" placeholder="前台ID" /></td>
      <td><input class="admin-input" type="text" value="${escapeHtml(m.modelName || "")}" data-key="modelName" /></td>
      <td><input class="admin-input" type="text" value="${escapeHtml(m.toapisModel || "")}" data-key="toapisModel" placeholder="ToAPIs对应ID" /></td>
      <td><input class="admin-input" type="number" step="1" value="${m.pointsCost || 20}" data-key="pointsCost" /></td>
      <td><button type="button" class="ghost admin-remove-btn">✖ 移除</button></td>
    `;
    tr.querySelector(".admin-remove-btn").onclick = () => { tr.remove(); };
    iBody.appendChild(tr);
  }
}

async function loadModelsList() {
  const data = await getJson(`/api/admin/models`).catch(() => null);
  if (data?.ok) {
    const d = data.data || {};
    modelsConfigCache = { textModels: d.textModels || [], imageModels: d.imageModels || [] };
    if ($("adminOioiapiBaseUrl")) $("adminOioiapiBaseUrl").value = String(d.oioiapiBaseUrl || "").trim();
    renderModels();
  }
}

$("adminAddTextModelBtn").onclick = () => {
  modelsConfigCache.textModels.push({ modelId: "", modelName: "", hint: "", promptCost: 3.0, completionCost: 24.0 });
  renderModels();
};

$("adminAddImageModelBtn").onclick = () => {
  modelsConfigCache.imageModels.push({ modelId: "", modelName: "", toapisModel: "", pointsCost: 20 });
  renderModels();
};

$("adminSaveModelsBtn").onclick = async () => {
  const newTextModels = [];
  $("adminTextModelRows").querySelectorAll("tr").forEach(tr => {
    const getV = (k) => tr.querySelector(`[data-key="${k}"]`)?.value || "";
    const mId = getV("modelId").trim();
    if (mId) {
      newTextModels.push({
        modelId: mId,
        modelName: getV("modelName").trim(),
        hint: getV("hint").trim(),
        promptCost: Number(getV("promptCost")) || 0,
        completionCost: Number(getV("completionCost")) || 0
      });
    }
  });

  const newImageModels = [];
  $("adminImageModelRows").querySelectorAll("tr").forEach(tr => {
    const getV = (k) => tr.querySelector(`[data-key="${k}"]`)?.value || "";
    const mId = getV("modelId").trim();
    if (mId) {
      newImageModels.push({
        modelId: mId,
        modelName: getV("modelName").trim(),
        toapisModel: getV("toapisModel").trim(),
        pointsCost: Number(getV("pointsCost")) || 0
      });
    }
  });

  const oioiapiBaseUrl = String($("adminOioiapiBaseUrl")?.value || "").trim();
  try {
    const res = await postJson("/api/admin/models", { textModels: newTextModels, imageModels: newImageModels, oioiapiBaseUrl });
    if (res?.ok) {
      alert("✅ 已成功保存并热重载生效！前台刷新可见。");
      await loadModelsList();
    }
  } catch (err) {
    alert("保存失败: " + err.message);
  }
};

init();
