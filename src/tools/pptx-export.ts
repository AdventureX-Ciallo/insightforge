import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import JSZip from "jszip";

import type { ResearchRun } from "../domain.js";

const EMU = 914400;
const C = { navy: "122033", cyan: "22C3A6", amber: "F5B942", red: "E85D75", white: "FFFFFF", mist: "EEF4F7", slate: "566579", line: "D8E1E7" };
const escapeXml = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char] ?? char);
const emu = (value: number) => Math.round(value * EMU);

interface TextOptions {
  size?: number;
  color?: string;
  bold?: boolean;
  align?: "l" | "ctr" | "r";
  valign?: "t" | "ctr" | "b";
}

class SlideBuilder {
  readonly shapes: string[] = [];
  private id = 2;

  constructor(readonly background: string) {}

  rect(x: number, y: number, w: number, h: number, fill: string, line = fill, rounded = false) {
    const id = this.id++;
    this.shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="${rounded ? "roundRect" : "rect"}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:ln w="9525"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody></p:sp>`);
  }

  text(value: string, x: number, y: number, w: number, h: number, options: TextOptions = {}) {
    const id = this.id++;
    const size = Math.round((options.size ?? 14) * 100);
    const color = options.color ?? C.navy;
    const align = options.align ?? "l";
    const anchor = options.valign ?? "ctr";
    const font = options.bold ? "Aptos Display" : "Aptos";
    const paragraphs = String(value).split("\n").map((line) => `<a:p><a:pPr algn="${align}"/><a:r><a:rPr lang="zh-CN" sz="${size}"${options.bold ? ' b="1"' : ""}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${font}"/><a:ea typeface="${font}"/></a:rPr><a:t>${escapeXml(line)}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="${size}"/></a:p>`).join("");
    this.shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="27432" tIns="27432" rIns="27432" bIns="27432" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`);
  }

  header(eyebrow: string, title: string, page: number) {
    this.rect(0, 0, 13.333, 0.12, C.cyan);
    this.text(eyebrow.toUpperCase(), 0.7, 0.32, 5.6, 0.28, { size: 10, color: C.cyan, bold: true });
    this.text(title, 0.7, 0.72, 11.5, 0.68, { size: 27, bold: true });
    this.text(String(page).padStart(2, "0"), 12.05, 7.02, 0.55, 0.2, { size: 9, color: C.slate, align: "r" });
  }
}

function buildSlides(run: ResearchRun) {
  const slides: SlideBuilder[] = [];

  const cover = new SlideBuilder(C.navy);
  cover.rect(0.72, 0.72, 0.13, 1.2, C.cyan);
  cover.text("PROOF OF INSIGHT", 1.1, 0.77, 4.6, 0.34, { size: 11, color: C.cyan, bold: true });
  cover.text(run.researchQuestion, 1.1, 1.32, 10.9, 1.55, { size: 30, color: C.white, bold: true });
  cover.text("研究范围 · 2023–2026｜中国乘用车与公共充电基础设施", 1.1, 3.08, 9.8, 0.42, { size: 15, color: "C7D3DE" });
  cover.text("离线黄金案例 · 使用缓存快照", 1.1, 5.95, 4.3, 0.36, { size: 12, color: C.amber, bold: true });
  cover.text("01", 12.05, 7.02, 0.55, 0.2, { size: 9, color: "9FB0C0", align: "r" });
  slides.push(cover);

  const conclusions = new SlideBuilder(C.white);
  conclusions.header("Core conclusions", "核心结论与人工确认状态", 2);
  run.conclusions.forEach((conclusion, index) => {
    const y = 1.55 + index * 1.28;
    const color = conclusion.evidenceStatus === "INSUFFICIENT_EVIDENCE" ? C.red : conclusion.evidenceStatus === "CONFLICT" ? C.amber : C.cyan;
    conclusions.text(String(index + 1).padStart(2, "0"), 0.72, y, 0.45, 0.35, { size: 16, color, bold: true });
    conclusions.text(conclusion.text, 1.35, y - 0.03, 9.35, 0.78, { size: 14, bold: true, valign: "t" });
    conclusions.rect(10.92, y, 1.65, 0.34, color, color, true);
    conclusions.text(conclusion.reviewStatus, 10.98, y + 0.02, 1.53, 0.25, { size: 8, color: C.white, bold: true, align: "ctr" });
    conclusions.text(conclusion.sourceIds.map((_, sourceIndex) => `[S${sourceIndex + 1}]`).join(" "), 1.35, y + 0.8, 2.4, 0.2, { size: 8, color: C.slate });
    if (index < run.conclusions.length - 1) conclusions.rect(1.35, y + 1.08, 11.1, 0.008, C.line);
  });
  slides.push(conclusions);

  const data = new SlideBuilder(C.white);
  data.header("Deterministic calculations", "关键数据、公式与可重算输入", 3);
  const calculation = run.data.find((datum) => datum.id === "datum-penetration");
  const estimate = run.data.find((datum) => datum.id === "datum-adequacy-estimate");
  data.rect(0.75, 1.65, 5.75, 3.5, C.mist, "D5E2E8", true);
  data.text(`${calculation?.value.toFixed(1)}%`, 1.15, 2.0, 4.7, 0.8, { size: 38, bold: true, align: "ctr" });
  data.text(run.sourceVersion === "v1" ? "2024 新能源汽车份额（预测输入）" : "2024 新能源汽车新车销量占比（最终）", 1.15, 2.9, 4.7, 0.34, { size: 15, color: C.slate, bold: true, align: "ctr" });
  data.text(`${calculation?.formula}\n输入：${calculation?.inputs.map((input) => `${input.label}=${input.value}${input.unit}`).join("；")}`, 1.12, 3.55, 4.82, 1.0, { size: 11, color: C.slate, valign: "t" });
  data.rect(6.85, 1.65, 5.75, 3.5, "FFF7E5", "F4DCA4", true);
  data.text(`${estimate?.value.toFixed(2)} 百万`, 7.25, 2.0, 4.7, 0.8, { size: 34, bold: true, align: "ctr" });
  data.text("风险调整后可有效服务充电点（估算）", 7.25, 2.9, 4.7, 0.34, { size: 14, color: C.slate, bold: true, align: "ctr" });
  data.text(`${estimate?.formula}\n假设：${estimate?.assumptions.join("；")}`, 7.22, 3.55, 4.82, 1.0, { size: 11, color: C.slate, valign: "t" });
  data.text(`计算来源：market_${run.sourceVersion}.csv｜中汽协与中国充电联盟公开资料的结构化离线摘录`, 0.8, 5.65, 11.7, 0.35, { size: 11, color: C.slate });
  slides.push(data);

  const boundary = new SlideBuilder(C.white);
  boundary.header("Boundaries", "冲突、假设与证据不足", 4);
  boundary.text("来源冲突", 0.8, 1.65, 3.8, 0.4, { size: 20, color: C.amber, bold: true });
  boundary.text(run.conflicts[0]?.explanation ?? "无", 0.8, 2.15, 5.65, 1.35, { size: 14, valign: "t" });
  boundary.text("CANDIDATE_EXPLANATION\n保留双方数值，不静默取值，不求平均。", 0.8, 3.7, 5.65, 0.8, { size: 11, color: C.slate, bold: true, valign: "t" });
  boundary.rect(6.66, 1.62, 0.012, 4.7, C.line);
  boundary.text("证据不足", 7.05, 1.65, 3.8, 0.4, { size: 20, color: C.red, bold: true });
  const insufficient = run.conclusions.find((item) => item.evidenceStatus === "INSUFFICIENT_EVIDENCE");
  boundary.text(insufficient?.text ?? "无", 7.05, 2.15, 5.3, 1.35, { size: 14, valign: "t" });
  boundary.rect(7.05, 3.65, 2.45, 0.36, C.red, C.red, true);
  boundary.text("INSUFFICIENT_EVIDENCE", 7.13, 3.7, 2.29, 0.23, { size: 8, color: C.white, bold: true, align: "ctr" });
  boundary.text(`缺少：${insufficient?.missingEvidence.join("；") ?? "无"}`, 7.05, 4.23, 5.3, 0.76, { size: 11, color: C.red, bold: true, valign: "t" });
  boundary.text("状态保留在报告、PPTX 与 JSON；禁止自动确认。", 7.05, 5.25, 5.3, 0.42, { size: 11, color: C.slate });
  slides.push(boundary);

  const sources = new SlideBuilder(C.white);
  sources.header("Traceability", "来源、定位与最终责任", 5);
  run.sources.slice(0, 5).forEach((source, index) => {
    const y = 1.55 + index * 0.95;
    sources.text(`[S${index + 1}]`, 0.75, y, 0.55, 0.25, { size: 11, color: C.cyan, bold: true });
    sources.text(source.title, 1.45, y, 7.45, 0.3, { size: 12, bold: true });
    const locator = source.locator.url ?? `${source.locator.fileName ?? ""}${source.locator.page ? ` · p.${source.locator.page}` : ""}${source.locator.rows ? ` · rows ${source.locator.rows.join(",")}` : ""}`;
    sources.text(locator, 1.45, y + 0.36, 8.4, 0.22, { size: 8, color: C.slate });
  });
  sources.rect(9.65, 1.55, 2.85, 3.9, C.navy, C.navy, true);
  sources.text("AI 生成候选判断\n\n确定性规则审计\n\n人确认最终结论", 10.05, 2.05, 2.05, 2.7, { size: 16, color: C.white, bold: true, align: "ctr" });
  sources.text("未确认内容不冒充最终结论", 9.85, 5.75, 2.45, 0.35, { size: 10, color: C.red, bold: true, align: "ctr" });
  slides.push(sources);
  return slides;
}

const emptyTree = `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>`;
const relationships = (content: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${content}</Relationships>`;

function packagePresentation(zip: JSZip, slides: SlideBuilder[], run: ResearchRun) {
  const overrides = slides.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${overrides}</Types>`);
  zip.file("_rels/.rels", relationships(`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>`));
  const slideIds = slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join("");
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr></p:defaultTextStyle></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", relationships(`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slides.map((_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join("")}<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/><Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps" Target="viewProps.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/><Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles" Target="tableStyles.xml"/>`));
  zip.file("ppt/presProps.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`);
  zip.file("ppt/viewProps.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:normalViewPr><p:restoredLeft sz="15611"/><p:restoredTop sz="94658"/></p:normalViewPr><p:slideViewPr><p:cSldViewPr><p:cViewPr><p:scale><a:sx n="100" d="100"/><a:sy n="100" d="100"/></p:scale><p:origin x="0" y="0"/></p:cViewPr><p:guideLst/></p:cSldViewPr></p:slideViewPr><p:notesTextViewPr><p:cViewPr><p:scale><a:sx n="1" d="1"/><a:sy n="1" d="1"/></p:scale><p:origin x="0" y="0"/></p:cViewPr></p:notesTextViewPr><p:gridSpacing cx="72008" cy="72008"/></p:viewPr>`);
  zip.file("ppt/tableStyles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);
  zip.file("ppt/slideMasters/slideMaster1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${emptyTree}</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`);
  zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", relationships(`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>`));
  zip.file("ppt/slideLayouts/slideLayout1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank">${emptyTree}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels", relationships(`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>`));
  const fillStyle = `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>`;
  const lineStyle = `<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  const effectStyle = `<a:effectStyle><a:effectLst/></a:effectStyle>`;
  zip.file("ppt/theme/theme1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="InsightForge"><a:themeElements><a:clrScheme name="InsightForge"><a:dk1><a:srgbClr val="122033"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="566579"/></a:dk2><a:lt2><a:srgbClr val="EEF4F7"/></a:lt2><a:accent1><a:srgbClr val="22C3A6"/></a:accent1><a:accent2><a:srgbClr val="F5B942"/></a:accent2><a:accent3><a:srgbClr val="E85D75"/></a:accent3><a:accent4><a:srgbClr val="4D7CFE"/></a:accent4><a:accent5><a:srgbClr val="566579"/></a:accent5><a:accent6><a:srgbClr val="D8E1E7"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Aptos"><a:majorFont><a:latin typeface="Aptos Display"/><a:ea typeface="Aptos Display"/><a:cs typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/><a:ea typeface="Aptos"/><a:cs typeface="Aptos"/></a:minorFont></a:fontScheme><a:fmtScheme name="InsightForge"><a:fillStyleLst>${fillStyle}${fillStyle}${fillStyle}</a:fillStyleLst><a:lnStyleLst>${lineStyle}${lineStyle}${lineStyle}</a:lnStyleLst><a:effectStyleLst>${effectStyle}${effectStyle}${effectStyle}</a:effectStyleLst><a:bgFillStyleLst>${fillStyle}${fillStyle}${fillStyle}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:extraClrSchemeLst/></a:theme>`);
  slides.forEach((slide, index) => {
    zip.file(`ppt/slides/slide${index + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${slide.background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${slide.shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    zip.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`, relationships(`<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`));
  });
  const now = new Date().toISOString();
  zip.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(run.researchQuestion)}</dc:title><dc:subject>Evidence-native industry research</dc:subject><dc:creator>InsightForge</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  zip.file("docProps/app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>InsightForge</Application><PresentationFormat>On-screen Show (16:9)</PresentationFormat><Slides>5</Slides><Company>InsightForge</Company><AppVersion>1.0</AppVersion></Properties>`);
}

export async function writePptx(run: ResearchRun, filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const zip = new JSZip();
  packagePresentation(zip, buildSlides(run), run);
  await writeFile(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } }));
}
