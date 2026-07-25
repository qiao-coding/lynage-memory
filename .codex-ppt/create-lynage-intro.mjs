import fs from "node:fs/promises";
import path from "node:path";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const ROOT = "D:\\coding\\lynage-memory";
const OUT = path.join(ROOT, "Lynage Memory 项目介绍.pptx");
const RENDER_DIR = path.join(ROOT, ".codex-ppt", "renders");
const LAYOUT_DIR = path.join(ROOT, ".codex-ppt", "layouts");
const W = 1280;
const H = 720;
const C = {
  ink: "#000000",
  muted: "#5B616E",
  panel: "#F2F2F2",
  panel2: "#EAF5FB",
  rule: "#B8BCC4",
  accent: "#3D8DFF",
  accent2: "#6DCBF4",
  white: "#FFFFFF",
};

async function writeBlob(filePath, blob) {
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

function addBox(slide, x, y, w, h, fill = C.panel, line = C.rule) {
  return slide.shapes.add({
    geometry: "roundRect",
    position: { left: x, top: y, width: w, height: h },
    fill,
    line: { style: "solid", fill: line, width: 1 },
    borderRadius: "rounded-xl",
  });
}

function addText(slide, text, x, y, w, h, options = {}) {
  const shape = slide.shapes.add({
    geometry: "textbox",
    position: { left: x, top: y, width: w, height: h },
    fill: "none",
    line: { style: "solid", fill: "none", width: 0 },
  });
  shape.text = text;
  shape.text.style = {
    fontSize: options.size ?? 22,
    bold: options.bold ?? false,
    color: options.color ?? C.ink,
    typeface: options.font ?? "Microsoft YaHei",
    alignment: options.align ?? "left",
    verticalAlignment: options.valign ?? "top",
  };
  return shape;
}

function addTitle(slide, title, index) {
  addText(slide, title, 41, 36, 1040, 86, { size: 48, bold: true });
  addText(slide, String(index).padStart(2, "0"), 1184, 659, 55, 25, {
    size: 18,
    align: "right",
  });
}

function addNotes(slide, sources) {
  slide.speakerNotes.textFrame.setText(
    `[Sources]\n${sources.map((source) => `- ${source}`).join("\n")}`,
  );
}

function slideCover(p) {
  const slide = p.slides.add();
  addText(slide, "Lynage Memory", 41, 43, 560, 58, { size: 32 });
  addText(
    slide,
    "面向长期运行 Agent 的\n上下文谱系记忆模块",
    41,
    190,
    900,
    205,
    { size: 76, bold: true, valign: "bottom" },
  );
  addText(
    slide,
    "Context-lineage memory layer for AI agents\n无损原文 · 代际目录 · 并行检索 · 原文验证",
    41,
    512,
    820,
    110,
    { size: 28, color: C.muted },
  );
  addBox(slide, 1005, 56, 190, 545, C.panel2, C.panel2);
  addText(slide, "Lineage\nMemory", 1030, 412, 150, 86, {
    size: 30,
    bold: true,
    color: C.accent,
  });
  addNotes(slide, ["README.md：项目定位与核心能力", "架构.md：最终定义"]);
}

function slideAgenda(p) {
  const slide = p.slides.add();
  addTitle(slide, "这份介绍回答四个问题", 2);
  const rows = [
    ["01", "Lynage 解决什么 Agent 记忆问题"],
    ["02", "为什么“摘要替代记忆”会失真"],
    ["03", "系统如何保存原文、建立目录并检索"],
    ["04", "当前代码结构、能力状态与下一步价值"],
  ];
  const x = 62;
  let y = 214;
  rows.forEach(([num, label]) => {
    addText(slide, num, x, y + 10, 72, 42, { size: 28, bold: true });
    addText(slide, label, x + 112, y + 10, 940, 42, { size: 28 });
    slide.shapes.add({
      geometry: "straightConnector1",
      position: { left: x, top: y + 69, width: 1135, height: 0 },
      fill: "none",
      line: { style: "solid", fill: C.rule, width: 1 },
    });
    y += 82;
  });
  addNotes(slide, ["README.md：核心问题、整体架构、仓库结构", "架构.md：核心目标与核心原则"]);
}

function slideProblem(p) {
  const slide = p.slides.add();
  addTitle(slide, "传统长对话记忆会把事实压扁", 3);
  addText(
    slide,
    "当 Agent 长期运行，完整对话超过上下文窗口后，常见做法是用摘要替换旧消息。问题不只是“少了细节”，而是原文位置、决策背景和后续修正一起丢失。",
    41,
    134,
    1120,
    86,
    { size: 25, color: C.muted },
  );
  const steps = ["完整对话", "上下文上限", "压缩摘要", "原文丢失", "语义漂移", "孤立事实"];
  steps.forEach((step, i) => {
    const x = 52 + i * 196;
    addBox(slide, x, 320, 150, 92, i >= 3 ? "#FFEFEF" : C.panel);
    addText(slide, step, x + 18, 352, 115, 32, { size: 22, bold: i >= 3 });
    if (i < steps.length - 1) {
      slide.shapes.add({
        geometry: "straightConnector1",
        position: { left: x + 154, top: 366, width: 42, height: 0 },
        fill: "none",
        line: { style: "solid", fill: C.ink, width: 1 },
      });
    }
  });
  addText(slide, "风险：模型拿到的是脱离原文的二手导航，却被迫当成事实本身。", 92, 520, 960, 46, {
    size: 30,
    bold: true,
  });
  addNotes(slide, ["README.md：核心问题", "架构.md：核心目标"]);
}

function slidePositioning(p) {
  const slide = p.slides.add();
  addTitle(slide, "Lynage 是记忆层，不是完整 Agent 框架", 4);
  addText(
    slide,
    "它嵌入现有 Agent Framework，接管上下文谱系、历史归档、检索与原文恢复；模型调用、工具执行和工作流仍由上层框架负责。",
    41,
    124,
    1160,
    72,
    { size: 25, color: C.muted },
  );
  addBox(slide, 67, 275, 395, 244, C.panel2, C.panel2);
  addText(slide, "Lynage 负责", 95, 304, 250, 38, { size: 30, bold: true, color: C.accent });
  addText(slide, "消息保存\n上下文维护\n历史归档与目录索引\n历史检索、原文恢复\nPrompt 上下文编译", 95, 365, 315, 124, { size: 23 });
  addBox(slide, 550, 275, 395, 244, C.panel);
  addText(slide, "不负责", 578, 304, 250, 38, { size: 30, bold: true });
  addText(slide, "模型 Provider\nAgent 调度\nWorkflow 编排\nTool 执行\n聊天 UI 与认证系统", 578, 365, 315, 124, { size: 23 });
  addText(slide, "边界清晰，才方便接入 Vercel AI SDK、MCP 或未来其他 Agent 框架。", 68, 590, 1010, 36, {
    size: 25,
    bold: true,
  });
  addNotes(slide, ["README.md：定位、负责与不负责范围", "架构.md：产品边界"]);
}

function slidePrinciples(p) {
  const slide = p.slides.add();
  addTitle(slide, "设计原则：压缩目录，不压缩事实", 5);
  const items = [
    ["原文是事实来源", "摘要只做导航，最终判断必须回到原始消息。"],
    ["记忆保留谱系", "能恢复信息从哪里来、为什么产生、如何被修正。"],
    ["按时间与容量组织", "目录按时间顺序、节点容量和归档代数自动生长。"],
    ["搜索可验证可继续", "模糊查询能分批推进，并保存搜索进度与候选证据。"],
  ];
  items.forEach(([head, body], i) => {
    const x = i % 2 === 0 ? 72 : 668;
    const y = i < 2 ? 190 : 430;
    addText(slide, head, x, y, 440, 36, { size: 30, bold: true });
    addText(slide, body, x, y + 56, 430, 82, { size: 24, color: C.muted });
    slide.shapes.add({
      geometry: "straightConnector1",
      position: { left: x, top: y + 42, width: 430, height: 0 },
      fill: "none",
      line: { style: "solid", fill: C.rule, width: 1 },
    });
  });
  addNotes(slide, ["README.md：核心原则", "架构.md：核心原则"]);
}

function slideArchitecture(p) {
  const slide = p.slides.add();
  addTitle(slide, "核心架构围绕“存、编、找、验”展开", 6);
  const y = 166;
  const cols = [
    ["Agent Framework", "Model / Tools / Workflow\nLynage Adapter"],
    ["Memory Core", "Source Store\nArchive Manager\nDirectory Indexer\nHistory Retriever\nSource Verifier\nContext Compiler"],
    ["Storage", "messages\ncontext_chunks\ndirectories\nsearch_tasks\nworking_memory"],
  ];
  cols.forEach(([head, body], i) => {
    const x = 62 + i * 408;
    addBox(slide, x, y, 320, 360, i === 1 ? C.panel2 : C.panel);
    addText(slide, head, x + 28, y + 30, 260, 42, { size: 30, bold: true, color: i === 1 ? C.accent : C.ink });
    addText(slide, body, x + 28, y + 100, 260, 210, { size: 24 });
    if (i < 2) {
      slide.shapes.add({
        geometry: "straightConnector1",
        position: { left: x + 322, top: y + 180, width: 84, height: 0 },
        fill: "none",
        line: { style: "solid", fill: C.ink, width: 2 },
      });
    }
  });
  addText(slide, "记忆层不是把全部历史塞回模型，而是在需要时编译出合适的上下文视图。", 72, 590, 1040, 36, {
    size: 25,
    bold: true,
  });
  addNotes(slide, ["README.md：整体架构", "架构.md：整体架构、Context Compiler"]);
}

function slideTurnFlow(p) {
  const slide = p.slides.add();
  addTitle(slide, "一轮对话会同时留下原文和可导航目录", 7);
  const steps = [
    ["startTurn", "保存用户消息\n编译当前上下文"],
    ["streamText", "上层模型生成\nAgent 工具可用"],
    ["finishTurn", "保存助手与工具消息\n检查归档阈值"],
    ["Archive", "寻找自然边界\n生成 Context Chunk"],
    ["Compactor", "加入 G0 目录\n必要时 G0→G1→G2"],
  ];
  steps.forEach(([head, body], i) => {
    const x = 48 + i * 238;
    addText(slide, head, x, 262, 180, 36, { size: 27, bold: true });
    addText(slide, body, x, 324, 184, 96, { size: 21, color: C.muted });
    slide.shapes.add({
      geometry: "ellipse",
      position: { left: x + 4, top: 207, width: 18, height: 18 },
      fill: C.ink,
      line: { style: "solid", fill: C.ink, width: 1 },
    });
    if (i < steps.length - 1) {
      slide.shapes.add({
        geometry: "straightConnector1",
        position: { left: x + 20, top: 216, width: 220, height: 0 },
        fill: "none",
        line: { style: "solid", fill: C.ink, width: 1 },
      });
    }
  });
  addText(slide, "关键点：切分要避开问答中间、Tool Call/Result 中间和未完成决策过程。", 78, 538, 1040, 42, {
    size: 28,
    bold: true,
  });
  addNotes(slide, ["README.md：数据流：一轮对话", "架构.md：Context Chunk"]);
}

function slideRetrieval(p) {
  const slide = p.slides.add();
  addTitle(slide, "历史检索先定位，再回原文验证", 8);
  addText(
    slide,
    "目录摘要负责缩小搜索范围；FTS5 和目录下钻负责找候选；Source Verifier 负责把候选重新拉回原始消息与相邻上下文。",
    41,
    124,
    1110,
    74,
    { size: 25, color: C.muted },
  );
  const rows = [
    ["用户问题", "例如：之前为什么放弃语义分类？"],
    ["目录下钻", "Root → Directory → Context Chunk"],
    ["候选证据", "FTS5 命中 + 目录路径 + sourceRange"],
    ["原文验证", "读取前后消息，重建信息演变链"],
  ];
  rows.forEach(([left, right], i) => {
    const y = 255 + i * 78;
    addText(slide, left, 92, y, 180, 36, { size: 27, bold: true });
    addText(slide, right, 336, y, 720, 36, { size: 25 });
    slide.shapes.add({
      geometry: "straightConnector1",
      position: { left: 82, top: y + 52, width: 1030, height: 0 },
      fill: "none",
      line: { style: "solid", fill: C.rule, width: 1 },
    });
  });
  addNotes(slide, ["README.md：数据流：历史检索", "架构.md：普通检索流程、主进程验证"]);
}

function slideParallel(p) {
  const slide = p.slides.add();
  addTitle(slide, "共享上下文并行搜索让长历史可扩展", 9);
  addBox(slide, 58, 188, 300, 310, C.panel2, C.panel2);
  addText(slide, "ProjectSnapshot", 84, 220, 240, 38, { size: 28, bold: true, color: C.accent });
  addText(slide, "统一目标\n当前进度\n已知决策\n同一个问题\n搜索判断标准", 84, 290, 230, 150, { size: 23 });
  ["Worker A", "Worker B", "Worker C"].forEach((worker, i) => {
    const x = 470 + i * 240;
    addBox(slide, x, 204, 180, 210, C.panel);
    addText(slide, worker, x + 26, 238, 130, 32, { size: 25, bold: true });
    addText(slide, "读取不同\n历史分片\n只返回证据位置", x + 26, 305, 130, 78, { size: 21, color: C.muted });
    slide.shapes.add({
      geometry: "straightConnector1",
      position: { left: 360, top: 300, width: x - 360, height: 0 },
      fill: "none",
      line: { style: "solid", fill: C.ink, width: 1 },
    });
  });
  addText(slide, "主进程合并候选 → 去重排序 → 批量原文验证 → 输出最终结论", 96, 566, 1000, 42, {
    size: 30,
    bold: true,
  });
  addNotes(slide, ["README.md：数据流：并行搜索", "架构.md：Shared-Context Parallel Memory"]);
}

function slideRepo(p) {
  const slide = p.slides.add();
  addTitle(slide, "代码拆成 Core、存储、适配器和 MCP 四层", 10);
  const cols = [
    ["@lynage/core", "记忆生命周期、归档、检索、验证、上下文编译"],
    ["@lynage/storage-sqlite", "Drizzle schema、SQLite/WAL/FTS5 持久化"],
    ["@lynage/ai-sdk", "lynageStreamText 与 5 个 Agent 工具"],
    ["@lynage/mcp", "6 个 MCP 工具，供外部客户端读取与提交记忆"],
  ];
  cols.forEach(([head, body], i) => {
    const x = 52 + i * 300;
    addText(slide, head, x, 225, 250, 34, { size: 25, bold: true });
    addText(slide, body, x, 294, 236, 116, { size: 21, color: C.muted });
  });
  addText(slide, "技术栈：TypeScript · pnpm · SQLite/WAL/FTS5 · Drizzle · Zod · Vercel AI SDK v4 · Vitest", 70, 546, 1020, 40, {
    size: 25,
    bold: true,
  });
  addNotes(slide, ["README.md：仓库结构、Agent 工具、MCP 工具、技术栈", "package.json：脚本与依赖"]);
}

function slideStatus(p) {
  const slide = p.slides.add();
  addTitle(slide, "当前实现已覆盖从归档到并行检索的主链路", 11);
  slide.charts.add("bar", {
    position: { left: 78, top: 200, width: 560, height: 310 },
    categories: ["Lynage", "Summary", "NoMemory"],
    series: [{ name: "Benchmark", values: [100, 80, 0], fill: C.accent }],
    hasLegend: false,
    dataLabels: { showValue: true, position: "outEnd" },
    yAxis: { min: 0, max: 100, majorUnit: 25, majorGridlines: { style: "solid", fill: "#E0E0E0", width: 1 } },
  });
  addText(slide, "已完成阶段", 720, 200, 240, 34, { size: 28, bold: true });
  addText(
    slide,
    "M0–M7：基线、Turn、归档、原文恢复、Benchmark、代际目录、模糊搜索、MCP Server\nP0–P2/M8：User Memory、Source Verifier、Context Compiler、Shared-Context Parallel Memory",
    720,
    260,
    440,
    158,
    { size: 22, color: C.muted },
  );
  addText(slide, "README 记录：22/22 测试，架构覆盖 100%。", 720, 470, 420, 38, { size: 24, bold: true });
  addNotes(slide, ["README.md：开发阶段、快速开始、Benchmark 指标与测试状态"]);
}

function slideClose(p) {
  const slide = p.slides.add();
  addText(slide, "结论", 41, 43, 180, 58, { size: 32 });
  addText(
    slide,
    "Lynage 让有限上下文模型\n持续访问并验证任意规模的历史",
    41,
    188,
    1030,
    220,
    { size: 70, bold: true },
  );
  addText(
    slide,
    "它不把摘要当记忆，而把摘要降级为导航；真正的事实始终留在可恢复、可验证、可追溯的原文中。",
    41,
    526,
    1130,
    82,
    { size: 28, color: C.muted },
  );
  addNotes(slide, ["架构.md：最终定义与核心价值", "README.md：核心原则"]);
}

async function main() {
  await fs.mkdir(RENDER_DIR, { recursive: true });
  await fs.mkdir(LAYOUT_DIR, { recursive: true });
  const p = Presentation.create({ slideSize: { width: W, height: H } });
  [
    slideCover,
    slideAgenda,
    slideProblem,
    slidePositioning,
    slidePrinciples,
    slideArchitecture,
    slideTurnFlow,
    slideRetrieval,
    slideParallel,
    slideRepo,
    slideStatus,
    slideClose,
  ].forEach((build) => build(p));

  for (const [index, slide] of p.slides.items.entries()) {
    const num = String(index + 1).padStart(2, "0");
    await writeBlob(path.join(RENDER_DIR, `slide-${num}.png`), await p.export({ slide, format: "png", scale: 1 }));
    await fs.writeFile(path.join(LAYOUT_DIR, `slide-${num}.layout.json`), await (await slide.export({ format: "layout" })).text());
  }
  await writeBlob(path.join(RENDER_DIR, "montage.webp"), await p.export({ format: "webp", montage: true, scale: 1 }));
  const pptx = await PresentationFile.exportPptx(p);
  await pptx.save(OUT);
  console.log(OUT);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
