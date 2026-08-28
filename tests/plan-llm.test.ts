import assert from "node:assert/strict";
import test from "node:test";

import { PLAN_TOOL_ALLOWLIST, validatePlanSteps, type PlanStepDraft } from "../src/llm.js";

function step(toolName: string, objective = "围绕研究问题执行该工具的关键动作", expectedOutput = "结构化产物"): PlanStepDraft {
  return { objective, toolName, expectedOutput };
}

const VALID_PLAN: PlanStepDraft[] = [
  step("snapshot-search", "检索与研究问题相关的权威信源"),
  step("pdf-reader", "解析本地行业 PDF 并保留页码定位"),
  step("csv-calculator", "读取市场 CSV 并执行确定性重算"),
  step("deterministic-audit", "对候选结论执行六规则审查"),
  step("pptx-generator", "生成交付成果"),
];

test("a contract-valid LLM plan passes program validation", () => {
  const valid = validatePlanSteps(VALID_PLAN, PLAN_TOOL_ALLOWLIST);
  assert.deepEqual(valid?.map((draft) => draft.toolName), [
    "snapshot-search",
    "pdf-reader",
    "csv-calculator",
    "deterministic-audit",
    "pptx-generator",
  ]);
});

test("plans with tools outside the allowlist or missing anchors are rejected entirely", () => {
  // 不在允许列表的工具被剔除后，锚点不满足 → 整份拒绝。
  const hallucinated: PlanStepDraft[] = [
    step("web-crawler", "爬取任意网站"),
    ...VALID_PLAN.slice(0, 3),
    step("pptx-generator", "生成交付成果"),
  ];
  assert.equal(validatePlanSteps(hallucinated, PLAN_TOOL_ALLOWLIST), null);
  assert.equal(validatePlanSteps([step("web-crawler", "爬取任意网站"), ...VALID_PLAN], PLAN_TOOL_ALLOWLIST), null, "one unauthorized step poisons the whole plan instead of being silently dropped");
  assert.equal(validatePlanSteps(VALID_PLAN.slice(0, 4), PLAN_TOOL_ALLOWLIST), null);
  // 交付不在最后。
  assert.equal(validatePlanSteps([VALID_PLAN[4]!, ...VALID_PLAN.slice(0, 4)], PLAN_TOOL_ALLOWLIST), null);
  // 少于三步（只剩 audit + deliver）。
  assert.equal(validatePlanSteps(VALID_PLAN.slice(3), PLAN_TOOL_ALLOWLIST), null);
});

test("duplicate audit anchors or empty objectives invalidate the plan", () => {
  assert.equal(validatePlanSteps([...VALID_PLAN.slice(0, 4), step("deterministic-audit", "再次审查")], PLAN_TOOL_ALLOWLIST), null);
  // audit 步骤 objective 为空被剔除后，锚点缺失 → 整份拒绝。
  const auditDropped: PlanStepDraft[] = [VALID_PLAN[0]!, VALID_PLAN[1]!, VALID_PLAN[2]!, step("deterministic-audit", ""), VALID_PLAN[4]!];
  assert.equal(validatePlanSteps(auditDropped, PLAN_TOOL_ALLOWLIST), null);
});
