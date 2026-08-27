const state = { run: null, job: null, tab: "overview", editingId: null };
const $ = (selector) => document.querySelector(selector);

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function chip(text, tone = "") {
  return node("span", `chip ${tone}`.trim(), text);
}

function formatLocator(locator = {}) {
  const parts = [locator.fileName, locator.url];
  if (locator.page) parts.push(`第 ${locator.page} 页`);
  if (locator.sheet) parts.push(`工作表 ${locator.sheet}`);
  if (locator.cellRange) parts.push(locator.cellRange);
  if (locator.columns) parts.push(`列 ${locator.columns.join(", ")}`);
  if (locator.rows) parts.push(`行 ${locator.rows.join(", ")}`);
  return parts.filter(Boolean).join(" · ");
}

async function api(path, options) {
  const response = await fetch(path, options);
  const isJson = (response.headers.get("content-type") || "").includes("application/json");
  const body = isJson ? await response.json() : null;
  if (!response.ok) throw new Error(body?.error || `请求失败（${response.status}）`);
  return body;
}

function setError(message = "") {
  const error = $("#global-error");
  error.textContent = message;
  error.hidden = !message;
}

function uploadMime(file) {
  if (file.type) return file.type;
  const extension = file.name.toLowerCase().split(".").pop();
  return {
    pdf: "application/pdf",
    csv: "text/csv",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    txt: "text/plain",
  }[extension] || "application/octet-stream";
}

async function browserSha256(file) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function uploadSourceFile() {
  const input = $("#source-file");
  const button = $("#upload-button");
  const result = $("#upload-result");
  const file = input.files?.[0];
  if (!file) return;
  setError();
  button.disabled = true;
  result.hidden = false;
  result.className = "upload-result pending";
  result.textContent = `正在校验 ${file.name}…`;
  try {
    const localSha256 = await browserSha256(file);
    const response = await api("/api/uploads", {
      method: "POST",
      headers: {
        "content-type": uploadMime(file),
        "x-insightforge-file-name": encodeURIComponent(file.name),
      },
      body: file,
    });
    const verificationUrl = response.upload?.verificationUrl;
    if (typeof verificationUrl !== "string" || !/^\/api\/uploads\/[0-9a-f-]+$/iu.test(verificationUrl)) {
      throw new Error("服务端未返回有效的复核地址");
    }
    const verified = await api(verificationUrl);
    const upload = verified.upload;
    if (!upload.persisted || !upload.hashMatches
      || upload.id !== response.upload.id
      || upload.sha256 !== response.upload.sha256
      || upload.sha256 !== localSha256) {
      throw new Error("浏览器、创建响应与落盘复核的 SHA-256 不一致");
    }
    result.className = "upload-result success";
    result.textContent = `已持久化并复核 ${upload.originalFileName} → ${upload.sanitizedFileName} · ${(upload.sizeBytes / 1024).toFixed(1)} KB · SHA-256 ${upload.sha256} · 所选文件 SHA-256 一致`;
  } catch (error) {
    result.className = "upload-result failed";
    result.textContent = `上传被拒绝：${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function liveCheckSources() {
  const button = $("#live-check-button");
  const result = $("#live-check-result");
  button.disabled = true;
  result.hidden = false;
  result.replaceChildren(node("p", "", "正在访问白名单权威来源…"));
  try {
    const response = await api("/api/sources/live-check", { method: "POST" });
    const verified = response.results.filter((item) => item.status === "verified").length;
    result.replaceChildren(node("strong", "", `实时核验 ${verified}/${response.results.length} 成功 · ${response.checkedAt}`));
    response.results.forEach((item) => {
      const row = node("div", `live-source ${item.status}`);
      row.append(
        node("span", "", item.title),
        node("b", "", item.status === "verified" ? `HTTP ${item.httpStatus} · SHA-256 ${item.sha256}` : "网络核验失败，继续使用已标记快照"),
      );
      result.append(row);
    });
  } catch (error) {
    result.replaceChildren(node("p", "failed", `实时核验失败：${error.message}；离线快照仍可运行。`));
  } finally {
    button.disabled = false;
  }
}

function toneForStatus(status) {
  if (["INSUFFICIENT_EVIDENCE", "STALE", "NEEDS_REVIEW", "REJECTED"].includes(status)) return "danger";
  if (["CONFLICT", "PENDING_REVIEW", "NEEDS_HUMAN"].includes(status)) return "warn";
  return "";
}

function renderRail() {
  const rail = $("#state-rail");
  rail.replaceChildren();
  const steps = state.run?.steps || state.job?.steps || ["PLAN", "COLLECT", "SYNTHESIZE", "AUDIT", "DELIVER"].map((value) => ({ state: value, status: "pending", summary: "" }));
  steps.forEach((step, index) => {
    const card = node("article", `state-card ${step.status}`);
    card.append(node("span", "state-index", `STEP ${String(index + 1).padStart(2, "0")}`));
    card.append(node("strong", "state-name", step.state));
    card.append(node("p", "state-summary", step.summary || (step.status === "running" ? "正在生成结构化输出…" : "等待上一步输出")));
    const status = node("span", "state-status");
    status.append(node("i"), node("span", "", step.status));
    card.append(status);
    rail.append(card);
  });
}

function panelHeader(kicker, title, description) {
  const header = node("header", "panel-header");
  const copy = node("div");
  copy.append(node("span", "panel-kicker", kicker), node("h3", "", title), node("p", "", description));
  header.append(copy);
  return header;
}

function renderOverview(panel, run) {
  panel.append(panelHeader("RUN SUMMARY", "一次任务，五步推进到成果", "计划中的每个步骤对应真实执行，输出 ID 让上下游消费关系可核验。"));
  const metrics = node("div", "metric-grid");
  const values = [
    ["真实工具调用", run.events.length, "搜索 · PDF · CSV 计算 · PPTX"],
    ["候选结论", run.conclusions.length, "100% 具有证据路径"],
    ["审查发现", run.auditFindings.length, `自动修复 ${run.repairAttempts}/1 次`],
    ["可交付成果", run.artifacts.length + 1, "交互报告 · PPTX · JSON"],
  ];
  values.forEach(([label, value, note]) => {
    const card = node("article", "metric");
    card.append(node("span", "metric-label", label), node("strong", "metric-value", value), node("span", "metric-note", note));
    metrics.append(card);
  });
  panel.append(metrics, node("h4", "section-title", "工具执行事件"));
  const timeline = node("div", "tool-timeline");
  run.events.forEach((event, index) => {
    const row = node("div", "tool-row");
    row.append(
      node("span", "tool-number", String(index + 1).padStart(2, "0")),
      node("strong", "", event.toolName),
      node("span", "tool-input", event.inputSummary),
      node("span", event.status === "success" ? "tool-success" : "chip danger", event.status),
      node("span", "tool-duration", `${event.duration} ms`),
    );
    timeline.append(row);
  });
  panel.append(timeline);
}

function conclusionClass(conclusion) {
  if (conclusion.evidenceStatus === "CONFLICT") return "conflict";
  if (conclusion.evidenceStatus === "INSUFFICIENT_EVIDENCE") return "insufficient";
  if (conclusion.evidenceStatus === "STALE") return "stale";
  return "";
}

function actionButton(text, className, handler, disabled = false) {
  const button = node("button", className, text);
  button.type = "button";
  button.disabled = disabled;
  button.addEventListener("click", handler);
  return button;
}

function renderConclusions(panel, run) {
  panel.append(panelHeader("HUMAN-IN-THE-LOOP", "候选结论与最终责任", "AI 生成内容默认待复核；只有人的显式动作才能确认、编辑或驳回。"));
  const list = node("div", "conclusion-list");
  run.conclusions.forEach((conclusion, index) => {
    const card = node("article", `conclusion-card ${conclusionClass(conclusion)}`);
    const top = node("div", "card-top");
    top.append(node("span", "card-id", `CONCLUSION ${String(index + 1).padStart(2, "0")}`));
    const statuses = node("div", "card-statuses");
    statuses.append(
      chip(conclusion.type, conclusion.type === "HUMAN_CONFIRMED" ? "" : "warn"),
      chip(conclusion.evidenceStatus, toneForStatus(conclusion.evidenceStatus)),
      chip(conclusion.reviewStatus, toneForStatus(conclusion.reviewStatus)),
    );
    top.append(statuses);
    card.append(top, node("h4", "", conclusion.text));
    if (conclusion.missingEvidence.length) card.append(node("p", "missing-evidence", `缺少：${conclusion.missingEvidence.join(" · ")}`));
    const actions = node("div", "card-actions");
    actions.append(actionButton("查看依据", "mini-button", () => openEvidence(conclusion.id)));
    const blocked = conclusion.evidenceStatus === "INSUFFICIENT_EVIDENCE" || conclusion.evidenceStatus === "STALE";
    actions.append(
      actionButton("确认", "mini-button confirm", () => decide(conclusion.id, "CONFIRM"), blocked),
      actionButton("编辑", "mini-button", () => editConclusion(conclusion)),
      actionButton("驳回", "mini-button reject", () => decide(conclusion.id, "REJECT")),
    );
    card.append(actions);
    list.append(card);
  });
  panel.append(list);
}

function renderEvidence(panel, run) {
  panel.append(panelHeader("SOURCE LEDGER", "证据底稿与精确定位", "网页保留 URL，PDF 保留页码，CSV 保留列名、行号、公式和输入。来源说法不自动升级为事实。"));
  const conflict = run.conflicts[0];
  if (conflict) {
    const box = node("article", "conflict-box");
    box.append(node("span", "panel-kicker", "SOURCE CONFLICT"), node("h3", "", conflict.metric));
    const values = node("div", "conflict-values");
    const conflictData = conflict.datumIds.map((id) => run.data.find((datum) => datum.id === id)).filter(Boolean);
    conflictData.forEach((datum, index) => {
      if (index) values.append(node("span", "conflict-vs", "≠"));
      const value = node("div", "conflict-value");
      value.append(node("strong", "", `${datum.value.toFixed(1)}${datum.unit}`), node("span", "", datum.metric));
      values.append(value);
    });
    box.append(values, node("p", "", conflict.explanation), chip(conflict.explanationStatus, "warn"));
    panel.append(box, node("h4", "section-title", "全部证据"));
  }
  const list = node("div", "evidence-list");
  run.evidence.forEach((evidence) => {
    const source = run.sources.find((item) => item.id === evidence.sourceId);
    const row = node("article", "evidence-row");
    const header = node("header");
    header.append(node("h4", "", source?.title || evidence.sourceId), chip(evidence.type, evidence.type === "SOURCE_OPINION" ? "warn" : ""));
    row.append(header, node("blockquote", "", evidence.excerpt), node("div", "locator", formatLocator(evidence.locator)));
    list.append(row);
  });
  panel.append(list);
}

function renderAudit(panel, run) {
  panel.append(panelHeader("AUDIT → REPAIR", "结构化审查与一次修正", "审查读取的是结构化证据和候选结论；自动修复最多一次，严重问题继续交给人。"));
  const list = node("div", "audit-list");
  run.auditFindings.forEach((finding) => {
    const card = node("article", "audit-card");
    const header = node("header");
    header.append(node("h4", "", finding.category), chip(finding.status, toneForStatus(finding.status)));
    card.append(header, node("p", "", finding.message));
    const diff = node("div", "audit-diff");
    const before = node("div", "diff-box");
    before.append(node("span", "", "BEFORE"), node("p", "", finding.before));
    const after = node("div", "diff-box");
    after.append(node("span", "", "AFTER"), node("p", "", finding.after));
    diff.append(before, node("div", "diff-arrow", "→"), after);
    card.append(diff, node("p", "audit-action", `动作：${finding.action}`));
    list.append(card);
  });
  panel.append(list);
}

function renderUpdates(panel, run) {
  panel.append(panelHeader("CHANGE IMPACT", "来源变化导致结论失效", "最小确定性影响分析：只沿已记录的数据—判断—结论路径传播，不影响无关对象。"));
  const update = node("article", "update-card");
  const copy = node("div");
  copy.append(node("h4", "", run.sourceVersion === "v1" ? "发现来源 A 的 v2" : "来源已更新到 v2"));
  copy.append(node("p", "", run.sourceVersion === "v1" ? "将中汽协 2024 年预测（1150 万辆）切换为最终发布（1286.6 万辆）。系统将撤销相关人工确认、重算全汽车销量份额并刷新 PPTX。" : "相关 Datum、Claim、Conclusion 已标记待复核；充电供给判断保持不变。"));
  update.append(copy);
  if (run.sourceVersion === "v1") update.append(actionButton("发现新版来源 →", "primary-button", updateSource));
  else update.append(chip("UPDATED", ""));
  panel.append(update);
  if (run.affectedObjectIds.length) {
    panel.append(node("h4", "section-title", "受影响对象"));
    const impacts = node("div", "impact-list");
    run.affectedObjectIds.forEach((id) => {
      const item = node("div", "impact");
      item.append(node("strong", "", id.split("-")[0].toUpperCase()), node("span", "", id));
      impacts.append(item);
    });
    panel.append(impacts);
  }
}

function renderArtifacts(panel, run) {
  panel.append(panelHeader("DELIVERABLES", "三个真实成果", "交互式报告正在这里运行；PPTX 是可编辑文本与形状，JSON 保留完整证据链。"));
  const grid = node("div", "artifact-grid");
  const report = node("article", "artifact-card");
  report.append(node("div", "artifact-icon", "WEB"), node("h4", "", "交互式研究报告"), node("p", "", "下钻证据、处理冲突、审查修正并追踪来源更新。"), chip("CURRENT VIEW"));
  grid.append(report);
  run.artifacts.forEach((artifact) => {
    const card = node("article", "artifact-card");
    const label = artifact.kind === "PPTX" ? "PPTX" : "JSON";
    const title = artifact.kind === "PPTX" ? "可编辑 PowerPoint" : "机器可读证据包";
    const description = artifact.kind === "PPTX" ? "固定 5 页模板；标题、正文和数字均为可编辑对象。" : "信源、证据、数据、判断、审查、人工决定与成果索引。";
    card.append(node("div", "artifact-icon", label), node("h4", "", title), node("p", "", description));
    card.append(node("div", "artifact-meta", `${(artifact.sizeBytes / 1024).toFixed(1)} KB · SHA-256 ${artifact.sha256}`));
    const link = node("a", "download-link", `下载 ${label}`);
    link.href = `/api/runs/${encodeURIComponent(run.id)}/artifacts/${artifact.kind}`;
    link.setAttribute("download", "");
    card.append(link);
    grid.append(card);
  });
  panel.append(grid);
}

function renderPanel() {
  const panel = $("#report-panel");
  panel.replaceChildren();
  const run = state.run;
  if (!run) {
    const empty = node("div", "empty-state");
    empty.append(node("div", "spinner"), node("h3", "", "Agent 正在推进任务"), node("p", "", "页面会持续显示 PLAN → DELIVER 的真实进度。"));
    panel.append(empty);
    return;
  }
  const renderers = { overview: renderOverview, conclusions: renderConclusions, evidence: renderEvidence, audit: renderAudit, updates: renderUpdates, artifacts: renderArtifacts };
  renderers[state.tab](panel, run);
}

function render() {
  const workspace = $("#workspace");
  workspace.hidden = !state.run && !state.job;
  if (workspace.hidden) return;
  $("#run-title").textContent = state.run?.researchQuestion || "正在规划研究任务…";
  const terminal = $("#terminal-status");
  const status = state.run?.terminalStatus || state.job?.status?.toUpperCase() || "RUNNING";
  terminal.textContent = status;
  terminal.className = `terminal-status ${status === "DELIVERED" ? "delivered" : status === "FAILED" ? "failed" : ""}`;
  renderRail();
  renderPanel();
}

async function runResearch() {
  const button = $("#run-button");
  const question = $("#research-question").value.trim();
  setError();
  if (question.length < 8) return setError("请输入至少 8 个字的研究问题。");
  button.disabled = true;
  state.run = null;
  state.job = { status: "running", steps: [] };
  state.tab = "overview";
  render();
  $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const created = await api("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ researchQuestion: question }) });
    while (!state.run) {
      const result = await api(created.statusUrl);
      state.job = result.job;
      if (result.run) state.run = result.run;
      if (result.job.status === "failed") throw new Error(result.job.error || "任务失败");
      render();
      if (!state.run) await new Promise((resolveWait) => setTimeout(resolveWait, 130));
    }
  } catch (error) {
    setError(error.message);
  } finally {
    button.disabled = false;
  }
}

async function decide(conclusionId, action, text) {
  try {
    const body = { conclusionId, action, ...(text ? { text } : {}) };
    const response = await api(`/api/runs/${encodeURIComponent(state.run.id)}/decisions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    state.run = response.run;
    render();
  } catch (error) { setError(error.message); }
}

function editConclusion(conclusion) {
  state.editingId = conclusion.id;
  $("#edit-text").value = conclusion.text;
  const staysPending = conclusion.evidenceStatus === "INSUFFICIENT_EVIDENCE" || conclusion.evidenceStatus === "STALE";
  $("#edit-help").textContent = staysPending
    ? "原始 AI 文本将被保留；当前证据状态不允许确认，修订后仍保持待复核。"
    : "原始 AI 文本将被保留，修订后的文字会记录为人工确认版本。";
  $("#edit-save").textContent = staysPending ? "保存修订（仍待复核）" : "保存并确认";
  $("#edit-dialog").showModal();
}

async function updateSource() {
  try {
    const response = await api(`/api/runs/${encodeURIComponent(state.run.id)}/source-update`, { method: "POST" });
    state.run = response.run;
    render();
  } catch (error) { setError(error.message); }
}

function openEvidence(conclusionId) {
  const run = state.run;
  const conclusion = run.conclusions.find((item) => item.id === conclusionId);
  if (!conclusion) return;
  const content = $("#drawer-content");
  content.replaceChildren(node("p", "eyebrow", "TRACE TO SOURCE"), node("h3", "", "结论证据路径"));
  const conclusionNode = node("div", "chain-node");
  conclusionNode.append(node("label", "", "CONCLUSION"), node("p", "", conclusion.text));
  content.append(conclusionNode);
  conclusion.claimIds.forEach((claimId) => {
    const claim = run.claims.find((item) => item.id === claimId);
    if (!claim) return;
    content.append(node("div", "chain-arrow", "↓"));
    const claimNode = node("div", "chain-node");
    claimNode.append(node("label", "", `${claim.type} · ${claim.evidenceStatus}`), node("p", "", claim.text));
    content.append(claimNode);
    claim.evidenceIds.forEach((evidenceId) => {
      const evidence = run.evidence.find((item) => item.id === evidenceId);
      const source = run.sources.find((item) => item.id === evidence?.sourceId);
      if (!evidence || !source) return;
      content.append(node("div", "chain-arrow", "↓"));
      const evidenceNode = node("div", "chain-node");
      evidenceNode.append(node("label", "", `EVIDENCE · ${evidence.type}`), node("p", "", evidence.excerpt));
      content.append(evidenceNode, node("div", "chain-arrow", "↓"));
      const sourceNode = node("div", "chain-node");
      sourceNode.append(node("label", "", `SOURCE · ${source.kind}`), node("p", "", `${source.title}\n${formatLocator(evidence.locator)}`));
      content.append(sourceNode);
    });
  });
  $("#drawer").classList.add("open");
  $("#drawer").setAttribute("aria-hidden", "false");
  $("#drawer-scrim").hidden = false;
}

function closeDrawer() {
  $("#drawer").classList.remove("open");
  $("#drawer").setAttribute("aria-hidden", "true");
  $("#drawer-scrim").hidden = true;
}

document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => {
  state.tab = button.dataset.tab;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item === button));
  renderPanel();
}));
$("#run-button").addEventListener("click", runResearch);
$("#source-file").addEventListener("change", () => {
  $("#upload-button").disabled = !$("#source-file").files?.length;
  $("#upload-result").hidden = true;
});
$("#upload-button").addEventListener("click", uploadSourceFile);
$("#live-check-button").addEventListener("click", liveCheckSources);
$("#drawer-close").addEventListener("click", closeDrawer);
$("#drawer-scrim").addEventListener("click", closeDrawer);
$("#edit-dialog").addEventListener("close", async () => {
  if ($("#edit-dialog").returnValue === "default" && state.editingId) await decide(state.editingId, "EDIT", $("#edit-text").value.trim());
  state.editingId = null;
});

try {
  const current = await api("/api/current");
  state.run = current.run;
  $("#research-question").value = current.run.researchQuestion;
  render();
} catch {
  // A clean environment starts without a run; the one-click golden case is ready.
}
