import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("demo script quotes the current UI labels and discloses the SSE polling boundary", async () => {
  const componentFiles = (await readdir("web/src/components"))
    .filter((name) => name.endsWith(".tsx"))
    .map((name) => readFile(`web/src/components/${name}`, "utf8"));
  const [script, app, ...components] = await Promise.all([
    readFile("docs/DEMO-SCRIPT.md", "utf8"),
    readFile("web/src/App.tsx", "utf8"),
    ...componentFiles,
  ]);

  const quotedUiLabels = [
    "选择一个研究选题",
    "全功能研究案例",
    "开始研究",
    "任务进度",
    "查看依据",
    "证据路径",
    "审查修正",
    "检查来源更新",
    "来源更新，精确影响成果",
    "成果交付",
    "运行白名单核验",
    "资料库 · 验证并保存文件",
  ];
  const uiSource = `${app}\n${components.join("\n")}`;
  for (const label of quotedUiLabels) {
    assert.ok(uiSource.includes(label), `current UI must contain the quoted label: ${label}`);
    assert.ok(script.includes(label), `demo script must quote the current UI label: ${label}`);
  }

  assert.match(script, /页面现在通过 SSE/u);
  assert.match(script, /降级轮询/u);
  assert.match(script, /PLAN → COLLECT → SYNTHESIZE → AUDIT → DELIVER/u);
  assert.match(script, /边界验证/u);
  assert.match(script, /EvidenceGap/u);
});
