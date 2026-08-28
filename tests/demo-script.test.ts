import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("demo script quotes the current UI labels and discloses the SSE polling boundary", async () => {
  const [script, html, app] = await Promise.all([
    readFile("docs/DEMO-SCRIPT.md", "utf8"),
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);

  const quotedUiLabels = [
    "使用缓存快照",
    "研究问题",
    "运行黄金案例",
    "任务总览",
    "候选结论",
    "查看依据",
    "结论证据路径",
    "证据底稿",
    "审查修正",
    "来源更新",
    "发现新版来源 →",
    "成果交付",
    "联网核验来源",
    "验证并上传资料",
  ];
  const uiSource = `${html}\n${app}`;
  for (const label of quotedUiLabels) {
    assert.ok(uiSource.includes(label), `current UI must contain the quoted label: ${label}`);
    assert.ok(script.includes(label), `demo script must quote the current UI label: ${label}`);
  }

  assert.match(script, /当前 UI 仍轮询/u);
  assert.match(script, /PLAN → COLLECT → SYNTHESIZE → AUDIT → DELIVER/u);
  assert.match(script, /中国光伏组件出口价格/u);
  assert.match(script, /INSUFFICIENT_EVIDENCE/u);
});
