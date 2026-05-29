import raw from "@aef/data/recipe-pack.i18n.json";

export type Locale = "en" | "ja" | "ru" | "zh";

export type UiKey =
  | "targets.title"
  | "targets.add"
  | "targets.remove"
  | "targets.rate.unit"
  | "targets.rate.label"
  | "targets.recipe.label"
  | "targets.remove.label"
  | "targets.duplicate"
  | "app.loading"
  | "app.error.load"
  | "app.error.solver"
  | "app.error.dismiss"
  | "app.frozen.notice"
  | "app.frozen.edit"
  | "app.locale.label"
  | "canvas.copy_share"
  | "inputs.title"
  | "inputs.item.label"
  | "inputs.rate.label"
  | "inputs.rate.unit"
  | "canvas.rate.unit"
  | "inputs.rate.placeholder"
  | "inputs.rate.cap"
  | "inputs.remove"
  | "inputs.remove.label"
  | "inputs.add"
  | "inputs.duplicate"
  | "inputs.unlimited"
  | "inputs.needed"
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
    "targets.recipe.label": "配方",
    "targets.remove.label": "删除目标",
    "targets.duplicate": "配方 ID 重复: {recipeId}",
    "app.loading": "正在加载布局...",
    "app.error.load": "加载方案失败: {message}",
    "app.error.solver": "求解器错误: {message}",
    "app.error.dismiss": "关闭",
    "app.frozen.notice":
      "这是一个已冻结的 v1 方案。编辑会丢弃它并清空目标列表。",
    "app.frozen.edit": "编辑",
    "app.locale.label": "语言",
    "canvas.copy_share": "复制分享链接",
    "inputs.title": "输入",
    "inputs.item.label": "物品",
    "inputs.rate.label": "速率",
    "inputs.rate.unit": "/分",
    "canvas.rate.unit": "/分",
    "inputs.rate.placeholder": "上限 / 分",
    "inputs.rate.cap": "上限 {rate}/分",
    "inputs.remove": "移除",
    "inputs.remove.label": "移除输入行",
    "inputs.add": "添加输入",
    "inputs.duplicate": "该物品已声明",
    "inputs.unlimited": "无限",
    "inputs.needed": "需求 {rate}/分",
    "side.nav.label": "边界面板分区",
  },
  en: {
    "targets.title": "Targets",
    "targets.add": "Add target",
    "targets.remove": "Remove",
    "targets.rate.unit": "items / minute",
    "targets.rate.label": "rate",
    "targets.recipe.label": "recipe",
    "targets.remove.label": "remove target",
    "targets.duplicate": "Duplicate recipe id: {recipeId}",
    "app.loading": "Loading layout...",
    "app.error.load": "Failed to load plan: {message}",
    "app.error.solver": "Solver error: {message}",
    "app.error.dismiss": "Dismiss",
    "app.frozen.notice":
      "This is a frozen v1 plan. Editing will discard it and start an empty target list.",
    "app.frozen.edit": "Edit",
    "app.locale.label": "Language",
    "canvas.copy_share": "Copy share URL",
    "inputs.title": "Inputs",
    "inputs.item.label": "Item",
    "inputs.rate.label": "Rate",
    "inputs.rate.unit": "/min",
    "canvas.rate.unit": "/min",
    "inputs.rate.placeholder": "cap /min",
    "inputs.rate.cap": "cap {rate}/min",
    "inputs.remove": "Remove",
    "inputs.remove.label": "Remove input row",
    "inputs.add": "Add input",
    "inputs.duplicate": "Item already declared",
    "inputs.unlimited": "Unlimited",
    "inputs.needed": "needed {rate}/min",
    "side.nav.label": "Boundary panel sections",
  },
  ja: {
    "targets.title": "ターゲット",
    "targets.add": "ターゲットを追加",
    "targets.remove": "削除",
    "targets.rate.unit": "個 / 分",
    "targets.rate.label": "レート",
    "targets.recipe.label": "レシピ",
    "targets.remove.label": "ターゲットを削除",
    "targets.duplicate": "レシピ ID の重複: {recipeId}",
    "app.loading": "レイアウトを読み込み中...",
    "app.error.load": "プランの読み込みに失敗しました: {message}",
    "app.error.solver": "ソルバーエラー: {message}",
    "app.error.dismiss": "閉じる",
    "app.frozen.notice":
      "これは凍結された v1 プランです。編集すると破棄され、空のターゲットリストが開始されます。",
    "app.frozen.edit": "編集",
    "app.locale.label": "言語",
    "canvas.copy_share": "共有 URL をコピー",
    "inputs.title": "入力",
    "inputs.item.label": "アイテム",
    "inputs.rate.label": "レート",
    "inputs.rate.unit": "/分",
    "canvas.rate.unit": "/分",
    "inputs.rate.placeholder": "上限 /分",
    "inputs.rate.cap": "上限 {rate}/分",
    "inputs.remove": "削除",
    "inputs.remove.label": "入力行を削除",
    "inputs.add": "入力を追加",
    "inputs.duplicate": "このアイテムは既に登録されています",
    "inputs.unlimited": "無制限",
    "inputs.needed": "必要 {rate}/分",
    "side.nav.label": "境界パネルのセクション",
  },
  ru: {
    "targets.title": "Цели",
    "targets.add": "Добавить цель",
    "targets.remove": "Удалить",
    "targets.rate.unit": "шт. / мин",
    "targets.rate.label": "скорость",
    "targets.recipe.label": "рецепт",
    "targets.remove.label": "удалить цель",
    "targets.duplicate": "Дублирующийся ID рецепта: {recipeId}",
    "app.loading": "Загрузка макета...",
    "app.error.load": "Не удалось загрузить план: {message}",
    "app.error.solver": "Ошибка решателя: {message}",
    "app.error.dismiss": "Закрыть",
    "app.frozen.notice":
      "Это замороженный план v1. Редактирование удалит его и начнёт пустой список целей.",
    "app.frozen.edit": "Изменить",
    "app.locale.label": "Язык",
    "canvas.copy_share": "Скопировать ссылку",
    "inputs.title": "Входы",
    "inputs.item.label": "Предмет",
    "inputs.rate.label": "Скорость",
    "inputs.rate.unit": "/мин",
    "canvas.rate.unit": "/мин",
    "inputs.rate.placeholder": "лимит /мин",
    "inputs.rate.cap": "лимит {rate}/мин",
    "inputs.remove": "Удалить",
    "inputs.remove.label": "Удалить строку входа",
    "inputs.add": "Добавить вход",
    "inputs.duplicate": "Предмет уже объявлен",
    "inputs.unlimited": "Без ограничений",
    "inputs.needed": "нужно {rate}/мин",
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
