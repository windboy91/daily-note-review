import { App, getIconIds, getLanguage, Modal, moment, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, normalizePath, setIcon } from "obsidian";

type ActionType = "delete" | "move" | "add-property" | "add-tag" | "skip" | "open" | "append-today" | "template";
type FilterField = "created-days" | "folder" | "tag" | "property";
type FilterOperator = "older-than" | "newer-than" | "at-least" | "at-most" | "exactly" | "contains" | "not-contains" | "starts-with" | "not-starts-with" | "ends-with" | "not-ends-with" | "equals" | "not-equals" | "greater-than" | "less-than" | "greater-or-equal" | "less-or-equal" | "exists" | "not-exists" | "is-empty" | "is-not-empty";
interface ActionStep { type: "move" | "add-property" | "add-tag"; value: string; propertyName?: string; }
interface ReviewAction { id: string; label: string; type: ActionType; value: string; icon: string; colorText: string; colorBackground: string; shortcut: string; propertyName?: string; insertAt?: "start" | "end" | "after-text"; anchorText?: string; steps: ActionStep[]; }
interface FilterRule { field: FilterField; operator: FilterOperator; value: string; propertyName?: string; }
interface FilterGroup { name: string; match: "all" | "any"; rules: FilterRule[]; }
interface ReviewSettings {
  dailyLimit: number;
  filterGroups: FilterGroup[];
  actions: ReviewAction[];
  reviewedToday: Record<string, string>;
  snoozedUntil: Record<string, string>;
  coverMode: "property" | "first-image" | "none";
  coverProperty: string;
  todayNoteFolder: string;
  todayNoteFormat: string;
  /** Legacy combined folder/date pattern, kept so existing plugin data can be migrated. */
  todayNotePattern: string;
}

const DEFAULT_ACTIONS: ReviewAction[] = [
  { id: "move", label: "Move to review", type: "move", value: "To review", icon: "folder-input", colorText: "#000000", colorBackground: "#ffffff", shortcut: "", steps: [] },
  { id: "tag", label: "Add #reviewed", type: "add-tag", value: "reviewed", icon: "tag", colorText: "#000000", colorBackground: "#ffffff", shortcut: "", steps: [] },
  { id: "open", label: "Open in background", type: "open", value: "", icon: "external-link", colorText: "#000000", colorBackground: "#ffffff", shortcut: "", steps: [] },
];
const DEFAULT_SETTINGS: ReviewSettings = {
  dailyLimit: 10,
  filterGroups: [{ name: "Older notes", match: "all", rules: [{ field: "created-days", operator: "at-least", value: "7" }] }],
  actions: DEFAULT_ACTIONS,
  reviewedToday: {},
  snoozedUntil: {},
  coverMode: "property",
  coverProperty: "cover",
  todayNoteFolder: "",
  todayNoteFormat: "YYYY-MM-DD",
  todayNotePattern: "YYYY-MM-DD.md",
};

function actionFrom(value: any, index: number): ReviewAction {
  const oldType = value?.type;
  const type: ActionType = oldType === "tag" ? "add-tag" : oldType === "property" ? "add-property" : ["delete", "move", "add-property", "add-tag", "skip", "open", "append-today", "template"].includes(oldType) ? oldType : "move";
  return {
    id: String(value?.id ?? `action-${index + 1}`), label: String(value?.label ?? "Action"), type,
    value: String(value?.value ?? ""), icon: String(value?.icon ?? "check"), colorText: String(value?.colorText || "#000000"), colorBackground: String(value?.colorBackground || value?.color || "#ffffff"),
    shortcut: String(value?.shortcut ?? ""), propertyName: String(value?.propertyName ?? ""), insertAt: value?.insertAt ?? "end", anchorText: String(value?.anchorText ?? ""),
    steps: Array.isArray(value?.steps) ? value.steps : [],
  };
}

export default class DailyNoteReviewPlugin extends Plugin {
  settings: ReviewSettings;

  private language(): string { return (getLanguage as (() => string) | undefined)?.() ?? moment.locale(); }
  t(english: string, french: string): string { return this.language().toLowerCase().startsWith("fr") ? french : english; }

  async onload() {
    const saved = await this.loadData() ?? {};
    const legacyTodayPattern = String(saved.todayNotePattern ?? "YYYY-MM-DD.md").replace(/\\/g, "/");
    const legacyFolderSeparator = legacyTodayPattern.lastIndexOf("/");
    const legacyTodayFolder = legacyFolderSeparator >= 0 ? legacyTodayPattern.slice(0, legacyFolderSeparator).replace(/^\/+|\/+$/g, "") : "";
    const legacyTodayFormat = (legacyFolderSeparator >= 0 ? legacyTodayPattern.slice(legacyFolderSeparator + 1) : legacyTodayPattern).replace(/\.md$/i, "") || "YYYY-MM-DD";
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      actions: Array.isArray(saved.actions) ? saved.actions.map(actionFrom) : this.defaultActionsForLocale(),
      filterGroups: Array.isArray(saved.filterGroups) ? saved.filterGroups.map((group: any, i: number) => ({ name: String(group.name ?? this.t(`Group ${i + 1}`, `Groupe ${i + 1}`)), match: group.match === "any" ? "any" : "all", rules: Array.isArray(group.rules) ? group.rules : [] })) : ("minAgeDays" in saved || "folders" in saved || "tags" in saved || "property" in saved ? this.migrateLegacyFilters(saved) : this.defaultFilterGroupsForLocale()),
      reviewedToday: saved.reviewedToday ?? {},
      snoozedUntil: saved.snoozedUntil ?? {},
      coverMode: saved.coverMode ?? "property",
      coverProperty: saved.coverProperty ?? "cover",
      todayNoteFolder: saved.todayNoteFolder ?? legacyTodayFolder,
      todayNoteFormat: saved.todayNoteFormat ?? legacyTodayFormat,
      todayNotePattern: saved.todayNotePattern ?? "YYYY-MM-DD.md",
    };
    if (!this.language().toLowerCase().startsWith("fr")) {
      for (const action of this.settings.actions) {
        if (action.type === "move" && ["À relire", "Déplacer vers À relire"].includes(action.label)) { action.label = "Move to review"; action.value = "To review"; }
        if (action.type === "add-tag" && action.label === "Ajouter #reviewed") action.label = "Add #reviewed";
        if (action.type === "open" && action.label === "Ouvrir en arrière-plan") action.label = "Open in background";
      }
    }
    this.addRibbonIcon("inbox", this.t("Open daily review", "Ouvrir la revue quotidienne"), () => { void this.openReview(); });
    this.addCommand({ id: "open-daily-review", name: this.t("Open daily review", "Ouvrir la revue quotidienne"), callback: () => this.openReview() });
    this.addCommand({ id: "count-daily-review", name: this.t("Count notes to review", "Compter les notes à revoir"), callback: () => this.showReviewCount() });
    this.addSettingTab(new ReviewSettingTab(this.app, this));
  }

  private defaultActionsForLocale(): ReviewAction[] {
    const actions = DEFAULT_ACTIONS.map(actionFrom);
    if (this.language().toLowerCase().startsWith("fr")) {
      actions[0].label = "Déplacer vers À relire"; actions[0].value = "À relire";
      actions[1].label = "Ajouter #reviewed";
      actions[2].label = "Ouvrir en arrière-plan";
    }
    return actions;
  }

  private defaultFilterGroupsForLocale(): FilterGroup[] {
    return [{ name: this.t("Older notes", "Notes anciennes"), match: "all", rules: [{ field: "created-days", operator: "at-least", value: "7" }] }];
  }

  private migrateLegacyFilters(saved: any): FilterGroup[] {
    const rules: FilterRule[] = [];
    const days = Math.max(0, Number(saved.minAgeDays ?? 7));
    rules.push({ field: "created-days", operator: "older-than", value: String(days) });
    const folders = String(saved.folders ?? "").split("\n").map((value: string) => value.trim()).filter(Boolean);
    for (const value of folders) rules.push({ field: "folder", operator: "contains", value });
    const tags = String(saved.tags ?? "").split(/[\n,]/).map((value: string) => value.trim().replace(/^#/, "")).filter(Boolean);
    for (const value of tags) rules.push({ field: "tag", operator: "equals", value });
    if (saved.property) rules.push({ field: "property", operator: saved.propertyValue ? "equals" : "exists", propertyName: String(saved.property), value: String(saved.propertyValue ?? "") });
    return [{ name: this.t("Migrated filters", "Filtres migrés"), match: "all", rules }];
  }

  async saveSettings() { await this.saveData(this.settings); }

  private tagsFor(file: TFile): Set<string> {
    const cache = this.app.metadataCache.getFileCache(file);
    const fmTags = cache?.frontmatter?.tags;
    const frontmatter = Array.isArray(fmTags) ? fmTags.map(String) : fmTags ? [String(fmTags)] : [];
    return new Set([...(cache?.tags ?? []).map(item => item.tag.replace(/^#/, "")), ...frontmatter.map(tag => tag.replace(/^#/, ""))]);
  }

  private matchesRule(file: TFile, rule: FilterRule): boolean {
    const value = rule.value.trim();
    if (rule.field === "created-days") {
      const days = Number(value);
      if (!Number.isFinite(days) || days < 0) return false;
      const ageDays = (Date.now() - file.stat.ctime) / 86400000;
      if (rule.operator === "newer-than") return ageDays < days;
      if (rule.operator === "at-most") return ageDays <= days;
      if (rule.operator === "exactly") return Math.floor(ageDays) === days;
      if (rule.operator === "older-than") return ageDays > days;
      return ageDays >= days;
    }
    if (rule.field === "folder") {
      const folder = file.parent?.path ?? "";
      const folderValue = value.replace(/^\/+|\/+$/g, "").replace(/\\/g, "/");
      return this.compareString(folder, folderValue, rule.operator);
    }
    if (rule.field === "tag") {
      const tags = this.tagsFor(file);
      if (rule.operator === "exists") return tags.size > 0;
      if (rule.operator === "not-exists") return tags.size === 0;
      if (rule.operator === "is-empty") return tags.size === 0;
      if (rule.operator === "is-not-empty") return tags.size > 0;
      const expected = value.replace(/^#/, "");
      const positiveOperator: Record<string, FilterOperator> = { "not-equals": "equals", "not-contains": "contains", "not-starts-with": "starts-with", "not-ends-with": "ends-with" };
      const isNegative = rule.operator in positiveOperator;
      const operator = positiveOperator[rule.operator] ?? rule.operator;
      const found = [...tags].some(tag => this.compareString(tag, expected, operator));
      return isNegative ? !found : found;
    }
    if (rule.field === "property") {
      const [oldName, ...rest] = value.split("=");
      const name = rule.propertyName ?? oldName;
      if (!name && !["is-empty", "is-not-empty"].includes(rule.operator)) return false;
      const actual = this.app.metadataCache.getFileCache(file)?.frontmatter?.[name.trim()];
      if (rule.operator === "exists") return actual !== undefined;
      if (rule.operator === "not-exists") return actual === undefined;
      if (rule.operator === "is-empty") return actual === undefined || actual === null || actual === "";
      if (rule.operator === "is-not-empty") return actual !== undefined && actual !== null && actual !== "";
      if (actual === undefined) return false;
      if (["greater-than", "less-than", "greater-or-equal", "less-or-equal"].includes(rule.operator)) {
        const actualNumber = Number(actual); const expectedNumber = Number(rule.propertyName ? value : rest.join("=").trim());
        if (Number.isFinite(actualNumber) && Number.isFinite(expectedNumber)) {
          if (rule.operator === "greater-than") return actualNumber > expectedNumber;
          if (rule.operator === "less-than") return actualNumber < expectedNumber;
          if (rule.operator === "greater-or-equal") return actualNumber >= expectedNumber;
          return actualNumber <= expectedNumber;
        }
        const actualDate = Date.parse(String(actual)); const expectedDate = Date.parse(rule.propertyName ? value : rest.join("=").trim());
        if (Number.isFinite(actualDate) && Number.isFinite(expectedDate)) {
          if (rule.operator === "greater-than") return actualDate > expectedDate;
          if (rule.operator === "less-than") return actualDate < expectedDate;
          if (rule.operator === "greater-or-equal") return actualDate >= expectedDate;
          return actualDate <= expectedDate;
        }
        return false;
      }
      return this.compareString(String(actual), rule.propertyName ? value : rest.join("=").trim(), rule.operator);
    }
    return true;
  }

  private compareString(actual: string, expected: string, operator: FilterOperator): boolean {
    const a = actual.toLowerCase(); const b = expected.toLowerCase();
    if (operator === "equals") return a === b;
    if (operator === "not-equals") return a !== b;
    if (operator === "starts-with") return a.startsWith(b);
    if (operator === "not-starts-with") return !a.startsWith(b);
    if (operator === "ends-with") return a.endsWith(b);
    if (operator === "not-ends-with") return !a.endsWith(b);
    if (operator === "not-contains") return !a.includes(b);
    return a.includes(b);
  }

  groupContradiction(group: FilterGroup): string | null {
    if (group.match !== "all") return null;
    const equalities = new Map<string, string>();
    const present = new Set<string>(); const absent = new Set<string>(); const empty = new Set<string>(); const nonEmpty = new Set<string>();
    let minAge = -Infinity; let maxAge = Infinity; let minInclusive = true; let maxInclusive = true;
    for (const rule of group.rules) {
      if (rule.field === "created-days" && Number.isFinite(Number(rule.value))) {
        const n = Number(rule.value);
        if (["older-than", "at-least"].includes(rule.operator)) {
          if (n > minAge) { minAge = n; minInclusive = rule.operator === "at-least"; }
          else if (n === minAge && rule.operator === "older-than") minInclusive = false;
        }
        if (["newer-than", "at-most"].includes(rule.operator)) {
          if (n < maxAge) { maxAge = n; maxInclusive = rule.operator === "at-most"; }
          else if (n === maxAge && rule.operator === "newer-than") maxInclusive = false;
        }
        if (rule.operator === "exactly") { minAge = Math.max(minAge, n); maxAge = Math.min(maxAge, n + 1); minInclusive = true; maxInclusive = false; }
      }
      if (rule.field === "property" || rule.field === "tag") {
        const [oldName, oldValue] = rule.value.split(/=(.*)/s, 2);
        const name = rule.propertyName ?? oldName;
        const val = rule.propertyName ? rule.value : oldValue;
        const key = rule.field === "tag" ? `tag:${name.replace(/^#/, "")}` : `property:${name.trim()}`;
        if (["exists", "is-not-empty"].includes(rule.operator)) present.add(key);
        if (rule.operator === "not-exists") absent.add(key);
        if (rule.operator === "is-empty") empty.add(key);
        if (rule.operator === "is-not-empty") nonEmpty.add(key);
        if (rule.operator === "equals" && val !== undefined) {
          if (equalities.has(key) && equalities.get(key) !== val) return this.t("Conflicting exact values for the same field.", "Plusieurs valeurs exactes incompatibles pour le même champ.");
          equalities.set(key, val);
        }
      }
    }
    if (minAge > maxAge || (minAge === maxAge && !(minInclusive && maxInclusive))) return this.t("The age limits cannot both be true.", "Les limites d’âge ne peuvent pas être vraies en même temps.");
    for (const key of present) if (absent.has(key)) return this.t("A field is both required and forbidden.", "Un champ est à la fois requis et interdit.");
    for (const key of empty) if (nonEmpty.has(key)) return this.t("A field cannot be both empty and non-empty.", "Un champ ne peut pas être à la fois vide et non vide.");
    return null;
  }

  getGroupCount(group: FilterGroup): number { return this.app.vault.getMarkdownFiles().filter(file => group.rules.length === 0 || (group.match === "all" ? group.rules.every(rule => this.matchesRule(file, rule)) : group.rules.some(rule => this.matchesRule(file, rule)))).length; }

  getVaultSuggestions(kind: "folders" | "tags" | "properties" | "templates" | "property-values", propertyName = ""): string[] {
    const files = this.app.vault.getMarkdownFiles();
    if (kind === "folders") return this.app.vault.getAllLoadedFiles().filter((file): file is TFolder => file instanceof TFolder && !!file.path).map(folder => folder.path).sort();
    if (kind === "tags") return [...new Set(files.flatMap(file => [...this.tagsFor(file)]))].sort();
    if (kind === "properties") return [...new Set(files.flatMap(file => Object.keys(this.app.metadataCache.getFileCache(file)?.frontmatter ?? {})))].sort();
    if (kind === "templates") return files.map(file => file.path).sort();
    if (propertyName) return [...new Set(files.flatMap(file => {
      const value = this.app.metadataCache.getFileCache(file)?.frontmatter?.[propertyName];
      const values = Array.isArray(value) ? value : [value];
      return values.filter(item => ["string", "number", "boolean"].includes(typeof item)).map(String);
    }))].sort();
    return [...new Set(files.flatMap(file => Object.values(this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}).filter(value => ["string", "number"].includes(typeof value)).map(String)))].sort();
  }

  getReviewStats(group?: FilterGroup) {
    const today = new Date().toISOString().slice(0, 10);
    const scanned = this.app.vault.getMarkdownFiles();
    const eligible = scanned.filter(file => {
      if (this.settings.reviewedToday[file.path] === today) return false;
      if ((this.settings.snoozedUntil[file.path] ?? "") > today) return false;
      const matchesGroup = (candidate: FilterGroup) => {
        if (!candidate.rules.length) return true;
        const checks = candidate.rules.map(rule => this.matchesRule(file, rule));
        return candidate.match === "all" ? checks.every(Boolean) : checks.some(Boolean);
      };
      if (group) return matchesGroup(group);
      return !this.settings.filterGroups.length || this.settings.filterGroups.some(matchesGroup);
    });
    return { scanned: scanned.length, matching: eligible.length, queued: eligible.slice(0, Math.max(1, this.settings.dailyLimit)) };
  }

  async showReviewCount() {
    const lines = this.settings.filterGroups.map(group => {
      const stats = this.getReviewStats(group);
      return `${group.name}: ${stats.matching} / ${stats.scanned}`;
    });
    const stats = this.getReviewStats();
    if (lines.length > 1) lines.unshift(this.t(`Scanned: ${stats.scanned} notes`, `Analysées : ${stats.scanned} notes`));
    new Notice(lines.join("\n") || this.t(`Scanned: ${stats.scanned} notes → To review: ${stats.matching}`, `Analysées : ${stats.scanned} notes → À revoir : ${stats.matching}`), 10000);
  }

  async openReview() {
    const groups = this.settings.filterGroups.length ? this.settings.filterGroups : this.defaultFilterGroupsForLocale();
    if (groups.length === 1) { await this.openReviewGroup(groups[0]); return; }
    new ReviewChooserModal(this.app, this, groups).open();
  }

  async openReviewGroup(group: FilterGroup) {
    const files = this.getReviewStats(group).queued;
    if (!files.length) { new Notice(this.t(`No notes match “${group.name}”.`, `Aucune note ne correspond à « ${group.name} ».`)); return; }
    new ReviewModal(this.app, this, files, group.name).open();
  }

  async applyAction(file: TFile, action: ReviewAction) {
    const applyStep = async (step: ActionStep) => {
      if (step.type === "move") {
        const folder = normalizePath((step.value.trim() || "To review").replace(/^\/+/, ""));
        if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder);
        const destination = normalizePath(`${folder}/${file.name}`);
        if (destination !== file.path) await this.app.fileManager.renameFile(file, destination);
      } else if (step.type === "add-tag") {
        const tag = step.value.replace(/^#/, "").trim();
        await this.app.fileManager.processFrontMatter(file, fm => {
          const tags = Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : [];
          if (tag && !tags.includes(tag)) fm.tags = [...tags, tag];
        });
      } else if (step.type === "add-property") {
        if (!step.propertyName?.trim()) throw new Error(this.t("Enter a property name in the action settings.", "Renseignez le nom de la propriété dans les réglages de l’action."));
        await this.app.fileManager.processFrontMatter(file, fm => { fm[step.propertyName!.trim()] = step.value; });
      }
    };
    if (action.type === "move") {
      const folder = normalizePath((action.value.trim() || "To review").replace(/^\/+/, ""));
      if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.createFolder(folder);
      const destination = normalizePath(`${folder}/${file.name}`);
      if (destination !== file.path) await this.app.fileManager.renameFile(file, destination);
    } else if (action.type === "add-tag") {
      const tag = action.value.replace(/^#/, "").trim();
      await this.app.fileManager.processFrontMatter(file, fm => {
        const tags = Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : [];
        if (tag && !tags.includes(tag)) fm.tags = [...tags, tag];
      });
    } else if (action.type === "add-property") {
      const name = (action.propertyName ?? "").trim();
      if (!name) throw new Error(this.t("Enter a property name in the action settings.", "Renseignez le nom de la propriété dans les réglages."));
      await this.app.fileManager.processFrontMatter(file, fm => { fm[name] = action.value; });
    } else if (action.type === "delete") {
      await this.app.vault.trash(file, true);
    } else if (action.type === "open") {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(file, { active: false });
    } else if (action.type === "append-today") {
      const format = (this.settings.todayNoteFormat || "YYYY-MM-DD").replace(/\.md$/i, "");
      const formattedName = moment().format(format);
      const folder = normalizePath((this.settings.todayNoteFolder || "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""));
      const todayPath = normalizePath(`${folder ? `${folder}/` : ""}${formattedName}.md`);
      const normalizedTarget = todayPath.toLowerCase().replace(/^\/+/, "");
      const todayFile = this.app.vault.getMarkdownFiles().find(note => {
        const currentPath = normalizePath(note.path).toLowerCase().replace(/^\/+/, "");
        return currentPath === normalizedTarget || currentPath.endsWith(`/${normalizedTarget}`);
      }) ?? (!folder ? this.app.vault.getMarkdownFiles().find(note => note.basename.toLowerCase() === formattedName.toLowerCase()) : undefined);
      if (!todayFile) throw new Error(this.t(`Today's note was not found: ${todayPath}`, `Note du jour introuvable : ${todayPath}`));
      const link = `[[${file.path.replace(/\.md$/i, "")}]]`;
      await this.app.vault.process(todayFile, content => {
        if (action.insertAt === "start") return `${link}\n${content}`;
        if (action.insertAt === "after-text") {
          const anchor = action.anchorText ?? ""; const at = content.indexOf(anchor);
          if (!anchor || at < 0) throw new Error(this.t("The insertion text was not found in today's note.", "Le texte repère n’a pas été trouvé dans la note du jour."));
          const end = at + anchor.length; return `${content.slice(0, end)}\n${link}${content.slice(end)}`;
        }
        return `${content}${content.endsWith("\n") || !content ? "" : "\n"}${link}\n`;
      });
    } else if (action.type === "template") {
      const templatePath = normalizePath(action.value.trim());
      const template = this.app.vault.getAbstractFileByPath(templatePath);
      if (!(template instanceof TFile)) throw new Error(this.t(`Template not found: ${templatePath}`, `Modèle introuvable : ${templatePath}`));
      const templateText = await this.app.vault.cachedRead(template);
      await this.app.vault.process(file, content => `${content}${content.endsWith("\n") || !content ? "" : "\n"}${templateText}\n`);
    } else if (action.type === "skip") {
      const days = Math.max(1, Number(action.value) || 1);
      const until = new Date(); until.setDate(until.getDate() + days);
      this.settings.snoozedUntil[file.path] = until.toISOString().slice(0, 10);
      await this.saveSettings();
      return;
    }
    for (const step of action.steps ?? []) await applyStep(step);
    const today = new Date().toISOString().slice(0, 10);
    this.settings.reviewedToday[file.path] = today;
    await this.saveSettings();
  }
}

class ReviewChooserModal extends Modal {
  constructor(app: App, private plugin: DailyNoteReviewPlugin, private groups: FilterGroup[]) { super(app); }
  onOpen() {
    this.modalEl.addClass("daily-review-chooser-modal");
    this.titleEl.setText(this.plugin.t("Choose a daily review", "Choisir une revue quotidienne"));
    const host = this.contentEl.createDiv({ cls: "daily-review-chooser" });
    this.groups.forEach(group => {
      const stats = this.plugin.getReviewStats(group);
      const button = host.createEl("button", { cls: "daily-review-chooser-item" });
      button.createEl("strong", { text: group.name });
      button.createEl("span", { text: `${stats.matching} ${this.plugin.t("notes to review", "notes à revoir")}` });
      button.addEventListener("click", () => { this.close(); void this.plugin.openReviewGroup(group); });
    });
  }
  onClose() { this.contentEl.empty(); }
}

class IconPickerModal extends Modal {
  constructor(app: App, private plugin: DailyNoteReviewPlugin, private current: string, private onChoose: (icon: string) => void) { super(app); }
  onOpen() {
    this.modalEl.addClass("daily-review-icon-modal");
    this.titleEl.setText(this.plugin.t("Choose an icon", "Choisir une icône"));
    const search = this.contentEl.createEl("input", { type: "search", placeholder: this.plugin.t("Search icons…", "Rechercher une icône…") });
    const grid = this.contentEl.createDiv({ cls: "daily-review-icon-grid daily-review-icon-modal-grid" });
    const draw = () => {
      grid.empty();
      const query = search.value.trim().toLowerCase();
      getIconIds().filter(id => !query || id.includes(query)).slice(0, 240).forEach(id => {
        const choice = grid.createEl("button", { attr: { "aria-label": id, title: id } });
        if (id === this.current) choice.addClass("is-selected");
        setIcon(choice, id);
        choice.addEventListener("click", () => { this.onChoose(id); this.close(); });
      });
    };
    search.addEventListener("input", draw);
    draw();
  }
  onClose() { this.contentEl.empty(); }
}

class ReviewModal extends Modal {
  private index = 0;
  private card: HTMLDivElement;
  private shortcutHandler = (evt: KeyboardEvent) => this.handleShortcut(evt);
  constructor(app: App, private plugin: DailyNoteReviewPlugin, private files: TFile[], private reviewName: string) { super(app); }

  onOpen() {
    this.modalEl.addClass("daily-review-modal");
    this.titleEl.setText(`${this.plugin.t("Daily review", "Revue quotidienne")} — ${this.reviewName}`);
    const layout = this.contentEl.createDiv({ cls: "daily-review-layout" });
    const prev = layout.createEl("button", { text: "←", cls: "daily-review-arrow", attr: { "aria-label": this.plugin.t("Previous note", "Note précédente") } });
    this.card = layout.createDiv({ cls: "daily-review-card" });
    const next = layout.createEl("button", { text: "→", cls: "daily-review-arrow", attr: { "aria-label": this.plugin.t("Next note", "Note suivante") } });
    prev.addEventListener("click", () => this.show(this.index - 1));
    next.addEventListener("click", () => this.show(this.index + 1));
    this.scope.register([], "ArrowLeft", () => this.show(this.index - 1));
    this.scope.register([], "ArrowRight", () => this.show(this.index + 1));
    window.addEventListener("keydown", this.shortcutHandler);
    this.show(0);
  }

  private handleShortcut(evt: KeyboardEvent) {
    if (evt.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(evt.target.tagName)) return;
    const pressed = [evt.metaKey || evt.ctrlKey ? "mod" : "", evt.altKey ? "alt" : "", evt.shiftKey ? "shift" : "", evt.key.toLowerCase()].filter(Boolean).join("+");
    const action = this.plugin.settings.actions.find(item => item.shortcut.trim().toLowerCase() === pressed);
    if (action) { evt.preventDefault(); void this.runAction(action); }
  }

  private async runAction(action: ReviewAction) {
    const file = this.files[this.index];
    try {
      await this.plugin.applyAction(file, action);
      this.files.splice(this.index, 1);
      if (!this.files.length) { new Notice(this.plugin.t("Review complete!", "Revue terminée !")); this.close(); return; }
      this.show(Math.min(this.index, this.files.length - 1));
    } catch (error) { new Notice(this.plugin.t(`Action failed: ${String(error)}`, `Action impossible : ${String(error)}`)); }
  }

  private show(index: number) {
    if (!this.files.length) { this.close(); return; }
    this.index = Math.max(0, Math.min(index, this.files.length - 1));
    const file = this.files[this.index];
    this.card.empty();
    const cover = this.findCover(file);
    if (cover) {
      const image = this.card.createEl("img", { cls: "daily-review-cover", attr: { alt: file.basename } });
      image.src = this.app.vault.getResourcePath(cover);
    }
    this.card.createDiv({ cls: "daily-review-counter", text: `${this.index + 1} / ${this.files.length}` });
    this.card.createEl("h2", { text: file.basename, cls: "daily-review-title" });
    this.card.createDiv({ text: file.path, cls: "daily-review-path" });
    const details = this.card.createDiv({ cls: "daily-review-details" });
    details.createSpan({ text: this.plugin.t(`Created ${new Date(file.stat.ctime).toLocaleDateString()}`, `Créée le ${new Date(file.stat.ctime).toLocaleDateString()}`) });
    const preview = this.card.createDiv({ cls: "daily-review-preview" });
    const heading = this.app.metadataCache.getFileCache(file)?.headings?.[0];
    const start = heading?.position.start.offset ?? 0;
    void this.app.vault.cachedRead(file).then(content => {
      if (this.files[this.index] === file) preview.setText(content.slice(start, start + 700).trim() || this.plugin.t("This note does not contain any text yet.", "Cette note ne contient pas encore de texte."));
    });
    const actions = this.card.createDiv({ cls: "daily-review-actions" });
    for (const action of this.plugin.settings.actions) {
      const button = actions.createEl("button", { cls: "daily-review-action" });
      if (action.colorText) button.style.setProperty("--action-text-color", action.colorText);
      if (action.colorBackground) button.style.setProperty("--action-background-color", action.colorBackground);
      if (action.icon) { const icon = button.createSpan({ cls: "daily-review-action-icon" }); setIcon(icon, action.icon); }
      button.createSpan({ text: action.label });
      if (action.shortcut) button.createEl("kbd", { text: action.shortcut, cls: "daily-review-shortcut" });
      button.addEventListener("click", () => { void this.runAction(action); });
    }
    const skip = actions.createEl("button", { text: this.plugin.t("Pass", "Passer"), cls: "daily-review-skip" });
    skip.addEventListener("click", () => {
      if (this.index >= this.files.length - 1) this.close();
      else this.show(this.index + 1);
    });
  }

  private findCover(file: TFile): TFile | null {
    if (this.plugin.settings.coverMode === "none") return null;
    let target = "";
    if (this.plugin.settings.coverMode === "property") {
      const value = this.app.metadataCache.getFileCache(file)?.frontmatter?.[this.plugin.settings.coverProperty];
      if (typeof value === "string") target = value.replace(/^!?\[\[|\]\]$/g, "").replace(/^!?\[[^\]]*\]\((.*)\)$/, "$1").split("|")[0].trim();
    } else {
      const embeds = this.app.metadataCache.getFileCache(file)?.embeds ?? [];
      for (const embed of embeds) {
        const candidate = this.app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
        if (candidate && /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(candidate.extension)) return candidate;
      }
    }
    return target ? this.app.metadataCache.getFirstLinkpathDest(target, file.path) : null;
  }

  onClose() { window.removeEventListener("keydown", this.shortcutHandler); this.contentEl.empty(); }
}

class ReviewSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: DailyNoteReviewPlugin) { super(app, plugin); }

  display() {
    this.containerEl.empty();
    const el = this.containerEl;
    const t = (en: string, fr: string) => this.plugin.t(en, fr);
    const suggestions = (values: string[]) => [...new Set(values.filter(Boolean))];
    const wireSuggestions = (input: HTMLInputElement, getOptions: () => string[]) => {
      const host = input.parentElement;
      if (!host) return;
      host.addClass("daily-review-autocomplete-host");
      const list = host.createDiv({ cls: "daily-review-autocomplete-list" });
      list.hide();
      const refresh = () => {
        const query = input.value.trim().replace(/^#/, "").replace(/^\/+/, "").toLowerCase();
        const choices = suggestions(getOptions()).filter(item => !query || item.toLowerCase().includes(query)).slice(0, 40);
        list.empty();
        if (!choices.length) { list.hide(); return; }
        choices.forEach(choice => {
          const option = list.createEl("button", { cls: "daily-review-autocomplete-option", text: choice, attr: { type: "button" } });
          option.addEventListener("mousedown", evt => evt.preventDefault());
          option.addEventListener("click", () => {
            input.value = choice;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            list.hide();
          });
        });
        list.show();
      };
      input.addEventListener("focus", refresh);
      input.addEventListener("input", refresh);
      input.addEventListener("blur", () => window.setTimeout(() => list.hide(), 150));
    };
    type SuggestionSource = string[] | (() => string[]);
    const makeInput = (parent: HTMLElement, value: string, placeholder: string, options: SuggestionSource, onChange: (value: string) => void): HTMLInputElement => {
      const input = parent.createEl("input", { type: "text", placeholder }); input.value = value;
      wireSuggestions(input, typeof options === "function" ? options : () => options);
      input.addEventListener("change", () => onChange(input.value)); return input;
    };
    const addSettingInput = (parent: HTMLElement, name: string, value: string, placeholder: string, options: SuggestionSource, onChange: (value: string) => void, desc?: string) => {
      const setting = new Setting(parent).setName(name); if (desc) setting.setDesc(desc);
      setting.addText(text => { text.setValue(value).setPlaceholder(placeholder); text.inputEl.addEventListener("input", () => onChange(text.inputEl.value)); wireSuggestions(text.inputEl, typeof options === "function" ? options : () => options); });
    };
    const save = () => this.plugin.saveSettings();

    el.createEl("h2", { text: t("Daily Note Review", "Revue quotidienne") });
    new Setting(el).setName(t("Notes per day", "Notes par jour")).setDesc(t("Maximum notes shown in one review session.", "Nombre maximal de notes dans une session de revue.")).addText(text => text.setValue(String(this.plugin.settings.dailyLimit)).onChange(async value => { this.plugin.settings.dailyLimit = Math.max(1, Number(value) || 1); await save(); }));
    new Setting(el).setName(t("Count matching notes", "Compter les notes correspondantes")).setDesc(t("Scans the vault and reports how many notes match.", "Analyse le coffre et indique combien de notes correspondent.")).addButton(button => button.setButtonText(t("Scan now", "Analyser maintenant")).onClick(() => { void this.plugin.showReviewCount(); }));

    el.createEl("h3", { text: t("General settings", "Réglages généraux") });
    const syncLegacyTodayPattern = () => {
      const folder = this.plugin.settings.todayNoteFolder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      const format = this.plugin.settings.todayNoteFormat.trim().replace(/\.md$/i, "") || "YYYY-MM-DD";
      this.plugin.settings.todayNotePattern = `${folder ? `${folder}/` : ""}${format}.md`;
    };
    addSettingInput(el, t("Daily notes folder", "Dossier des notes quotidiennes"), this.plugin.settings.todayNoteFolder, t("Vault folder (leave empty for vault root)", "Dossier du coffre (laisser vide pour la racine)"), this.plugin.getVaultSuggestions("folders"), async value => {
      this.plugin.settings.todayNoteFolder = value;
      syncLegacyTodayPattern();
      await save();
    }, t("Folder path is literal; it is not treated as a date format.", "Le chemin du dossier est littéral ; il n’est pas interprété comme un format de date."));
    new Setting(el).setName(t("Daily note date format", "Format de date de la note quotidienne")).setDesc(t("Moment.js format used for the daily note filename, e.g. YYYY-MM-DD.", "Format Moment.js utilisé pour le nom du fichier, par ex. YYYY-MM-DD.")).addText(text => text.setValue(this.plugin.settings.todayNoteFormat).onChange(async value => {
      this.plugin.settings.todayNoteFormat = value || "YYYY-MM-DD";
      syncLegacyTodayPattern();
      await save();
    }));

    el.createEl("h3", { text: t("Filter groups", "Groupes de filtres") });
    el.createEl("p", { text: t("Groups are combined with OR. Rules within each group use AND or OR.", "Les groupes sont combinés avec OU. Les règles d’un groupe utilisent ET ou OU."), cls: "setting-item-description" });
    const groupsHost = el.createDiv({ cls: "daily-review-filter-groups" });
    const renderGroups = () => {
      groupsHost.empty();
      this.plugin.settings.filterGroups.forEach((group, groupIndex) => {
        const groupEl = groupsHost.createDiv({ cls: "daily-review-filter-group" });
        const heading = groupEl.createDiv({ cls: "daily-review-filter-group-heading" });
        const nameInput = heading.createEl("input", { type: "text", placeholder: t("Group name", "Nom du groupe") }); nameInput.value = group.name;
        nameInput.addEventListener("change", async () => { group.name = nameInput.value || t(`Group ${groupIndex + 1}`, `Groupe ${groupIndex + 1}`); await save(); updateStatus(); });
        const matchSelect = heading.createEl("select");
        matchSelect.createEl("option", { attr: { value: "all" }, text: t("All rules (AND)", "Toutes les règles (ET)") });
        matchSelect.createEl("option", { attr: { value: "any" }, text: t("Any rule (OR)", "Au moins une règle (OU)") });
        matchSelect.value = group.match;
        matchSelect.addEventListener("change", async () => { group.match = matchSelect.value as "all" | "any"; await save(); updateStatus(); });
        const removeGroup = heading.createEl("button", { text: t("Remove group", "Supprimer le groupe") });
        removeGroup.addEventListener("click", async () => { this.plugin.settings.filterGroups.splice(groupIndex, 1); await save(); renderGroups(); });
        const status = groupEl.createDiv({ cls: "daily-review-filter-status" });
        const updateStatus = () => {
          const contradiction = this.plugin.groupContradiction(group);
          status.empty();
          status.createSpan({ text: `${this.plugin.getGroupCount(group)} ${t("notes match this group", "notes correspondent à ce groupe")}`, cls: "daily-review-filter-count" });
          if (contradiction) status.createDiv({ text: `⚠ ${contradiction}`, cls: "daily-review-filter-warning" });
        };
        group.rules.forEach((rule, ruleIndex) => {
          const row = groupEl.createDiv({ cls: "daily-review-filter-rule" });
          const field = row.createEl("select");
          const fieldNames: Array<[FilterField, string]> = [["created-days", t("Creation age", "Âge de création")], ["folder", t("Folder path", "Chemin du dossier")], ["tag", t("Tag", "Tag")], ["property", t("Property", "Propriété")]];
          fieldNames.forEach(([value, label]) => field.createEl("option", { attr: { value }, text: label })); field.value = rule.field;
          field.addEventListener("change", async () => { rule.field = field.value as FilterField; rule.operator = rule.field === "created-days" ? "at-least" : rule.field === "property" ? "exists" : "contains"; rule.value = ""; rule.propertyName = ""; await save(); renderGroups(); });
          const operator = row.createEl("select");
          const ops: Array<[FilterOperator, string]> = rule.field === "created-days" ? [["older-than", t("More than (days)", "Plus de (jours)")], ["at-least", t("At least (days)", "Au moins (jours)")], ["newer-than", t("Less than (days)", "Moins de (jours)")], ["at-most", t("At most (days)", "Au plus (jours)")], ["exactly", t("Exactly (days)", "Exactement (jours)")]]
            : rule.field === "property" ? [["exists", t("Exists", "Existe")], ["not-exists", t("Does not exist", "N’existe pas")], ["is-empty", t("Is empty", "Est vide")], ["is-not-empty", t("Is not empty", "N’est pas vide")], ["equals", t("Equals", "Égal à")], ["not-equals", t("Does not equal", "Différent de")], ["contains", t("Contains", "Contient")], ["not-contains", t("Does not contain", "Ne contient pas")], ["starts-with", t("Starts with", "Commence par")], ["not-starts-with", t("Does not start with", "Ne commence pas par")], ["ends-with", t("Ends with", "Se termine par")], ["not-ends-with", t("Does not end with", "Ne se termine pas par")], ["greater-than", t("Greater than", "Supérieur à")], ["less-than", t("Less than", "Inférieur à")], ["greater-or-equal", t("Greater than or equal", "Supérieur ou égal à")], ["less-or-equal", t("Less than or equal", "Inférieur ou égal à")]]
            : [["contains", t("Contains", "Contient")], ["not-contains", t("Does not contain", "Ne contient pas")], ["starts-with", t("Starts with", "Commence par")], ["not-starts-with", t("Does not start with", "Ne commence pas par")], ["ends-with", t("Ends with", "Se termine par")], ["not-ends-with", t("Does not end with", "Ne se termine pas par")], ["equals", t("Equals", "Égal à")], ["not-equals", t("Does not equal", "Différent de")]];
          ops.forEach(([value, label]) => operator.createEl("option", { attr: { value }, text: label })); operator.value = rule.operator;
          operator.addEventListener("change", async () => { rule.operator = operator.value as FilterOperator; await save(); updateStatus(); });
          if (rule.field === "property") {
            const propertyInput = makeInput(row, rule.propertyName ?? (rule.value.includes("=") ? rule.value.split("=")[0] : rule.operator === "exists" || rule.operator === "not-exists" ? rule.value : ""), t("Property name", "Nom de propriété"), this.plugin.getVaultSuggestions("properties"), value => { rule.propertyName = value; void save(); updateStatus(); });
            propertyInput.classList.add("daily-review-filter-property");
          }
          const needsValue = !["exists", "not-exists", "is-empty", "is-not-empty"].includes(rule.operator);
          const options: SuggestionSource = rule.field === "folder" ? this.plugin.getVaultSuggestions("folders") : rule.field === "tag" ? this.plugin.getVaultSuggestions("tags") : rule.field === "property" ? () => this.plugin.getVaultSuggestions("property-values", rule.propertyName ?? "") : [];
          const input = makeInput(row, rule.value.includes("=") && rule.field === "property" && !rule.propertyName ? rule.value.split("=").slice(1).join("=") : rule.value, rule.field === "created-days" ? "7" : t("Value", "Valeur"), options, value => { rule.value = value; void save(); updateStatus(); });
          input.disabled = !needsValue;
          const removeRule = row.createEl("button", { text: "×", attr: { "aria-label": t("Remove rule", "Supprimer la règle") } });
          removeRule.addEventListener("click", async () => { group.rules.splice(ruleIndex, 1); await save(); renderGroups(); });
        });
        const addRule = groupEl.createEl("button", { text: `+ ${t("Add rule", "Ajouter une règle")}` });
        addRule.addEventListener("click", async () => { group.rules.push({ field: "tag", operator: "contains", value: "" }); await save(); renderGroups(); });
        updateStatus();
      });
      const addGroup = groupsHost.createEl("button", { text: `+ ${t("Add filter group", "Ajouter un groupe de filtres")}` });
      addGroup.addEventListener("click", async () => { this.plugin.settings.filterGroups.push({ name: t(`Group ${this.plugin.settings.filterGroups.length + 1}`, `Groupe ${this.plugin.settings.filterGroups.length + 1}`), match: "all", rules: [] }); await save(); renderGroups(); });
    };
    renderGroups();

    el.createEl("h3", { text: t("Review header image", "Image d’en-tête de la revue") });
    new Setting(el).setName(t("Image source", "Source de l’image")).addDropdown(dropdown => dropdown.addOption("property", t("Frontmatter property", "Propriété frontmatter")).addOption("first-image", t("First image in note", "Première image de la note")).addOption("none", t("No image", "Aucune image")).setValue(this.plugin.settings.coverMode).onChange(async value => { this.plugin.settings.coverMode = value as ReviewSettings["coverMode"]; await save(); this.display(); }));
    if (this.plugin.settings.coverMode === "property") addSettingInput(el, t("Cover property", "Propriété de couverture"), this.plugin.settings.coverProperty, "cover", this.plugin.getVaultSuggestions("properties"), async value => { this.plugin.settings.coverProperty = value; await save(); });

    el.createEl("h3", { text: t("Action buttons", "Boutons d’action") });
    const actionsHost = el.createDiv();
    const renderActions = () => {
      actionsHost.empty();
      this.plugin.settings.actions.forEach((action, index) => {
        const section = actionsHost.createDiv({ cls: "daily-review-action-setting" });
        section.createEl("h4", { text: `${t("Action", "Action")} ${index + 1}` });
        new Setting(section).setName(t("Button label", "Nom du bouton")).addText(text => text.setValue(action.label).onChange(async value => { action.label = value; await save(); }));
        new Setting(section).setName(t("Action type", "Action à effectuer")).addDropdown(dropdown => {
          const types: Array<[ActionType, string]> = [["delete", t("Delete (move to trash)", "Supprimer (mettre à la corbeille)")], ["move", t("Move to folder", "Déplacer vers un dossier")], ["add-property", t("Add / edit property", "Ajouter / modifier une propriété")], ["add-tag", t("Add tag", "Ajouter un tag")], ["skip", t("Snooze for X days", "Reporter de X jours")], ["open", t("Open in background", "Ouvrir en arrière-plan")], ["append-today", t("Append link to today's note", "Ajouter un lien dans la note du jour")], ["template", t("Apply template", "Appliquer un modèle")]];
          types.forEach(([value, label]) => dropdown.addOption(value, label)); dropdown.setValue(action.type).onChange(async value => { action.type = value as ActionType; await save(); renderActions(); });
        });
        if (["move", "add-tag", "skip", "template"].includes(action.type)) {
          const name = action.type === "move" ? t("Destination folder", "Dossier de destination") : action.type === "add-tag" ? t("Tag to add", "Tag à ajouter") : action.type === "skip" ? t("Snooze for (days)", "Reporter de (jours)") : t("Template file", "Fichier modèle");
          const desc = action.type === "add-tag" ? t("Enter the tag with or without #; the plugin normalizes it.", "Saisissez le tag avec ou sans # ; le plugin le normalise.") : "";
          addSettingInput(section, name, action.value, action.type === "skip" ? "1" : "", action.type === "move" ? this.plugin.getVaultSuggestions("folders") : action.type === "template" ? this.plugin.getVaultSuggestions("templates") : action.type === "add-tag" ? this.plugin.getVaultSuggestions("tags") : [], async value => { action.value = value; await save(); }, desc);
        }
        if (action.type === "add-property") {
          addSettingInput(section, t("Property name", "Nom de la propriété"), action.propertyName ?? "", "status", this.plugin.getVaultSuggestions("properties"), async value => { action.propertyName = value; await save(); });
          addSettingInput(section, t("Property value", "Valeur de la propriété"), action.value, "", () => this.plugin.getVaultSuggestions("property-values", action.propertyName ?? ""), async value => { action.value = value; await save(); });
        }
        if (action.type === "append-today") {
          new Setting(section).setName(t("Insert at", "Insérer à")).addDropdown(dropdown => dropdown.addOption("start", t("Beginning", "Début")).addOption("end", t("End", "Fin")).addOption("after-text", t("After specific text", "Après un texte précis")).setValue(action.insertAt ?? "end").onChange(async value => { action.insertAt = value as ReviewAction["insertAt"]; await save(); renderActions(); }));
          if (action.insertAt === "after-text") new Setting(section).setName(t("Text to find", "Texte repère")).addText(text => text.setValue(action.anchorText ?? "").onChange(async value => { action.anchorText = value; await save(); }));
        }
        const iconSetting = new Setting(section).setName(t("Icon", "Icône"));
        iconSetting.addButton(button => {
          button.setTooltip(t("Choose an icon", "Choisir une icône")); setIcon(button.buttonEl, action.icon || "check");
          button.onClick(() => new IconPickerModal(this.app, this.plugin, action.icon, async icon => { action.icon = icon; await save(); this.display(); }).open());
        });
        const colors = section.createDiv({ cls: "daily-review-color-row" });
        for (const [key, label] of [["colorText", t("Text color", "Couleur du texte")], ["colorBackground", t("Button background", "Fond du bouton")]] as const) {
          const wrapper = colors.createEl("label", { cls: "daily-review-color-control" }); wrapper.createSpan({ text: label });
          const picker = wrapper.createEl("input", { type: "color" }); picker.value = action[key] || (key === "colorText" ? "#000000" : "#ffffff");
          picker.addEventListener("input", () => { action[key] = picker.value; void save(); });
          const reset = wrapper.createEl("button", { text: t("Reset", "Réinitialiser") }); reset.addEventListener("click", async (evt: MouseEvent) => { evt.preventDefault(); action[key] = key === "colorText" ? "#000000" : "#ffffff"; await save(); renderActions(); });
        }
        new Setting(section).setName(t("Shortcut", "Raccourci")).setDesc(t("Record a key combination; use Cmd on Mac or Ctrl on Windows.", "Enregistrez une combinaison ; Cmd sur Mac ou Ctrl sur Windows.")).addButton(button => {
          button.setButtonText(action.shortcut || t("Record shortcut", "Enregistrer un raccourci"));
          button.onClick(() => {
            button.setButtonText(t("Press shortcut…", "Appuyez sur le raccourci…"));
            const listener = async (evt: KeyboardEvent) => {
              evt.preventDefault(); evt.stopPropagation();
              if (["Meta", "Control", "Shift", "Alt"].includes(evt.key)) return;
              window.removeEventListener("keydown", listener, true);
              action.shortcut = [evt.metaKey || evt.ctrlKey ? "mod" : "", evt.altKey ? "alt" : "", evt.shiftKey ? "shift" : "", evt.key.toLowerCase()].filter(Boolean).join("+");
              await save(); renderActions();
            };
            window.addEventListener("keydown", listener, true);
          });
        });
        new Setting(section).addButton(button => button.setButtonText(t("Reset shortcut", "Réinitialiser le raccourci")).onClick(async () => { action.shortcut = ""; await save(); renderActions(); }));
        if (action.type !== "delete" && action.type !== "skip" && action.type !== "open") {
          const stepsHost = section.createDiv({ cls: "daily-review-action-steps" });
          action.steps ??= [];
          action.steps.forEach((step, stepIndex) => {
            const row = stepsHost.createDiv({ cls: "daily-review-action-step" });
            const select = row.createEl("select");
            ([["move", t("Move to folder", "Déplacer vers un dossier")], ["add-tag", t("Add tag", "Ajouter un tag")], ["add-property", t("Set property", "Modifier une propriété")]] as Array<[ActionStep["type"], string]>).forEach(([value, label]) => select.createEl("option", { attr: { value }, text: label }));
            select.value = step.type;
            select.addEventListener("change", async () => { step.type = select.value as ActionStep["type"]; step.value = ""; step.propertyName = ""; await save(); renderActions(); });
            if (step.type === "add-property") makeInput(row, step.propertyName ?? "", t("Property", "Propriété"), this.plugin.getVaultSuggestions("properties"), value => { step.propertyName = value; void save(); });
            makeInput(row, step.value, step.type === "move" ? t("Folder", "Dossier") : step.type === "add-tag" ? t("Tag (with or without #)", "Tag (avec ou sans #)") : t("Value", "Valeur"), step.type === "move" ? this.plugin.getVaultSuggestions("folders") : step.type === "add-tag" ? this.plugin.getVaultSuggestions("tags") : () => this.plugin.getVaultSuggestions("property-values", step.propertyName ?? ""), value => { step.value = value; void save(); });
            const remove = row.createEl("button", { text: "×" }); remove.addEventListener("click", async () => { action.steps.splice(stepIndex, 1); await save(); renderActions(); });
          });
          new Setting(stepsHost).addButton(button => button.setButtonText(t("+ Combine another action", "+ Combiner une autre action")).onClick(async () => { action.steps.push({ type: "add-tag", value: "" }); await save(); renderActions(); }));
        }
        new Setting(section).addButton(button => button.setButtonText(t("Remove action", "Supprimer ce bouton")).setWarning().onClick(async () => { this.plugin.settings.actions.splice(index, 1); await save(); renderActions(); }));
      });
      new Setting(actionsHost).addButton(button => button.setButtonText(t("+ Add action button", "+ Ajouter un bouton")).onClick(async () => { this.plugin.settings.actions.push(actionFrom({ label: t("New action", "Nouvelle action"), type: "move", value: "To review", icon: "check" }, this.plugin.settings.actions.length)); await save(); renderActions(); }));
    };
    renderActions();
  }
}
