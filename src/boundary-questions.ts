import type { ResearchRun } from "./domain.js";

export interface BoundaryQuestion {
  question: string;
  rationale: string;
  missingEvidence: string[];
  evidenceGapIds: string[];
}

function unique(values: string[]) {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

/**
 * 只提出当前证据范围之外的问题，不把“相关问题”误报成已有结论。
 * 既有 EvidenceGap 的 missingItems 会原样进入缺口清单，保持与失配综合相同的语义。
 */
export function buildBoundaryQuestions(run: ResearchRun): BoundaryQuestion[] {
  const focus = run.researchQuestion.replace(/[？?。.!！\s]+/gu, "").slice(0, 64) || "当前研究问题";
  const unresolvedGaps = run.evidenceGaps.filter((gap) => gap.resolvedAt === null);
  const gapDescriptions = unique(unresolvedGaps.flatMap((gap) => gap.missingItems.map((item) => item.description)));
  const gapIds = unresolvedGaps.map((gap) => gap.id);
  const crossCheckGapIds = unresolvedGaps
    .filter((gap) => gap.missingItems.some((item) => item.kind === "CROSS_CHECK" || item.kind === "METHOD"))
    .map((gap) => gap.id);

  return [
    {
      question: `若把「${focus}」细分到城市与区域层级，当前判断是否仍成立？`,
      rationale: "当前信源主要给出全国或汇总口径，不能外推到区域利用率和供需错配。",
      missingEvidence: ["城市/区域层级的充电设施数量、利用率与新能源车保有量时间序列", "区域口径、样本覆盖与缺失值说明"],
      evidenceGapIds: unresolvedGaps.filter((gap) => gap.missingItems.some((item) => item.kind === "SCOPE")).map((gap) => gap.id),
    },
    {
      question: `「${focus}」与运营商单站盈利之间是否存在可验证关系？`,
      rationale: "规模和增速不能替代收入、成本与因果识别；已有缺口继续阻断确认。",
      missingEvidence: unique([...gapDescriptions, "运营商单站收入、利用率、电价、运维成本与资本开支数据", "可区分相关性与因果性的识别方法"]),
      evidenceGapIds: gapIds,
    },
    {
      question: `若纳入私人充电、换电等替代基础设施，「${focus}」的约束判断是否改变？`,
      rationale: "本轮证据未覆盖替代网络，公共充电规模不能代表全部补能选择。",
      missingEvidence: ["私人充电、公共充电与换电的使用占比及覆盖范围", "同口径的跨网络用户行为和重复计算校验"],
      evidenceGapIds: crossCheckGapIds,
    },
  ];
}
