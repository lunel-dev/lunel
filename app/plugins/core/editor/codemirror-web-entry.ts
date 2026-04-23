import { Compartment, EditorState } from "@codemirror/state";
import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { csharp } from "@replit/codemirror-lang-csharp";
import { elixir } from "codemirror-lang-elixir";
import { tags as t } from "@lezer/highlight";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { kotlin, objectiveC, objectiveCpp, scala } from "@codemirror/legacy-modes/mode/clike";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { erlang } from "@codemirror/legacy-modes/mode/erlang";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { julia } from "@codemirror/legacy-modes/mode/julia";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { oCaml } from "@codemirror/legacy-modes/mode/mllike";
import { r } from "@codemirror/legacy-modes/mode/r";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { sass } from "@codemirror/legacy-modes/mode/sass";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  RegExpCursor,
  replaceAll,
  replaceNext,
  search,
  searchKeymap,
  SearchCursor,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";

interface CreateEditorOptions {
  parent: HTMLElement;
  value: string;
  fileName: string;
  isDark: boolean;
  wrapLines: boolean;
  readOnly: boolean;
  placeholderText: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  backgroundColor: string;
  foregroundColor: string;
  caretColor: string;
  selectionColor: string;
  gutterBackgroundColor: string;
  gutterForegroundColor: string;
  activeLineColor: string;
  onChange: (value: string) => void;
}

declare global {
  interface Window {
    __lunelCreateCodeMirrorEditor?: (options: CreateEditorOptions) => {
      getValue: () => string;
      setValue: (value: string) => void;
      setFileName: (fileName: string) => void;
      setWrapLines: (wrapLines: boolean) => void;
      setReadOnly: (readOnly: boolean) => void;
      openSearch: () => void;
      closeSearch: () => void;
      setSearchQuery: (search: string, replace: string) => void;
      findNext: () => void;
      findPrev: () => void;
      replaceNext: () => void;
      replaceAll: () => void;
      getSearchInfo: () => { current: number; total: number };
      focus: () => void;
      blur: () => void;
    };
  }
}

function getLanguageExtension(fileName: string) {
  const normalized = fileName.toLowerCase();

  if (
    normalized.endsWith(".js") ||
    normalized.endsWith(".mjs") ||
    normalized.endsWith(".cjs")
  ) {
    return javascript();
  }

  if (
    normalized.endsWith(".ts") ||
    normalized.endsWith(".mts") ||
    normalized.endsWith(".cts")
  ) {
    return javascript({ typescript: true });
  }

  if (normalized.endsWith(".jsx")) {
    return javascript({ jsx: true });
  }

  if (normalized.endsWith(".tsx")) {
    return javascript({ jsx: true, typescript: true });
  }

  if (normalized.endsWith(".json") || normalized.endsWith(".jsonc")) {
    return json();
  }

  if (normalized.endsWith(".xml") || normalized.endsWith(".xsd") || normalized.endsWith(".xsl") || normalized.endsWith(".xslt") || normalized.endsWith(".svg") || normalized.endsWith(".plist") || normalized.endsWith(".rss") || normalized.endsWith(".atom")) {
    return xml();
  }

  if (normalized.endsWith(".md") || normalized.endsWith(".markdown")) {
    return markdown();
  }

  if (normalized.endsWith(".py")) {
    return python();
  }

  if (
    normalized.endsWith(".html") ||
    normalized.endsWith(".htm") ||
    normalized.endsWith(".xhtml")
  ) {
    return html();
  }

  if (normalized.endsWith(".css")) {
    return css();
  }

  if (normalized.endsWith(".scss") || normalized.endsWith(".sass")) {
    return StreamLanguage.define(sass);
  }

  if (normalized.endsWith(".yaml") || normalized.endsWith(".yml")) {
    return yaml();
  }

  if (normalized.endsWith(".toml")) {
    return StreamLanguage.define(toml);
  }

  if (normalized.endsWith(".php")) {
    return php();
  }

  if (normalized.endsWith(".java")) {
    return java();
  }

  if (normalized.endsWith(".rs")) {
    return rust();
  }

  if (normalized.endsWith(".sql")) {
    return sql();
  }

  if (normalized.endsWith(".go")) {
    return go();
  }

  if (normalized.endsWith(".pyw") || normalized.endsWith(".pyi")) {
    return python();
  }

  if (
    normalized.endsWith(".rb") ||
    normalized.endsWith(".rake") ||
    normalized.endsWith(".gemspec") ||
    normalized.endsWith(".ru")
  ) {
    return StreamLanguage.define(ruby);
  }

  if (normalized.endsWith(".r")) {
    return StreamLanguage.define(r);
  }

  if (
    normalized.endsWith(".clj") ||
    normalized.endsWith(".cljs") ||
    normalized.endsWith(".cljc") ||
    normalized.endsWith(".edn")
  ) {
    return StreamLanguage.define(clojure);
  }

  if (
    normalized.endsWith(".cs") ||
    normalized.endsWith(".csx")
  ) {
    return csharp();
  }

  if (
    normalized.endsWith(".ex") ||
    normalized.endsWith(".exs") ||
    normalized.endsWith(".eex") ||
    normalized.endsWith(".heex") ||
    normalized.endsWith(".leex")
  ) {
    return elixir();
  }

  if (
    normalized.endsWith(".erl") ||
    normalized.endsWith(".hrl")
  ) {
    return StreamLanguage.define(erlang);
  }

  if (
    normalized.endsWith(".groovy") ||
    normalized.endsWith(".gradle") ||
    normalized.endsWith(".gvy") ||
    normalized.endsWith(".gy") ||
    normalized.endsWith(".gsh")
  ) {
    return StreamLanguage.define(groovy);
  }

  if (
    normalized.endsWith(".hs") ||
    normalized.endsWith(".lhs")
  ) {
    return StreamLanguage.define(haskell);
  }

  if (normalized.endsWith(".jl")) {
    return StreamLanguage.define(julia);
  }

  if (
    normalized.endsWith(".kt") ||
    normalized.endsWith(".kts")
  ) {
    return StreamLanguage.define(kotlin);
  }

  if (
    normalized.endsWith(".lua") ||
    normalized.endsWith(".rockspec")
  ) {
    return StreamLanguage.define(lua);
  }

  if (
    normalized.endsWith(".m") ||
    normalized.endsWith(".mm")
  ) {
    return StreamLanguage.define(normalized.endsWith(".mm") ? objectiveCpp : objectiveC);
  }

  if (
    normalized.endsWith(".ml") ||
    normalized.endsWith(".mli") ||
    normalized.endsWith(".mll") ||
    normalized.endsWith(".mly")
  ) {
    return StreamLanguage.define(oCaml);
  }

  if (
    normalized.endsWith(".sh") ||
    normalized.endsWith(".bash") ||
    normalized.endsWith(".zsh") ||
    normalized.endsWith(".ksh") ||
    normalized.endsWith(".fish")
  ) {
    return StreamLanguage.define(shell);
  }

  if (
    normalized.endsWith(".scala") ||
    normalized.endsWith(".sc") ||
    normalized.endsWith(".sbt")
  ) {
    return StreamLanguage.define(scala);
  }

  if (
    normalized.endsWith(".diff") ||
    normalized.endsWith(".patch")
  ) {
    return StreamLanguage.define(diff);
  }

  if (
    normalized.endsWith(".c") ||
    normalized.endsWith(".cc") ||
    normalized.endsWith(".cpp") ||
    normalized.endsWith(".cxx") ||
    normalized.endsWith(".h") ||
    normalized.endsWith(".hpp") ||
    normalized.endsWith(".hh") ||
    normalized.endsWith(".hxx")
  ) {
    return cpp();
  }
  return [];
}

function createSyntaxHighlightStyle(isDark: boolean) {
  const palette = isDark
    ? {
        keyword: "#c792ea",
        string: "#c3e88d",
        number: "#f78c6c",
        comment: "#7f848e",
        function: "#82aaff",
        type: "#ffcb6b",
        variable: "#f07178",
        property: "#89ddff",
        operator: "#89ddff",
        punctuation: "#bfc7d5",
      }
    : {
        keyword: "#7c3aed",
        string: "#15803d",
        number: "#c2410c",
        comment: "#6b7280",
        function: "#1d4ed8",
        type: "#b45309",
        variable: "#be123c",
        property: "#0f766e",
        operator: "#0f766e",
        punctuation: "#4b5563",
      };

  return HighlightStyle.define([
    { tag: [t.keyword, t.modifier, t.controlKeyword], color: palette.keyword },
    { tag: [t.string, t.special(t.string), t.regexp], color: palette.string },
    { tag: [t.number, t.integer, t.float, t.bool, t.null], color: palette.number },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: palette.comment, fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.labelName], color: palette.function },
    { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: palette.type },
    { tag: [t.variableName, t.name, t.attributeName], color: palette.variable },
    { tag: [t.propertyName], color: palette.property },
    { tag: [t.operator, t.compareOperator, t.logicOperator, t.arithmeticOperator], color: palette.operator },
    { tag: [t.punctuation, t.separator, t.bracket, t.angleBracket], color: palette.punctuation },
  ]);
}

function createTheme(options: CreateEditorOptions) {
  return EditorView.theme({
    "&": {
      height: "100%",
      backgroundColor: options.backgroundColor,
      color: options.foregroundColor,
      fontFamily: options.fontFamily,
      fontSize: `${options.fontSize}px`,
    },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: options.fontFamily,
      lineHeight: `${options.lineHeight}px`,
    },
    ".cm-content, .cm-gutter": {
      minHeight: "100%",
    },
    ".cm-content": {
      padding: "14px 0",
      caretColor: options.caretColor,
    },
    ".cm-line": {
      padding: "0 16px",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: options.caretColor,
    },
    ".cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: options.selectionColor,
    },
    ".cm-activeLine, .cm-activeLineGutter": {
      backgroundColor: options.activeLineColor,
    },
    ".cm-gutters": {
      backgroundColor: options.gutterBackgroundColor,
      color: options.gutterForegroundColor,
      border: "none",
      paddingRight: "8px",
    },
    ".cm-gutterElement": {
      padding: "0 8px 0 12px",
    },
    ".cm-placeholder": {
      color: options.gutterForegroundColor,
    },
    ".cm-focused": {
      outline: "none",
    },
    ".cm-panels": {
      backgroundColor: options.gutterBackgroundColor,
      color: options.foregroundColor,
    },
    ".cm-panels-top": {
      borderBottom: "none",
    },
    ".cm-panel": {
      padding: "10px 12px",
      fontFamily: options.fontFamily,
      fontSize: `${Math.max(12, options.fontSize - 1)}px`,
    },
    ".cm-search": {
      display: "flex",
      gap: "8px",
      alignItems: "center",
      flexWrap: "wrap",
    },
    ".cm-search input, .cm-search button, .cm-search label": {
      fontFamily: options.fontFamily,
      fontSize: `${Math.max(12, options.fontSize - 1)}px`,
    },
    ".cm-search input": {
      backgroundColor: options.backgroundColor,
      color: options.foregroundColor,
      border: "none",
      borderRadius: "8px",
      padding: "8px 10px",
      outline: "none",
    },
    ".cm-search button": {
      backgroundColor: options.activeLineColor,
      color: options.foregroundColor,
      border: "none",
      borderRadius: "8px",
      padding: "8px 10px",
    },
    ".cm-button": {
      backgroundImage: "none !important",
    },
    ".cm-search .cm-textfield": {
      margin: 0,
    },
  });
}

window.__lunelCreateCodeMirrorEditor = function createCodeMirrorEditor(options: CreateEditorOptions) {
  const editableCompartment = new Compartment();
  const languageCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();
  const wrappingCompartment = new Compartment();

  let suppressChanges = false;

  const state = EditorState.create({
    doc: options.value,
    extensions: [
      lineNumbers(),
      history(),
      drawSelection(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      placeholder(options.placeholderText),
      search({ top: true }),
      wrappingCompartment.of(options.wrapLines ? EditorView.lineWrapping : []),
      syntaxHighlighting(createSyntaxHighlightStyle(options.isDark), { fallback: true }),
      keymap.of([indentWithTab, ...searchKeymap, ...defaultKeymap, ...historyKeymap]),
      createTheme(options),
      languageCompartment.of(getLanguageExtension(options.fileName)),
      readOnlyCompartment.of(EditorState.readOnly.of(options.readOnly)),
      editableCompartment.of(EditorView.editable.of(!options.readOnly)),
      EditorView.updateListener.of((update) => {
        if (suppressChanges || !update.docChanged) {
          return;
        }

        options.onChange(update.state.doc.toString());
      }),
    ],
  });

  const view = new EditorView({
    state,
    parent: options.parent,
  });

  function runCommand(command: (target: EditorView) => boolean) {
    command(view);
  }

  function updateSearchQuery(searchText: string, replaceText: string) {
    view.dispatch({
      effects: setSearchQuery.of(new SearchQuery({
        search: searchText,
        replace: replaceText,
      })),
    });
  }

  function getSearchInfo() {
    const query = getSearchQuery(view.state);
    if (!query.search || !query.valid) {
      return { current: 0, total: 0 };
    }

    const cursor = query.getCursor(view.state) as SearchCursor | RegExpCursor;
    const matches: Array<{ from: number; to: number }> = [];
    for (cursor.next(); !cursor.done; cursor.next()) {
      matches.push({ from: cursor.value.from, to: cursor.value.to });
    }
    if (matches.length === 0) {
      return { current: 0, total: 0 };
    }

    const mainSelection = view.state.selection.main;
    const currentIndex = matches.findIndex(
      (match) => match.from === mainSelection.from && match.to === mainSelection.to
    );

    return {
      current: currentIndex >= 0 ? currentIndex + 1 : 0,
      total: matches.length,
    };
  }

  return {
    getValue() {
      return view.state.doc.toString();
    },
    setValue(value: string) {
      const currentValue = view.state.doc.toString();
      if (currentValue === value) {
        return;
      }

      suppressChanges = true;
      view.dispatch({
        changes: { from: 0, to: currentValue.length, insert: value },
      });
      suppressChanges = false;
    },
    setFileName(fileName: string) {
      view.dispatch({
        effects: languageCompartment.reconfigure(getLanguageExtension(fileName)),
      });
    },
    setWrapLines(wrapLines: boolean) {
      view.dispatch({
        effects: wrappingCompartment.reconfigure(wrapLines ? EditorView.lineWrapping : []),
      });
    },
    setReadOnly(readOnly: boolean) {
      view.dispatch({
        effects: [
          readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
          editableCompartment.reconfigure(EditorView.editable.of(!readOnly)),
        ],
      });
    },
    openSearch() {
      openSearchPanel(view);
    },
    closeSearch() {
      runCommand(closeSearchPanel);
      updateSearchQuery("", "");
    },
    setSearchQuery(searchText: string, replaceText: string) {
      updateSearchQuery(searchText, replaceText);
    },
    findNext() {
      runCommand(findNext);
    },
    findPrev() {
      runCommand(findPrevious);
    },
    replaceNext() {
      runCommand(replaceNext);
    },
    replaceAll() {
      runCommand(replaceAll);
    },
    getSearchInfo() {
      return getSearchInfo();
    },
    focus() {
      view.focus();
    },
    blur() {
      view.contentDOM.blur();
    },
  };
};
