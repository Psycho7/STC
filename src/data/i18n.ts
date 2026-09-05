import raw from "@aef/data/recipe-pack.i18n.json";

export type Locale = "en" | "ja" | "ru" | "zh";

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
  | "app.error.dismiss"
  | "app.error.busy"
  | "app.error.crash"
  | "app.locale.label"
  | "app.busLanes.label"
  | "inputs.title"
  | "inputs.rate.label"
  | "inputs.rate.unit"
  | "canvas.rate.unit"
  | "canvas.chip.share"
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
  | "node.upm"
  | "node.each"
  | "node.cycle"
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
  | "canvas.minimap"
  | "rate.invalid"
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
    "app.error.dismiss": "关闭",
    "app.error.busy": "方案正在加载，请等加载完成后再修改。",
    "app.error.crash": "规划器遇到意外错误，无法绘制当前方案。",
    "app.locale.label": "语言",
    "app.busLanes.label": "总线通道",
    "inputs.title": "输入",
    "inputs.rate.label": "速率",
    "inputs.rate.unit": "/分",
    "canvas.rate.unit": "/分",
    "canvas.chip.share": "{rate} 共 {total}/分",
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
    "node.upm": "件/分",
    "node.each": "单台",
    "node.cycle": "{time}秒 · 周期",
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
    "canvas.minimap": "缩略图",
    "rate.invalid": "请输入数字，例如 30 或 1/3",
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
    "app.error.dismiss": "Dismiss",
    "app.error.busy":
      "A plan is still loading. Try that change again once it lands.",
    "app.error.crash":
      "The planner hit an unexpected error and could not draw this plan.",
    "app.locale.label": "Language",
    "app.busLanes.label": "Bus lanes",
    "inputs.title": "Inputs",
    "inputs.rate.label": "Rate",
    "inputs.rate.unit": "/min",
    "canvas.rate.unit": "/min",
    "canvas.chip.share": "{rate} of {total}/min",
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
    "node.upm": "UPM",
    "node.each": "ea",
    "node.cycle": "{time}s · cycle",
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
    "canvas.minimap": "Mini map",
    "rate.invalid": "Enter a number, e.g. 30 or 1/3",
    "stats.output": "Output",
    "stats.output.unit": "targets",
    "stats.input": "Input",
    "stats.input.unit": "supply",
    "side.nav.label": "Boundary panel sections",
  },
  ja: {
    "targets.title": "ターゲット",
    "targets.add": "ターゲットを追加",
    "targets.remove": "削除",
    "targets.rate.unit": "個 / 分",
    "targets.rate.label": "レート",
    "targets.item.choose": "アイテムを選択…",
    "item.selected": "アイテム：{name}",
    "targets.remove.label": "ターゲットを削除",
    "targets.duplicate": "アイテム ID の重複: {itemId}",
    "targets.head.sub": "// 宣言された産出レート · 個 / 分",
    "targets.empty": "宣言されたターゲットはまだありません — 下のボタンで追加",
    "picker.title": "アイテムを選択",
    "picker.search.label": "アイテムを検索",
    "picker.search.placeholder": "名前または ID で検索…",
    "picker.group.depth": "ティア {n}",
    "picker.group.unranked": "循環 / 未分類",
    "picker.empty": "一致するアイテムがありません",
    "picker.close.label": "閉じる",
    "app.loading": "レイアウトを読み込み中...",
    "app.error.load": "プランの読み込みに失敗しました: {message}",
    "app.error.edit": "この変更を適用できません: {message}",
    "app.error.corrupt":
      "この共有リンクは破損しているか、新しいバージョンのプランナーのものです。",
    "app.error.reset": "新しいプランで開始",
    "app.error.solver": "ソルバーエラー: {message}",
    "app.error.infeasible":
      "実行可能な計画がありません（対象: {items}）。供給上限を上げるか、ターゲットを下げてください。",
    "app.error.infeasible.generic":
      "現在のターゲットと供給上限では実行可能な計画がありません。",
    "app.error.dismiss": "閉じる",
    "app.error.busy":
      "プランを読み込んでいます。完了してからもう一度変更してください。",
    "app.error.crash":
      "予期しないエラーが発生したため、このプランを描画できませんでした。",
    "app.locale.label": "言語",
    "app.busLanes.label": "バスレーン",
    "inputs.title": "入力",
    "inputs.rate.label": "レート",
    "inputs.rate.unit": "/分",
    "canvas.rate.unit": "/分",
    "canvas.chip.share": "{rate} 全 {total}/分",
    "inputs.rate.placeholder": "上限 /分",
    "inputs.rate.cap": "上限 {rate}/分",
    "inputs.remove": "削除",
    "inputs.remove.label": "入力行を削除",
    "inputs.add": "入力を追加",
    "inputs.add.exhausted": "すべてのアイテムが既に追加されています",
    "inputs.picker.listed":
      "グレー表示のアイテムは既にパネルにあります — 対応する行を直接編集してください",
    "inputs.duplicate": "このアイテムは既に登録されています",
    "inputs.unlimited": "無制限",
    "inputs.needed": "必要 {rate}/分",
    "inputs.empty": "宣言された入力はありません — すべて raw 供給として解決",
    "node.upm": "個/分",
    "node.each": "1台",
    "node.cycle": "{time}秒 · サイクル",
    "product.dir.in": "入力",
    "product.dir.out": "出力",
    "product.class.raw": "原料",
    "product.class.import": "輸入",
    "product.class.tap": "タップ",
    "product.tap.share": "全 {rate}/分",
    "product.flavor.target": "目標",
    "product.flavor.surplus": "余剰",
    "canvas.controls.panel": "コントロールパネル",
    "canvas.controls.zoom_in": "拡大",
    "canvas.controls.zoom_out": "縮小",
    "canvas.controls.fit_view": "全体表示",
    "canvas.controls.interactive": "操作の切替",
    "canvas.minimap": "ミニマップ",
    "rate.invalid": "数値を入力してください（例: 30 や 1/3）",
    "stats.output": "出力",
    "stats.output.unit": "ターゲット",
    "stats.input": "入力",
    "stats.input.unit": "供給",
    "side.nav.label": "境界パネルのセクション",
  },
  ru: {
    "targets.title": "Цели",
    "targets.add": "Добавить цель",
    "targets.remove": "Удалить",
    "targets.rate.unit": "шт. / мин",
    "targets.rate.label": "скорость",
    "targets.item.choose": "Выберите предмет…",
    "item.selected": "Предмет: {name}",
    "targets.remove.label": "удалить цель",
    "targets.duplicate": "Дублирующийся ID предмета: {itemId}",
    "targets.head.sub": "// заявленные скорости вывода · шт. / мин",
    "targets.empty": "Цели ещё не заданы — используйте кнопку ниже",
    "picker.title": "Выбор предмета",
    "picker.search.label": "Поиск предметов",
    "picker.search.placeholder": "Поиск по названию или ID…",
    "picker.group.depth": "Уровень {n}",
    "picker.group.unranked": "Цикл / без уровня",
    "picker.empty": "Нет подходящих предметов",
    "picker.close.label": "Закрыть",
    "app.loading": "Загрузка макета...",
    "app.error.load": "Не удалось загрузить план: {message}",
    "app.error.edit": "Не удалось применить изменение: {message}",
    "app.error.corrupt":
      "Эта ссылка повреждена или создана в более новой версии планировщика.",
    "app.error.reset": "Начать с нового плана",
    "app.error.solver": "Ошибка решателя: {message}",
    "app.error.infeasible":
      "Нет допустимого плана для: {items}. Повысьте лимиты поставок или снизьте цели.",
    "app.error.infeasible.generic":
      "Нет допустимого плана для текущих целей и лимитов поставок.",
    "app.error.dismiss": "Закрыть",
    "app.error.busy":
      "План ещё загружается. Повторите изменение после загрузки.",
    "app.error.crash":
      "Планировщик столкнулся с непредвиденной ошибкой и не смог отрисовать этот план.",
    "app.locale.label": "Язык",
    "app.busLanes.label": "Шинные линии",
    "inputs.title": "Входы",
    "inputs.rate.label": "Скорость",
    "inputs.rate.unit": "/мин",
    "canvas.rate.unit": "/мин",
    "canvas.chip.share": "{rate} из {total}/мин",
    "inputs.rate.placeholder": "лимит /мин",
    "inputs.rate.cap": "лимит {rate}/мин",
    "inputs.remove": "Удалить",
    "inputs.remove.label": "Удалить строку входа",
    "inputs.add": "Добавить вход",
    "inputs.add.exhausted": "Все предметы уже объявлены",
    "inputs.picker.listed":
      "Затемнённые предметы уже есть в панели — редактируйте их строки",
    "inputs.duplicate": "Предмет уже объявлен",
    "inputs.unlimited": "Без ограничений",
    "inputs.needed": "нужно {rate}/мин",
    "inputs.empty": "Входы не заданы — по умолчанию сырьевой источник",
    "node.upm": "шт/мин",
    "node.each": "ед.",
    "node.cycle": "{time}с · цикл",
    "product.dir.in": "Вход",
    "product.dir.out": "Выход",
    "product.class.raw": "сырьё",
    "product.class.import": "импорт",
    "product.class.tap": "отвод",
    "product.tap.share": "из {rate}/мин",
    "product.flavor.target": "цель",
    "product.flavor.surplus": "избыток",
    "canvas.controls.panel": "Панель управления",
    "canvas.controls.zoom_in": "Приблизить",
    "canvas.controls.zoom_out": "Отдалить",
    "canvas.controls.fit_view": "Вписать в экран",
    "canvas.controls.interactive": "Переключить интерактивность",
    "canvas.minimap": "Мини-карта",
    "rate.invalid": "Введите число, например 30 или 1/3",
    "stats.output": "Выход",
    "stats.output.unit": "цели",
    "stats.input": "Вход",
    "stats.input.unit": "ресурсы",
    "side.nav.label": "Разделы боковой панели",
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
