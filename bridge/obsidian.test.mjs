// bridge/obsidian.mjs 的独立单元测试（纯 Node.js，无第三方依赖）。
// 运行：node bridge/obsidian.test.mjs
// 也可在项目根目录直接跑，相对导入 ./obsidian.mjs 不受工作目录影响。

import assert from "node:assert/strict";
import { upsertArchive, buildSkeleton } from "./obsidian.mjs";

let passed = 0, failed = 0;
async function test(name, fn) { try { await fn(); console.log(`  ✅ ${name}`); passed++; } catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); failed++; } }

/** 统计子串出现次数（用于断言标记对只有一对、没有重复条目）。 */
function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

const P = (key, title, markdown) => ({ key, title, markdown });
const S = (key, title, markdown) => ({ key, title, markdown });

console.log("obsidian.mjs 单元测试\n");

// 1. 空文档 → 生成骨架
await test("1. 空文档生成骨架，包含两个二级标题", () => {
  const out = upsertArchive("", { problem: null, syntax: [] });
  assert.equal(out, buildSkeleton());
  assert.ok(out.includes("# LeetCode Hot 100 归档"), "应有一级标题");
  assert.ok(out.includes("## 一、题目归档"), "应有题目归档标题");
  assert.ok(out.includes("## 二、语法归档"), "应有语法归档标题");
  // 纯空白也视作空文档
  assert.equal(upsertArchive("   \n\n  ", { problem: null, syntax: [] }), buildSkeleton());
});

// 2. 单个 problem → 出现在题目区
await test("2. 单个 problem 落在「题目归档」与「语法归档」之间", () => {
  const doc = upsertArchive("", {
    problem: P("LC 3", "无重复字符的最长子串",
      "### LC 3 · 无重复字符的最长子串\n- **题型**：滑动窗口\n- **易错点**：左指针收缩时机"),
    syntax: [],
  });
  const iProb = doc.indexOf("## 一、题目归档");
  const iBody = doc.indexOf("### LC 3 · 无重复字符的最长子串");
  const iSyn = doc.indexOf("## 二、语法归档");
  assert.ok(iProb >= 0 && iSyn > iProb, "两个区域标题应存在且顺序正确");
  assert.ok(iBody > iProb, "题目正文应在题目区标题之后");
  assert.ok(iBody < iSyn, "题目正文应在语法区标题之前");
  assert.equal(count(doc, "<!-- lc-coach:problem:LC 3 -->"), 1);
  assert.equal(count(doc, "<!-- /lc-coach:problem:LC 3 -->"), 1);
  assert.ok(doc.includes("滑动窗口"));
});

// 3. 单个 syntax → 出现在语法区
await test("3. 单条 syntax 落在「语法归档」之后", () => {
  const doc = upsertArchive("", {
    problem: null,
    syntax: [S("cpp-unordered_map-iteration", "unordered_map 遍历",
      "### 语法 · unordered_map 遍历\n- **易忘点**：it->first 不是 it.first\n")],
  });
  const iSyn = doc.indexOf("## 二、语法归档");
  const iBody = doc.indexOf("### 语法 · unordered_map 遍历");
  assert.ok(iSyn >= 0 && iBody > iSyn, "语法正文应在语法区标题之后");
  assert.equal(count(doc, "<!-- lc-coach:syntax:cpp-unordered_map-iteration -->"), 1);
  assert.equal(count(doc, "<!-- /lc-coach:syntax:cpp-unordered_map-iteration -->"), 1);
});

// 4. 同 key 再写一次 → 替换而非重复
await test("4. 相同 key 再次写入是原地替换，不产生重复条目", () => {
  const first = upsertArchive("", {
    problem: P("LC 3", "无重复字符的最长子串", "### LC 3 · 无重复字符的最长子串\n- **题型**：滑动窗口（旧）"),
    syntax: [],
  });
  const second = upsertArchive(first, {
    problem: P("LC 3", "无重复字符的最长子串", "### LC 3 · 无重复字符的最长子串\n- **题型**：滑动窗口（新）"),
    syntax: [],
  });
  assert.equal(count(second, "<!-- lc-coach:problem:LC 3 -->"), 1, "开标记应只有一对");
  assert.equal(count(second, "<!-- /lc-coach:problem:LC 3 -->"), 1, "闭标记应只有一对");
  assert.equal(count(second, "### LC 3 · 无重复字符的最长子串"), 1, "标题不应重复");
  assert.ok(second.includes("滑动窗口（新）"), "应写入新内容");
  assert.ok(!second.includes("滑动窗口（旧）"), "旧内容应被替换掉");
  // 位置不变：仍夹在两个区域标题之间
  assert.ok(second.indexOf("### LC 3") > second.indexOf("## 一、题目归档"));
  assert.ok(second.indexOf("### LC 3") < second.indexOf("## 二、语法归档"));
});

// 5. 两个不同 problem → 都保留且在题目区
await test("5. 两个不同 problem 都保留，且都在题目区", () => {
  let doc = upsertArchive("", {
    problem: P("LC 3", "无重复字符的最长子串", "### LC 3 · 无重复字符的最长子串\n- **题型**：滑动窗口"),
    syntax: [],
  });
  doc = upsertArchive(doc, {
    problem: P("LC 5", "最长回文子串", "### LC 5 · 最长回文子串\n- **题型**：中心扩散"),
    syntax: [],
  });
  const iProb = doc.indexOf("## 一、题目归档");
  const iSyn = doc.indexOf("## 二、语法归档");
  for (const t of ["### LC 3 · 无重复字符的最长子串", "### LC 5 · 最长回文子串"]) {
    const at = doc.indexOf(t);
    assert.ok(at > iProb && at < iSyn, `${t} 应在题目区内`);
  }
  assert.equal(count(doc, "<!-- lc-coach:problem:LC 3 -->"), 1);
  assert.equal(count(doc, "<!-- lc-coach:problem:LC 5 -->"), 1);
});

// 6. problem 与 syntax 混合 → 各归各位
await test("6. problem 与 syntax 混合写入时各归各位", () => {
  const doc = upsertArchive("", {
    problem: P("LC 11", "盛最多水的容器", "### LC 11 · 盛最多水的容器\n- **题型**：双指针"),
    syntax: [
      S("py-slice", "Python 切片", "### 语法 · Python 切片\n- **易忘点**：a[::-1] 反转"),
      S("cpp-pair", "C++ pair", "### 语法 · C++ pair\n- **易忘点**：.first / .second"),
    ],
  });
  const iProb = doc.indexOf("## 一、题目归档");
  const iSyn = doc.indexOf("## 二、语法归档");
  assert.ok(iProb < iSyn, "题目区应在语法区之前");
  assert.ok(doc.indexOf("### LC 11") > iProb && doc.indexOf("### LC 11") < iSyn, "题目应在题目区");
  for (const t of ["### 语法 · Python 切片", "### 语法 · C++ pair"]) {
    assert.ok(doc.indexOf(t) > iSyn, `${t} 应在语法区内`);
  }
  assert.equal(count(doc, "<!-- lc-coach:problem:LC 11 -->"), 1);
  assert.equal(count(doc, "<!-- lc-coach:syntax:py-slice -->"), 1);
  assert.equal(count(doc, "<!-- lc-coach:syntax:cpp-pair -->"), 1);
});

// 7. 幂等性
await test("7. 同输入连续调用两次结果完全相同（幂等）", () => {
  const base = [
    "# 我的 LeetCode 笔记",
    "",
    "一些自发记录的内容。",
    "",
    "## 一、题目归档",
    "",
    "<!-- lc-coach:problem:LC 1 -->",
    "### LC 1 · 两数之和",
    "- **题型**：哈希表",
    "<!-- /lc-coach:problem:LC 1 -->",
    "",
    "## 二、语法归档",
    "",
  ].join("\n");

  const sections = {
    problem: P("LC 3", "无重复字符的最长子串", "### LC 3 · 无重复字符的最长子串\n- **题型**：滑动窗口"),
    syntax: [S("cpp-unordered_map-iteration", "unordered_map 遍历", "### 语法 · unordered_map 遍历\n- **易忘点**：迭代器解引用")],
  };
  const once = upsertArchive(base, sections);
  const twice = upsertArchive(once, sections);
  assert.equal(twice, once, "第二次调用应与第一次完全一致");

  // 空文档路径也要幂等
  const e1 = upsertArchive("", sections);
  const e2 = upsertArchive(e1, sections);
  assert.equal(e2, e1);
});

// 8. 特殊字符 key
await test("8. key 含空格与特殊字符（LC 3 / C++ vector / a.b(c)+d）可正确匹配替换", () => {
  const first = upsertArchive("", {
    problem: P("C++ vector", "C++ vector", "### C++ vector · 旧内容"),
    syntax: [
      S("a.b(c)+d", "特殊字符 key", "### 语法 · a.b(c)+d 旧内容"),
      S("LC 3", "带空格 key", "### 语法 · LC 3 旧内容"),
    ],
  });
  const second = upsertArchive(first, {
    problem: P("C++ vector", "C++ vector", "### C++ vector · 新内容"),
    syntax: [
      S("a.b(c)+d", "特殊字符 key", "### 语法 · a.b(c)+d 新内容"),
      S("LC 3", "带空格 key", "### 语法 · LC 3 新内容"),
    ],
  });

  assert.equal(count(second, "<!-- lc-coach:problem:C++ vector -->"), 1);
  assert.equal(count(second, "<!-- /lc-coach:problem:C++ vector -->"), 1);
  assert.equal(count(second, "<!-- lc-coach:syntax:a.b(c)+d -->"), 1);
  assert.equal(count(second, "<!-- /lc-coach:syntax:a.b(c)+d -->"), 1);
  assert.equal(count(second, "<!-- lc-coach:syntax:LC 3 -->"), 1);
  assert.equal(count(second, "<!-- /lc-coach:syntax:LC 3 -->"), 1);

  assert.ok(second.includes("C++ vector · 新内容") && !second.includes("C++ vector · 旧内容"));
  assert.ok(second.includes("a.b(c)+d 新内容") && !second.includes("a.b(c)+d 旧内容"));
  assert.ok(second.includes("LC 3 新内容") && !second.includes("LC 3 旧内容"));
});

// 9. 用户自己写的内容不丢
await test("9. 文档中用户自写的普通段落调用后仍在", () => {
  const base = [
    "# 我自己的 LeetCode 笔记",
    "",
    "这里是我手写的学习计划：先刷滑动窗口，再刷动态规划。",
    "",
    "## 一、题目归档",
    "",
    "### 手写条目（不属于 LC Coach）",
    "- 自己的心得：先想暴力解。",
    "",
    "## 二、语法归档",
    "",
    "- 手动记的语法点：`std::sort(v.begin(), v.end())`",
    "",
    "> 结尾处我自己的备注。",
    "",
  ].join("\n");

  const out = upsertArchive(base, {
    problem: P("LC 42", "接雨水", "### LC 42 · 接雨水\n- **题型**：单调栈"),
    syntax: [S("cpp-sort", "C++ sort", "### 语法 · C++ sort\n- **易忘点**：左闭右开")],
  });

  for (const keep of [
    "# 我自己的 LeetCode 笔记",
    "这里是我手写的学习计划：先刷滑动窗口，再刷动态规划。",
    "### 手写条目（不属于 LC Coach）",
    "- 自己的心得：先想暴力解。",
    "- 手动记的语法点：`std::sort(v.begin(), v.end())`",
    "> 结尾处我自己的备注。",
  ]) {
    assert.ok(out.includes(keep), `原有内容不应丢失：${keep}`);
  }
  assert.ok(out.includes("### LC 42 · 接雨水"));
  assert.ok(out.includes("### 语法 · C++ sort"));
  // 新条目应插在各自区域末尾、下一个二级标题之前
  assert.ok(out.indexOf("### LC 42 · 接雨水") > out.indexOf("## 一、题目归档"));
  assert.ok(out.indexOf("### LC 42 · 接雨水") < out.indexOf("## 二、语法归档"));
  assert.ok(out.indexOf("### 语法 · C++ sort") > out.indexOf("## 二、语法归档"));
});

// 10. 空 sections → 不崩、内容基本不变
await test("10. problem:null 且 syntax:[] 时不崩、内容基本不变，空 markdown 条目被跳过", () => {
  const base = "# LeetCode Hot 100 归档\n\n原有一些文字。\n";
  const out = upsertArchive(base, { problem: null, syntax: [] });
  assert.ok(out.includes("原有一些文字。"), "原有内容应保留");
  assert.ok(out.includes("## 一、题目归档") && out.includes("## 二、语法归档"), "允许补齐骨架标题");

  // 空 markdown / 空 key 的条目应被跳过，不产生空标记对
  const out2 = upsertArchive(out, {
    problem: P("LC 99", "空内容", ""),
    syntax: [S("k-empty-md", "空 markdown", "   \n  "), S("", "空 key", "### 语法 · 空 key")],
  });
  assert.equal(count(out2, "lc-coach:problem:LC 99"), 0, "空 markdown 的题目应跳过");
  assert.equal(count(out2, "lc-coach:syntax:k-empty-md"), 0, "空 markdown 的语法应跳过");
  assert.equal(count(out2, "lc-coach:syntax:"), 0, "空 key 应跳过");
  assert.ok(out2.includes("原有一些文字。"));

  // 极端入参也不应抛异常
  assert.doesNotThrow(() => upsertArchive(undefined, undefined));
  assert.doesNotThrow(() => upsertArchive(null, { problem: {}, syntax: null }));
  assert.equal(typeof upsertArchive(undefined, undefined), "string");
});

// 11. 缺「语法归档」标题 → 补上且原有内容不丢
await test("11. 缺「语法归档」标题时补上，原有内容不丢", () => {
  const base = [
    "# LeetCode Hot 100 归档",
    "",
    "> 由 LC Coach 自动生成。每个条目都被注释标记包裹，请勿手动删除标记。",
    "",
    "## 一、题目归档",
    "",
    "<!-- lc-coach:problem:LC 1 -->",
    "### LC 1 · 两数之和",
    "- **题型**：哈希表",
    "<!-- /lc-coach:problem:LC 1 -->",
    "",
  ].join("\n");

  const out = upsertArchive(base, {
    problem: P("LC 1", "两数之和", "### LC 1 · 两数之和\n- **题型**：哈希表"),
    syntax: [S("cpp-map", "C++ map", "### 语法 · C++ map\n- **易忘点**：`m.count(k)` 返回 0/1")],
  });

  assert.ok(out.includes("## 二、语法归档"), "应补上语法归档标题");
  assert.ok(out.includes("## 一、题目归档"), "题目归档标题应保留");
  assert.ok(out.includes("### LC 1 · 两数之和"), "原有题目条目应保留");
  assert.equal(count(out, "### LC 1 · 两数之和"), 1, "原有题目条目不应重复");
  assert.equal(count(out, "<!-- lc-coach:problem:LC 1 -->"), 1);
  assert.ok(out.indexOf("## 二、语法归档") > out.indexOf("### LC 1 · 两数之和"), "语法标题应补在题目内容之后");
  assert.ok(out.indexOf("### 语法 · C++ map") > out.indexOf("## 二、语法归档"), "新语法条目应在语法区内");
});

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
