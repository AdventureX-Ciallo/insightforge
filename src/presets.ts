import { GOLDEN_RESEARCH_QUESTION } from "./model-cache.js";

export const researchPresets = Object.freeze([
  {
    id: "golden-nev-charging",
    question: GOLDEN_RESEARCH_QUESTION,
    kind: "golden" as const,
    description: "完整展示信源、计算、对抗审查、人工裁决与四格式交付。",
  },
  {
    id: "boundary-solar-export",
    question: "中国光伏组件出口价格是否受到海外库存周期约束？",
    kind: "boundary" as const,
    description: "非黄金问题：现有新能源汽车资料不匹配，应诚实返回信源与指标缺口。",
  },
  {
    id: "boundary-robot-certification",
    question: "中国工业机器人出口增长是否受到海外安全认证周期约束？",
    kind: "boundary" as const,
    description: "非黄金问题：用于验证系统不会套用新能源汽车的预写结论。",
  },
]);
