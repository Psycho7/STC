import raw from "@aef/data/recipe-pack.i18n.json";

export type Locale = "en" | "zh";

export type UiKey =
  | "targets.title"
  | "targets.add"
  | "targets.rate.unit"
  | "targets.rate.forItem"
  | "item.selected"
  | "targets.remove.forItem"
  | "targets.duplicate"
  | "targets.head.sub"
  | "targets.empty"
  | "targets.picker.listed"
  | "picker.title"
  | "picker.search.label"
  | "picker.search.placeholder"
  | "picker.group.depth"
  | "picker.group.unranked"
  | "picker.empty"
  | "picker.close.label"
  | "picker.event.off"
  | "picker.area.off"
  | "picker.manual.off"
  | "app.loading"
  | "app.error.load"
  | "app.error.edit"
  | "app.error.corrupt"
  | "app.error.reset"
  | "app.error.solver"
  | "app.error.infeasible"
  | "app.error.infeasible.generic"
  | "app.error.infeasible.targets"
  | "app.error.producer-unavailable.event"
  | "app.error.producer-unavailable.area"
  | "app.error.blocked.settings"
  | "app.error.dismiss"
  | "app.error.busy"
  | "app.error.crash"
  | "app.shortfall.unmet"
  | "app.shortfall.cause.area"
  | "app.shortfall.cause.event"
  | "app.shortfall.cause.manual"
  | "app.shortfall.cause.cap"
  | "app.locale.label"
  | "app.status.ready"
  | "app.status.shortfall"
  | "app.status.error"
  | "app.status.solving"
  | "app.settings.event.on"
  | "app.settings.event.off"
  | "inputs.title"
  | "inputs.rate.label"
  | "inputs.rate.forItem"
  | "inputs.rate.unit"
  | "canvas.rate.unit"
  | "canvas.catalyst.perMachine"
  | "inputs.rate.placeholder"
  | "inputs.remove.forItem"
  | "inputs.pool.general"
  | "inputs.pool.catalyst"
  | "inputs.add"
  | "inputs.add.exhausted"
  | "inputs.picker.listed"
  | "inputs.duplicate"
  | "inputs.unlimited"
  | "inputs.needed"
  | "inputs.empty"
  | "inputs.catalyst.role"
  | "inputs.catalyst.role.forItem"
  | "inputs.catalyst.badge"
  | "inputs.catalyst.part"
  | "env.stable"
  | "env.acidic"
  | "product.dir.in"
  | "product.dir.out"
  | "product.class.raw"
  | "product.class.import"
  | "product.class.tap"
  | "product.class.catalyst"
  | "product.catalyst.fromCatalyst"
  | "product.catalyst.fromGeneral"
  | "product.catalyst.short"
  | "product.tap.share"
  | "product.flavor.target"
  | "product.flavor.surplus"
  | "canvas.controls.panel"
  | "canvas.controls.zoom_in"
  | "canvas.controls.zoom_out"
  | "canvas.controls.fit_view"
  | "canvas.controls.interactive"
  | "canvas.empty.hint"
  | "rate.invalid"
  | "rate.zero"
  | "rate.negative"
  | "rate.tooLarge"
  | "rate.reverted"
  | "rate.revertedReason"
  | "ratePrompt.title"
  | "ratePrompt.confirm"
  | "ratePrompt.cancel"
  | "ratePrompt.noLimit"
  | "export.png.label"
  | "settings.open.label"
  | "settings.title"
  | "settings.close.label"
  | "settings.locale.title"
  | "settings.area.title"
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
    "targets.rate.unit": "/分",
    // Row controls name their item: a rail of identically named fields and X
    // buttons tells a screen-reader user nothing about which row they are on.
    "targets.rate.forItem": "{name} 的速率",
    "item.selected": "物品：{name}",
    "targets.remove.forItem": "删除目标 {name}",
    "targets.duplicate": "物品 ID 重复: {itemId}",
    "targets.head.sub": "// 声明产出速率 · /分",
    "targets.empty": "未声明任何目标产物 — 点击下方按钮添加",
    "targets.picker.listed": "灰显的物品已是目标 — 请直接编辑对应行",
    "picker.title": "选择物品",
    "picker.search.label": "搜索物品",
    "picker.search.placeholder": "按名称或 ID 搜索…",
    "picker.group.depth": "层级 {n}",
    "picker.group.unranked": "循环 / 未分级",
    "picker.empty": "没有匹配的物品",
    "picker.close.label": "关闭",
    // {cohorts} is the raw cohort tokens ("v1.2 · v1.5") the validation error
    // app.error.producer-unavailable.event also interpolates: the two surfaces
    // must name a cohort identically in every locale.
    "picker.event.off":
      "灰显的物品来自未开启的活动（{cohorts}）— 可在设置中开启",
    // The area and manual sentences carry no parameter: one dimmed tile may
    // stand for several recipes, so the hint names the setting to open rather
    // than a single area or recipe.
    "picker.area.off": "灰显的物品无法在当前区域生产 — 可在设置中切换区域",
    "picker.manual.off": "灰显的物品的配方已被关闭 — 可在设置中重新开启",
    "app.loading": "正在加载布局...",
    "app.error.load": "加载方案失败: {message}",
    "app.error.edit": "无法应用此更改: {message}",
    "app.error.corrupt": "此分享链接已损坏，或来自更新版本的规划器。",
    "app.error.reset": "从新方案开始",
    "app.error.solver": "求解器错误: {message}",
    "app.error.infeasible":
      "无可行方案，涉及：{items}。请提高供给上限或降低目标产量。",
    "app.error.infeasible.generic": "当前目标与供给上限下无可行方案。",
    "app.error.infeasible.targets":
      "无可行方案，涉及：{items}。请降低目标产量。",
    "app.error.producer-unavailable.event":
      "物品 {item} 仅由 {cohort} 活动配方生产，该活动当前未开启。",
    // {area} is the localized settlement name, the same string the settings
    // panel's area option carries, so the banner and the control agree.
    "app.error.producer-unavailable.area":
      "物品 {item} 的配方均无法在{area}建造。",
    // Closes the banner of a plan adopted with blocked targets: the header
    // gear is the way out that keeps the plan.
    "app.error.blocked.settings": "可在设置中更改区域或活动。",
    "app.error.dismiss": "关闭",
    "app.error.busy": "方案正在加载，请等加载完成后再修改。",
    "app.error.crash": "规划器遇到意外错误，无法绘制当前方案。",
    // The shortfall strip: a neutral lead that only states what is unmet, plus
    // one sentence per explanation the evidence actually supports. None of them
    // may blame a supply cap on its own - see src/data/shortfall.ts.
    "app.shortfall.unmet": "以下产物需求未满足：{items}。",
    "app.shortfall.cause.area": "{items} 的配方均无法在{area}建造。",
    "app.shortfall.cause.event": "{items} 的配方均属于未开启的 {cohort} 活动。",
    "app.shortfall.cause.manual": "{items} 的配方均已在设置中关闭。",
    "app.shortfall.cause.cap": "{items} 的供给已用满所设上限。",
    "app.locale.label": "语言",
    "app.status.ready": "就绪",
    "app.status.shortfall": "产量不足",
    "app.status.error": "错误",
    "app.status.solving": "求解中",
    // The header's non-default settings indicator: one part per event cohort
    // whose effective state departs from its default rule.
    "app.settings.event.on": "{cohort} 活动已开启",
    "app.settings.event.off": "{cohort} 活动已关闭",
    "inputs.title": "输入",
    "inputs.rate.label": "速率",
    // An item can hold a row in both supply pools, so an input row's controls
    // name the pool as well as the item.
    "inputs.rate.forItem": "{name} 的{pool}速率",
    "inputs.rate.unit": "/分",
    "canvas.rate.unit": "/分",
    "canvas.catalyst.perMachine": "每台 {rate}/分",
    "inputs.rate.placeholder": "上限 / 分",
    "inputs.remove.forItem": "移除 {name} 的{pool}输入行",
    "inputs.pool.general": "普通",
    "inputs.pool.catalyst": "催化",
    "inputs.add": "添加输入",
    "inputs.add.exhausted": "所有物品均已添加",
    "inputs.picker.listed": "灰显的物品已在面板中 — 请直接编辑对应行",
    "inputs.duplicate": "该物品已声明",
    "inputs.unlimited": "无限",
    "inputs.needed": "需求 {rate}/分",
    "inputs.empty": "未配置任何输入 — 全部按原料自动求解",
    "inputs.catalyst.role": "催化",
    "inputs.catalyst.role.forItem": "{name} 的{pool}输入行：催化",
    "inputs.catalyst.badge": "催化",
    "inputs.catalyst.part": "其中催化 {rate}/分",
    "env.stable": "稳定环境",
    "env.acidic": "酸性环境",
    "product.dir.in": "输入",
    "product.dir.out": "输出",
    "product.class.raw": "原料",
    "product.class.import": "进口",
    "product.class.tap": "分接",
    "product.class.catalyst": "催化",
    "product.catalyst.fromCatalyst": "来自催化供给 {rate}/分",
    "product.catalyst.fromGeneral": "来自普通供给 {rate}/分",
    "product.catalyst.short": "催化不足 {rate}/分",
    "product.tap.share": "共 {rate}/分",
    "product.flavor.target": "目标",
    "product.flavor.surplus": "过剩",
    "canvas.controls.panel": "控制面板",
    "canvas.controls.zoom_in": "放大",
    "canvas.controls.zoom_out": "缩小",
    "canvas.controls.fit_view": "适应视图",
    "canvas.controls.interactive": "切换交互",
    // {action} is the targets.add button label, so the hint names the button
    // exactly as the side rail draws it.
    "canvas.empty.hint": "尚无目标 · 在左侧点击「{action}」开始规划",
    "rate.invalid": "请输入数字，例如 30 或 1/3",
    "rate.zero": "请输入大于 0 的速率",
    "rate.negative": "速率不能为负数",
    "rate.tooLarge": "速率不能超过 {max}/分",
    // Neutral discard wording: an uncapped or auto row reverts to an EMPTY
    // field, so copy claiming a rate came back would be false there.
    "rate.reverted": "输入无效，已放弃本次输入",
    "rate.revertedReason": "{reason}，已放弃本次输入",
    "ratePrompt.title": "数量",
    "ratePrompt.confirm": "添加",
    "ratePrompt.cancel": "取消",
    "ratePrompt.noLimit": "留空 = 无限",
    "export.png.label": "导出 PNG",
    "settings.open.label": "打开设置",
    "settings.title": "设置",
    "settings.close.label": "关闭",
    "settings.locale.title": "语言",
    "settings.area.title": "区域",
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
    "targets.rate.unit": "/min",
    "targets.rate.forItem": "Rate for {name}",
    "item.selected": "Item: {name}",
    "targets.remove.forItem": "Remove target {name}",
    "targets.duplicate": "Duplicate item id: {itemId}",
    "targets.head.sub": "// declared output rates · /min",
    "targets.empty": "No declared outputs yet — use the action below",
    "targets.picker.listed":
      "Dimmed items are already targets — edit that row instead",
    "picker.title": "Select item",
    "picker.search.label": "Search items",
    "picker.search.placeholder": "Search by name or id...",
    "picker.group.depth": "Tier {n}",
    "picker.group.unranked": "Cyclic / unranked",
    "picker.empty": "No items match your search",
    "picker.close.label": "Close",
    // See the zh entry: {cohorts} carries the same raw tokens the
    // producer-unavailable validation error interpolates.
    "picker.event.off":
      "Dimmed items belong to a switched-off event ({cohorts}) — switch it on in Settings",
    // See the zh entries: neither sentence takes a parameter.
    "picker.area.off":
      "Dimmed items cannot be produced in the selected area — change it in Settings",
    "picker.manual.off":
      "Dimmed items come from switched-off recipes — switch them on in Settings",
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
    "app.error.infeasible.targets":
      "No feasible plan involving: {items}. Lower the targets.",
    "app.error.producer-unavailable.event":
      "Item {item} cannot be a target right now: every recipe producing it is unavailable (the {cohort} event is switched off).",
    "app.error.producer-unavailable.area":
      "Item {item} cannot be a target right now: none of the recipes producing it can be built in {area}.",
    "app.error.blocked.settings": "Change the area or events in Settings.",
    "app.error.dismiss": "Dismiss",
    "app.error.busy":
      "A plan is still loading. Try that change again once it lands.",
    "app.error.crash":
      "The planner hit an unexpected error and could not draw this plan.",
    // See the zh entries: the lead states the shortfall and nothing else. The
    // items can include non-target deficit ids, so no declared rate is claimed.
    "app.shortfall.unmet": "Unmet demand: {items}.",
    "app.shortfall.cause.area":
      "No recipe producing {items} can be built in {area}.",
    "app.shortfall.cause.event":
      "Every recipe producing {items} belongs to the {cohort} event, which is switched off.",
    "app.shortfall.cause.manual":
      "Every recipe producing {items} is switched off in settings.",
    "app.shortfall.cause.cap":
      "The supply of {items} is drawn to its declared cap.",
    "app.locale.label": "Language",
    "app.status.ready": "READY",
    "app.status.shortfall": "SHORTFALL",
    "app.status.error": "ERROR",
    "app.status.solving": "SOLVING",
    "app.settings.event.on": "{cohort} on",
    "app.settings.event.off": "{cohort} off",
    "inputs.title": "Inputs",
    "inputs.rate.label": "Rate",
    "inputs.rate.forItem": "{pool} rate for {name}",
    "inputs.rate.unit": "/min",
    "canvas.rate.unit": "/min",
    "canvas.catalyst.perMachine": "{rate}/min per machine",
    "inputs.rate.placeholder": "cap /min",
    "inputs.remove.forItem": "Remove {pool} input {name}",
    "inputs.pool.general": "General",
    "inputs.pool.catalyst": "Catalyst",
    "inputs.add": "Add input",
    "inputs.add.exhausted": "All items already have a row",
    "inputs.picker.listed":
      "Dimmed items already have a row in the panel — edit that row instead",
    "inputs.duplicate": "Item already declared",
    "inputs.unlimited": "Unlimited",
    "inputs.needed": "needed {rate}/min",
    "inputs.empty": "No declared inputs — defaults to raw-source feed",
    "inputs.catalyst.role": "catalyst",
    "inputs.catalyst.role.forItem": "{pool} input {name}: catalyst",
    "inputs.catalyst.badge": "CATALYST",
    "inputs.catalyst.part": "{rate}/min catalyst",
    "env.stable": "Stable environment",
    "env.acidic": "Acidic environment",
    "product.dir.in": "In",
    "product.dir.out": "Out",
    "product.class.raw": "raw",
    "product.class.import": "import",
    "product.class.tap": "tap",
    "product.class.catalyst": "catalyst",
    "product.catalyst.fromCatalyst": "from catalyst supply {rate}/min",
    "product.catalyst.fromGeneral": "from general supply {rate}/min",
    "product.catalyst.short": "catalyst short by {rate}/min",
    "product.tap.share": "of {rate}/min",
    "product.flavor.target": "target",
    "product.flavor.surplus": "surplus",
    "canvas.controls.panel": "Control panel",
    "canvas.controls.zoom_in": "Zoom in",
    "canvas.controls.zoom_out": "Zoom out",
    "canvas.controls.fit_view": "Fit view",
    "canvas.controls.interactive": "Toggle interactivity",
    "canvas.empty.hint":
      "No targets yet · click {action} on the left to start a plan",
    "rate.invalid": "Enter a number, e.g. 30 or 1/3",
    "rate.zero": "Enter a rate above 0",
    "rate.negative": "A rate cannot be negative",
    "rate.tooLarge": "A rate cannot exceed {max}/min",
    // Neutral discard wording: an uncapped or auto row reverts to an EMPTY
    // field, so copy claiming a rate came back would be false there.
    "rate.reverted": "That was not a number; the edit was discarded",
    "rate.revertedReason": "{reason}; the edit was discarded",
    "ratePrompt.title": "Amount",
    "ratePrompt.confirm": "Add",
    "ratePrompt.cancel": "Cancel",
    "ratePrompt.noLimit": "empty = no limit",
    "export.png.label": "Export PNG",
    "settings.open.label": "Open settings",
    "settings.title": "Settings",
    "settings.close.label": "Close",
    "settings.locale.title": "Language",
    "settings.area.title": "Area",
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
