import raw from "@aef/data/recipe-pack.i18n.json";

export type Locale = "en" | "zh";

export type UiKey =
  | "targets.title"
  | "targets.add"
  | "targets.remove"
  | "targets.rate.unit"
  | "targets.rate.label"
  | "targets.item.choose"
  | "item.selected"
  | "targets.remove.label"
  | "targets.duplicate"
  | "targets.head.sub"
  | "targets.empty"
  | "picker.title"
  | "picker.search.label"
  | "picker.search.placeholder"
  | "picker.group.depth"
  | "picker.group.unranked"
  | "picker.empty"
  | "picker.close.label"
  | "app.loading"
  | "app.error.load"
  | "app.error.edit"
  | "app.error.corrupt"
  | "app.error.reset"
  | "app.error.solver"
  | "app.error.infeasible"
  | "app.error.infeasible.generic"
  | "app.error.producer-unavailable.event"
  | "app.error.dismiss"
  | "app.error.busy"
  | "app.error.crash"
  | "app.locale.label"
  | "inputs.title"
  | "inputs.rate.label"
  | "inputs.rate.unit"
  | "canvas.rate.unit"
  | "inputs.rate.placeholder"
  | "inputs.rate.cap"
  | "inputs.remove"
  | "inputs.remove.label"
  | "inputs.add"
  | "inputs.add.exhausted"
  | "inputs.picker.listed"
  | "inputs.duplicate"
  | "inputs.unlimited"
  | "inputs.needed"
  | "inputs.empty"
  | "env.stable"
  | "env.acidic"
  | "product.dir.in"
  | "product.dir.out"
  | "product.class.raw"
  | "product.class.import"
  | "product.class.tap"
  | "product.tap.share"
  | "product.flavor.target"
  | "product.flavor.surplus"
  | "canvas.controls.panel"
  | "canvas.controls.zoom_in"
  | "canvas.controls.zoom_out"
  | "canvas.controls.fit_view"
  | "canvas.controls.interactive"
  | "rate.invalid"
  | "settings.open.label"
  | "settings.title"
  | "settings.close.label"
  | "settings.events.title"
  | "settings.events.reset"
  | "settings.events.current"
  | "settings.events.past"
  | "settings.events.default"
  | "settings.events.switch.label"
  | "settings.events.counts"
  | "settings.events.showRecipes"
  | "settings.events.hideRecipes"
  | "settings.events.recipe.machine"
  | "settings.events.recipe.inputs"
  | "stats.output"
  | "stats.output.unit"
  | "stats.input"
  | "stats.input.unit"
  | "side.nav.label";

export type I18nIndex = {
  locale: Locale;
  displayName(id: string): string;
  t(key: UiKey, params?: Record<string, string | number>): string;
};

const DEFAULT_LOCALE: Locale = "zh";

const UI_STRINGS: Record<Locale, Record<UiKey, string>> = {
  zh: {
    "targets.title": "目标",
    "targets.add": "添加目标",
    "targets.remove": "删除",
    "targets.rate.unit": "件 / 分钟",
    "targets.rate.label": "速率",
    "targets.item.choose": "选择物品…",
    "item.selected": "物品：{name}",
    "targets.remove.label": "删除目标",
    "targets.duplicate": "物品 ID 重复: {itemId}",
    "targets.head.sub": "// 声明产出速率 · 件 / 分钟",
    "targets.empty": "未声明任何目标产物 — 点击下方按钮添加",
    "picker.title": "选择物品",
    "picker.search.label": "搜索物品",
    "picker.search.placeholder": "按名称或 ID 搜索…",
    "picker.group.depth": "层级 {n}",
    "picker.group.unranked": "循环 / 未分级",
    "picker.empty": "没有匹配的物品",
    "picker.close.label": "关闭",
    "app.loading": "正在加载布局...",
    "app.error.load": "加载方案失败: {message}",
    "app.error.edit": "无法应用此更改: {message}",
    "app.error.corrupt": "此分享链接已损坏，或来自更新版本的规划器。",
    "app.error.reset": "从新方案开始",
    "app.error.solver": "求解器错误: {message}",
    "app.error.infeasible":
      "无可行方案，涉及：{items}。请提高供给上限或降低目标产量。",
    "app.error.infeasible.generic": "当前目标与供给上限下无可行方案。",
    "app.error.producer-unavailable.event":
      "物品 {itemId} 仅由 {cohort} 活动配方生产，该活动当前未开启。",
    "app.error.dismiss": "关闭",
    "app.error.busy": "方案正在加载，请等加载完成后再修改。",
    "app.error.crash": "规划器遇到意外错误，无法绘制当前方案。",
    "app.locale.label": "语言",
    "inputs.title": "输入",
    "inputs.rate.label": "速率",
    "inputs.rate.unit": "/分",
    "canvas.rate.unit": "/分",
    "inputs.rate.placeholder": "上限 / 分",
    "inputs.rate.cap": "上限 {rate}/分",
    "inputs.remove": "移除",
    "inputs.remove.label": "移除输入行",
    "inputs.add": "添加输入",
    "inputs.add.exhausted": "所有物品均已添加",
    "inputs.picker.listed": "灰显的物品已在面板中 — 请直接编辑对应行",
    "inputs.duplicate": "该物品已声明",
    "inputs.unlimited": "无限",
    "inputs.needed": "需求 {rate}/分",
    "inputs.empty": "未配置任何输入 — 全部按 raw 自动求解",
    "env.stable": "稳定环境",
    "env.acidic": "酸性环境",
    "product.dir.in": "输入",
    "product.dir.out": "输出",
    "product.class.raw": "原料",
    "product.class.import": "进口",
    "product.class.tap": "分接",
    "product.tap.share": "共 {rate}/分",
    "product.flavor.target": "目标",
    "product.flavor.surplus": "过剩",
    "canvas.controls.panel": "控制面板",
    "canvas.controls.zoom_in": "放大",
    "canvas.controls.zoom_out": "缩小",
    "canvas.controls.fit_view": "适应视图",
    "canvas.controls.interactive": "切换交互",
    "rate.invalid": "请输入数字，例如 30 或 1/3",
    "settings.open.label": "打开设置",
    "settings.title": "设置",
    "settings.close.label": "关闭",
    "settings.events.title": "活动",
    "settings.events.reset": "恢复默认",
    "settings.events.current": "当前",
    "settings.events.past": "往期",
    "settings.events.default": "默认",
    "settings.events.switch.label": "切换 {cohort} 活动",
    "settings.events.counts": "{items} 个物品 · {recipes} 个配方",
    "settings.events.showRecipes": "显示配方",
    "settings.events.hideRecipes": "隐藏配方",
    "settings.events.recipe.machine": "机器 {machine}",
    "settings.events.recipe.inputs": "输入 {inputs}",
    "stats.output": "输出",
    "stats.output.unit": "目标",
    "stats.input": "输入",
    "stats.input.unit": "供给",
    "side.nav.label": "边界面板分区",
  },
  en: {
    "targets.title": "Targets",
    "targets.add": "Add target",
    "targets.remove": "Remove",
    "targets.rate.unit": "items / minute",
    "targets.rate.label": "rate",
    "targets.item.choose": "Choose an item...",
    "item.selected": "Item: {name}",
    "targets.remove.label": "remove target",
    "targets.duplicate": "Duplicate item id: {itemId}",
    "targets.head.sub": "// declared output rates · items per minute",
    "targets.empty": "No declared outputs yet — use the action below",
    "picker.title": "Select item",
    "picker.search.label": "Search items",
    "picker.search.placeholder": "Search by name or id...",
    "picker.group.depth": "Tier {n}",
    "picker.group.unranked": "Cyclic / unranked",
    "picker.empty": "No items match your search",
    "picker.close.label": "Close",
    "app.loading": "Loading layout...",
    "app.error.load": "Failed to load plan: {message}",
    "app.error.edit": "Cannot apply this change: {message}",
    "app.error.corrupt":
      "This share link is damaged or from a newer version of the planner.",
    "app.error.reset": "Start with a fresh plan",
    "app.error.solver": "Solver error: {message}",
    "app.error.infeasible":
      "No feasible plan involving: {items}. Raise the supply caps or lower the targets.",
    "app.error.infeasible.generic":
      "No feasible plan for the current targets and supply caps.",
    "app.error.producer-unavailable.event":
      "Item {itemId} cannot be a target right now: every recipe producing it is unavailable (the {cohort} event is switched off).",
    "app.error.dismiss": "Dismiss",
    "app.error.busy":
      "A plan is still loading. Try that change again once it lands.",
    "app.error.crash":
      "The planner hit an unexpected error and could not draw this plan.",
    "app.locale.label": "Language",
    "inputs.title": "Inputs",
    "inputs.rate.label": "Rate",
    "inputs.rate.unit": "/min",
    "canvas.rate.unit": "/min",
    "inputs.rate.placeholder": "cap /min",
    "inputs.rate.cap": "cap {rate}/min",
    "inputs.remove": "Remove",
    "inputs.remove.label": "Remove input row",
    "inputs.add": "Add input",
    "inputs.add.exhausted": "All items already have a row",
    "inputs.picker.listed":
      "Dimmed items already have a row in the panel — edit that row instead",
    "inputs.duplicate": "Item already declared",
    "inputs.unlimited": "Unlimited",
    "inputs.needed": "needed {rate}/min",
    "inputs.empty": "No declared inputs — defaults to raw-source feed",
    "env.stable": "Stable environment",
    "env.acidic": "Acidic environment",
    "product.dir.in": "In",
    "product.dir.out": "Out",
    "product.class.raw": "raw",
    "product.class.import": "import",
    "product.class.tap": "tap",
    "product.tap.share": "of {rate}/min",
    "product.flavor.target": "target",
    "product.flavor.surplus": "surplus",
    "canvas.controls.panel": "Control panel",
    "canvas.controls.zoom_in": "Zoom in",
    "canvas.controls.zoom_out": "Zoom out",
    "canvas.controls.fit_view": "Fit view",
    "canvas.controls.interactive": "Toggle interactivity",
    "rate.invalid": "Enter a number, e.g. 30 or 1/3",
    "settings.open.label": "Open settings",
    "settings.title": "Settings",
    "settings.close.label": "Close",
    "settings.events.title": "Events",
    "settings.events.reset": "Reset to defaults",
    "settings.events.current": "current",
    "settings.events.past": "past",
    "settings.events.default": "default",
    "settings.events.switch.label": "Toggle the {cohort} event",
    "settings.events.counts": "{items} items · {recipes} recipes",
    "settings.events.showRecipes": "Show recipes",
    "settings.events.hideRecipes": "Hide recipes",
    "settings.events.recipe.machine": "machine {machine}",
    "settings.events.recipe.inputs": "in {inputs}",
    "stats.output": "Output",
    "stats.output.unit": "targets",
    "stats.input": "Input",
    "stats.input.unit": "supply",
    "side.nav.label": "Boundary panel sections",
  },
};

const cache = new Map<Locale, I18nIndex>();

export function loadI18n(locale: Locale = DEFAULT_LOCALE): I18nIndex {
  const cached = cache.get(locale);
  if (cached) return cached;
  const names = (
    raw as { names: Record<string, Record<string, Record<string, string>>> }
  ).names;
  const map = new Map<string, string>();
  // The sidecar groups names by entity kind within each locale (categories,
  // items, locations, machines, recipes, transports). Flatten every kind into a
  // single id->name lookup. Seed it with English first so that when the chosen
  // locale is missing a translation, the user sees readable English instead of
  // a raw id.
  const primary = names[locale] ?? {};
  const fallback = names.en ?? {};
  for (const kindBucket of Object.values(fallback)) {
    for (const [id, name] of Object.entries(kindBucket)) {
      map.set(id, name);
    }
  }
  for (const kindBucket of Object.values(primary)) {
    for (const [id, name] of Object.entries(kindBucket)) {
      map.set(id, name);
    }
  }
  const uiStrings = UI_STRINGS[locale] ?? UI_STRINGS[DEFAULT_LOCALE];
  const index: I18nIndex = {
    locale,
    displayName(id: string): string {
      return map.get(id) ?? id;
    },
    t(key, params) {
      const template = uiStrings[key];
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (_, name: string) =>
        name in params ? String(params[name]) : `{${name}}`,
      );
    },
  };
  cache.set(locale, index);
  return index;
}
