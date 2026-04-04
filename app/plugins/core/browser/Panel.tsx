import Loading from "@/components/Loading";
import PluginHeader, { usePluginHeaderHeight } from "@/components/PluginHeader";
import { useConnection } from "@/contexts/ConnectionContext";
import { useSessionRegistryActions } from "@/contexts/SessionRegistry";
import { useTheme } from "@/contexts/ThemeContext";
import { typography } from "@/constants/themes";
import { X, ArrowLeft, ArrowRight, RotateCw, Search, Globe, Plus, Maximize2, Minimize2, Code, LayoutPanelTop, ArrowDown, ArrowUp, SquareMousePointer } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  InputAccessoryView,
  InteractionManager,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { WebView } from "react-native-webview";
import { PluginPanelProps } from "../../types";
import ConsoleSection from "./devsole/ConsoleSection";
import ElementsSection from "./devsole/ElementsSection";
import InfoSection from "./devsole/InfoSection";
import NetworkSection from "./devsole/NetworkSection";
import ProxiesSection from "./devsole/ProxiesSection";
import ResourcesSection from "./devsole/ResourcesSection";
import {
  DevsoleConsoleEntry,
  DevsoleElementsSnapshot,
  DevsoleInfoSnapshot,
  DevsoleNetworkEntry,
  DevsoleResourcesSnapshot,
  DevsoleSectionId,
} from "./devsole/types";

interface Tab {
  id: string;
  title: string;
  url: string;
  loading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  favicon?: string;
  ready?: boolean;
}

interface DevsoleTabState {
  open: boolean;
  section: DevsoleSectionId;
  expanded: boolean;
}

function getDefaultDevsoleState(): DevsoleTabState {
  return {
    open: false,
    section: "console",
    expanded: false,
  };
}

const DEVSOLE_SECTIONS: { id: DevsoleSectionId; label: string; hint: string }[] = [
  { id: "console", label: "Console", hint: "Runtime logs and JS evaluation" },
  { id: "network", label: "Network", hint: "Requests, timings, and payload drill-in" },
  { id: "elements", label: "Elements", hint: "DOM and inspection primitives" },
  { id: "resources", label: "Resources", hint: "Storage, cookies, and cached state" },
  { id: "info", label: "Info", hint: "Session and page diagnostics" },
  { id: "proxies", label: "Proxies", hint: "Tracked localhost proxy ports" },
];

const DEVSOLE_STUBS: Record<
  DevsoleSectionId,
  {
    eyebrow: string;
    title: string;
    description: string;
    bullets: string[];
    metrics: { label: string; value: string }[];
  }
> = {
  console: {
    eyebrow: "Structured logs",
    title: "Console will stream native log rows here",
    description:
      "This panel is reserved for level filters, search, expandable values, and high-volume log rendering that feels native inside the browser plugin.",
    bullets: [
      "Levels for verbose, info, warning, and error",
      "Expandable structured values and stack traces",
      "FlashList-backed rows once real collection lands",
    ],
    metrics: [
      { label: "Rows", value: "0 stub" },
      { label: "Filters", value: "4 planned" },
      { label: "Renderer", value: "Native" },
    ],
  },
  network: {
    eyebrow: "Request timeline",
    title: "Network will show requests and drill-in detail",
    description:
      "The first real version will prioritize stable request capture, compact list rendering, and reliable detail sections for headers, bodies, and responses.",
    bullets: [
      "Method, status, type, size, and duration",
      "Request detail for headers and payloads",
      "Safe handling when metadata is partial",
    ],
    metrics: [
      { label: "Requests", value: "0 stub" },
      { label: "Selection", value: "Ready" },
      { label: "Payloads", value: "Later" },
    ],
  },
  elements: {
    eyebrow: "Inspection scope",
    title: "Elements is scoped before implementation",
    description:
      "We are not copying desktop devtools blindly. This section will expose only what the app browser can support reliably and cleanly.",
    bullets: [
      "Select only the primitives we can support well",
      "Fallback UI if live inspection is limited",
      "Breadcrumb and detail surfaces reserved in the layout",
    ],
    metrics: [
      { label: "Mode", value: "Scoping" },
      { label: "Overlay", value: "TBD" },
      { label: "Fallback", value: "Required" },
    ],
  },
  resources: {
    eyebrow: "Storage and assets",
    title: "Resources will group browser-owned data",
    description:
      "This section is reserved for cookies, local storage, session storage, and other resource snapshots that the browser plugin can expose safely.",
    bullets: [
      "Sectioned cards instead of web-style tables",
      "Copy-friendly key/value presentation",
      "Stable empty and refresh states first",
    ],
    metrics: [
      { label: "Stores", value: "3 planned" },
      { label: "Refresh", value: "Manual" },
      { label: "Export", value: "Later" },
    ],
  },
  info: {
    eyebrow: "Session diagnostics",
    title: "Info stays compact and high-signal",
    description:
      "This panel will show the metadata that helps orient the rest of devsole quickly without turning into a dumping ground.",
    bullets: [
      "Current page and session context",
      "Platform and runtime diagnostics",
      "Fast copy actions for debugging later",
    ],
    metrics: [
      { label: "Fields", value: "Lean" },
      { label: "Latency", value: "Low" },
      { label: "Purpose", value: "Orientation" },
    ],
  },
  proxies: {
    eyebrow: "Localhost forwarding",
    title: "Proxy tracking is managed globally",
    description:
      "Custom localhost ports are tracked once for the whole app session, not per browser tab, so this section stays shared while the rest of devsole remains page-specific.",
    bullets: [
      "Track extra localhost ports beyond the built-in dev scan list",
      "See which tracked ports are currently open on the CLI machine",
      "Bring up phone localhost listeners after the CLI confirms state",
    ],
    metrics: [
      { label: "Scope", value: "Global" },
      { label: "Action", value: "Track" },
      { label: "Listener", value: "Auto" },
    ],
  },
};

export default function BrowserPanel({ bottomBarHeight }: PluginPanelProps) {
  const { colors, radius, fonts, isDark } = useTheme();
  const { discoveredProxyPorts, trackedProxyPorts, refreshProxyState, trackProxyPort, untrackProxyPort } = useConnection();
  const headerHeight = usePluginHeaderHeight();
  const { register, unregister } = useSessionRegistryActions();
  const { height: windowHeight } = useWindowDimensions();

  const [tabs, setTabs] = useState<Tab[]>([]);

  const [activeTabId, setActiveTabId] = useState<string>("");
  const [urlInput, setUrlInput] = useState("");
  const [devsoleStateByTab, setDevsoleStateByTab] = useState<Record<string, DevsoleTabState>>({});
  const [browserViewportHeight, setBrowserViewportHeight] = useState(0);
  const [consoleEntriesByTab, setConsoleEntriesByTab] = useState<Record<string, DevsoleConsoleEntry[]>>({});
  const [networkEntriesByTab, setNetworkEntriesByTab] = useState<Record<string, DevsoleNetworkEntry[]>>({});
  const [elementsSnapshotByTab, setElementsSnapshotByTab] = useState<Record<string, DevsoleElementsSnapshot | null>>({});
  const [resourcesSnapshotByTab, setResourcesSnapshotByTab] = useState<Record<string, DevsoleResourcesSnapshot | null>>({});
  const [infoSnapshotByTab, setInfoSnapshotByTab] = useState<Record<string, DevsoleInfoSnapshot | null>>({});
  const [elementsInspectingByTab, setElementsInspectingByTab] = useState<Record<string, boolean>>({});
  const [elementsFocusByTab, setElementsFocusByTab] = useState<Record<string, { path: string; token: number } | null>>({});
  const [proxyMutationPending, setProxyMutationPending] = useState(false);
  const [proxySectionError, setProxySectionError] = useState<string | null>(null);

  const displayUrl = (url: string) => url.replace(/\/$/, "");
  const [isFocused, setIsFocused] = useState(false);
  const [focusSelection, setFocusSelection] = useState<{ start: number; end: number } | undefined>(undefined);

  const webViewRefs = useRef<{ [key: string]: WebView | null }>({});
  const urlInputRef = useRef<TextInput>(null);
  const pageUrlByTabRef = useRef<Record<string, string>>({ "1": "https://www.google.com" });

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activeDevsoleState = devsoleStateByTab[activeTabId] || getDefaultDevsoleState();
  const devsoleOpen = activeDevsoleState.open;
  const activeDevsoleSection = activeDevsoleState.section;
  const devsoleExpanded = activeDevsoleState.expanded;
  const activeDevsoleStub = DEVSOLE_STUBS[activeDevsoleSection];
  const activeConsoleEntries = consoleEntriesByTab[activeTabId] || [];
  const activeNetworkEntries = networkEntriesByTab[activeTabId] || [];
  const activeElementsSnapshot = elementsSnapshotByTab[activeTabId] || null;
  const activeResourcesSnapshot = resourcesSnapshotByTab[activeTabId] || null;
  const activeInfoSnapshot = infoSnapshotByTab[activeTabId] || null;
  const activeElementsInspecting = !!elementsInspectingByTab[activeTabId];
  const activeElementsFocus = elementsFocusByTab[activeTabId] || null;
  const fallbackViewportHeight = Math.max(0, windowHeight);
  const availableDevsoleHeight = browserViewportHeight || fallbackViewportHeight;
  const maxDevsoleHeight = Math.max(280, availableDevsoleHeight - 70);
  const fullDevsoleHeight = maxDevsoleHeight;
  const collapsedDevsoleHeight = Math.max(280, Math.round(fullDevsoleHeight * 0.5));
  const expandedDevsoleHeight = fullDevsoleHeight;
  const devsoleHeight = useSharedValue(collapsedDevsoleHeight);

  useEffect(() => {
    devsoleHeight.value = withTiming(
      devsoleExpanded ? expandedDevsoleHeight : collapsedDevsoleHeight,
      {
        duration: 240,
      }
    );
  }, [collapsedDevsoleHeight, devsoleExpanded, devsoleHeight, expandedDevsoleHeight]);

  const devsoleAnimatedStyle = useAnimatedStyle(() => ({
    height: devsoleHeight.value,
  }));

  // Script to set up Trusted Types policy before page loads
  const trustedTypesSetupScript = `
    (function() {
      if (window.trustedTypes && trustedTypes.createPolicy) {
        try {
          if (!trustedTypes.defaultPolicy) {
            trustedTypes.createPolicy('default', {
              createHTML: (string) => string,
              createScript: (string) => string,
              createScriptURL: (string) => string,
            });
          }
        } catch (e) {}
      }
    })();
    true;
  `;

  const devsoleConsoleBootstrapScript = `
    (function() {
      if (window.__LUNEL_DEVSOLE_CONSOLE__) return;
      window.__LUNEL_DEVSOLE_CONSOLE__ = true;

      function post(payload) {
        try {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'devsole-console',
            payload: payload
          }));
        } catch (error) {}
      }

      function serialize(value, depth, seen) {
        if (depth === undefined) depth = 0;
        if (!seen) seen = [];

        if (value === null) return { type: 'null', preview: 'null' };
        if (value === undefined) return { type: 'undefined', preview: 'undefined' };

        var type = typeof value;

        if (type === 'string') return { type: 'string', preview: value };
        if (type === 'number' || type === 'boolean' || type === 'bigint') {
          return { type: type, preview: String(value) };
        }
        if (type === 'symbol') return { type: 'symbol', preview: String(value) };
        if (type === 'function') {
          return {
            type: 'function',
            preview: value.name ? '[Function ' + value.name + ']' : '[Function anonymous]'
          };
        }

        if (seen.indexOf(value) >= 0) {
          return { type: 'unknown', preview: '[Circular]' };
        }
        seen.push(value);

        try {
          if (value instanceof Date) {
            return { type: 'date', preview: value.toISOString() };
          }

          if (value instanceof Error) {
            return {
              type: 'error',
              preview: (value.name || 'Error') + ': ' + (value.message || ''),
              stack: value.stack || null
            };
          }

          if (Array.isArray(value)) {
            if (depth >= 1) {
              return { type: 'array', preview: '[Array(' + value.length + ')]' };
            }

            var arrayPreview = value.slice(0, 5).map(function(item) {
              return serialize(item, depth + 1, seen.slice()).preview;
            }).join(', ');

            if (value.length > 5) arrayPreview += ', ...';
            return {
              type: 'array',
              preview: '[' + arrayPreview + ']'
            };
          }

          if (depth >= 1) {
            var ctor = value && value.constructor && value.constructor.name ? value.constructor.name : 'Object';
            return { type: 'object', preview: '[' + ctor + ']' };
          }

          var keys = Object.keys(value).slice(0, 5);
          var objectPreview = keys.map(function(key) {
            return key + ': ' + serialize(value[key], depth + 1, seen.slice()).preview;
          }).join(', ');

          if (Object.keys(value).length > 5) objectPreview += ', ...';

          return {
            type: 'object',
            preview: '{' + objectPreview + '}'
          };
        } catch (error) {
          return { type: 'unknown', preview: '[Unserializable]' };
        }
      }

      function push(level, source, args, stack) {
        post({
          id: String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8),
          level: level,
          source: source,
          timestamp: Date.now(),
          values: (args || []).map(function(arg) {
            return serialize(arg, 0, []);
          }),
          stack: stack || null
        });
      }

      ['log', 'info', 'warn', 'error', 'debug'].forEach(function(level) {
        var original = console[level];
        console[level] = function() {
          var args = Array.prototype.slice.call(arguments);
          try {
            push(level, 'console', args, null);
          } catch (error) {}
          return original && original.apply(console, args);
        };
      });

      window.addEventListener('error', function(event) {
        push('error', 'error', [event.message || 'Unhandled error'], event.error && event.error.stack ? event.error.stack : null);
      });

      window.addEventListener('unhandledrejection', function(event) {
        var reason = event.reason;
        var stack = reason && reason.stack ? reason.stack : null;
        push('error', 'promise', [reason || 'Unhandled promise rejection'], stack);
      });
    })();
    true;
  `;

  const devsoleNetworkBootstrapScript = `
    (function() {
      if (window.__LUNEL_DEVSOLE_NETWORK__) return;
      window.__LUNEL_DEVSOLE_NETWORK__ = true;

      function post(payload) {
        try {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'devsole-network',
            payload: payload
          }));
        } catch (error) {}
      }

      function previewText(value, maxLength) {
        if (value == null) return null;
        var limit = typeof maxLength === 'number' ? maxLength : 280;
        if (typeof value === 'string') return value.slice(0, limit);
        try {
          return JSON.stringify(value).slice(0, limit);
        } catch (error) {
          return String(value).slice(0, limit);
        }
      }

      function toType(contentType) {
        if (!contentType) return 'unknown';
        return String(contentType).split(';')[0];
      }

      var originalFetch = window.fetch;
      if (originalFetch) {
        window.fetch = function(input, init) {
          var method = init && init.method ? String(init.method).toUpperCase() : 'GET';
          var url = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
          var id = 'fetch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
          var startedAt = Date.now();
          var requestBody = init && init.body ? previewText(init.body) : null;

          post({
            id: id,
            url: url,
            method: method,
            status: null,
            ok: null,
            type: 'pending',
            startedAt: startedAt,
            durationMs: null,
            requestBody: requestBody,
            responsePreview: null,
            responseBody: null,
            error: null
          });

          return originalFetch.apply(this, arguments).then(function(response) {
            var clone = response.clone();
            return clone.text().then(function(text) {
              post({
                id: id,
                url: url,
                method: method,
                status: response.status,
                ok: response.ok,
                type: toType(response.headers.get('content-type')),
                startedAt: startedAt,
                durationMs: Date.now() - startedAt,
                requestBody: requestBody,
                responsePreview: previewText(text, 280),
                responseBody: previewText(text, 12000),
                error: null
              });
              return response;
            }).catch(function() {
              post({
                id: id,
                url: url,
                method: method,
                status: response.status,
                ok: response.ok,
                type: toType(response.headers.get('content-type')),
                startedAt: startedAt,
                durationMs: Date.now() - startedAt,
                requestBody: requestBody,
                responsePreview: null,
                responseBody: null,
                error: null
              });
              return response;
            });
          }).catch(function(error) {
            post({
              id: id,
              url: url,
              method: method,
              status: null,
              ok: false,
              type: 'error',
              startedAt: startedAt,
              durationMs: Date.now() - startedAt,
              requestBody: requestBody,
              responsePreview: null,
              responseBody: null,
              error: error && error.message ? error.message : String(error)
            });
            throw error;
          });
        };
      }

      var OriginalXHR = window.XMLHttpRequest;
      if (OriginalXHR) {
        var open = OriginalXHR.prototype.open;
        var send = OriginalXHR.prototype.send;

        OriginalXHR.prototype.open = function(method, url) {
          this.__devsole = {
            id: 'xhr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
            method: method ? String(method).toUpperCase() : 'GET',
            url: String(url),
            startedAt: Date.now(),
            requestBody: null
          };
          return open.apply(this, arguments);
        };

        OriginalXHR.prototype.send = function(body) {
          var meta = this.__devsole || {
            id: 'xhr-' + Date.now(),
            method: 'GET',
            url: '',
            startedAt: Date.now(),
            requestBody: null
          };
          meta.requestBody = previewText(body);
          this.__devsole = meta;

          post({
            id: meta.id,
            url: meta.url,
            method: meta.method,
            status: null,
            ok: null,
            type: 'pending',
            startedAt: meta.startedAt,
            durationMs: null,
            requestBody: meta.requestBody,
            responsePreview: null,
            responseBody: null,
            error: null
          });

          var handleDone = function(xhr, errorMessage) {
            var contentType = '';
            try {
              contentType = xhr.getResponseHeader('content-type');
            } catch (error) {}

            post({
              id: meta.id,
              url: meta.url,
              method: meta.method,
              status: xhr.status || null,
              ok: xhr.status >= 200 && xhr.status < 300,
              type: errorMessage ? 'error' : toType(contentType),
              startedAt: meta.startedAt,
              durationMs: Date.now() - meta.startedAt,
              requestBody: meta.requestBody,
              responsePreview: errorMessage ? null : previewText(xhr.responseText, 280),
              responseBody: errorMessage ? null : previewText(xhr.responseText, 12000),
              error: errorMessage
            });
          };

          this.addEventListener('load', function() {
            handleDone(this, null);
          });
          this.addEventListener('error', function() {
            handleDone(this, 'Request failed');
          });
          this.addEventListener('abort', function() {
            handleDone(this, 'Request aborted');
          });

          return send.apply(this, arguments);
        };
      }
    })();
    true;
  `;

  const devsoleElementsBootstrapScript = `
    (function() {
      if (window.__LUNEL_DEVSOLE_ELEMENTS__) return;

      function post(payload) {
        try {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'devsole-elements',
            payload: payload
          }));
        } catch (error) {}
      }

      function postInspectPicked(path) {
        try {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'devsole-elements-picked',
            payload: {
              path: path
            }
          }));
        } catch (error) {}
      }

      function nodeTypeName(node) {
        if (!node) return 'other';
        if (node.nodeType === Node.ELEMENT_NODE) return 'element';
        if (node.nodeType === Node.TEXT_NODE) return 'text';
        if (node.nodeType === Node.COMMENT_NODE) return 'comment';
        if (node.nodeType === Node.DOCUMENT_TYPE_NODE) return 'doctype';
        return 'other';
      }

      function textPreview(value, maxLength) {
        if (value == null) return null;
        var compact = String(value).replace(/\\s+/g, ' ').trim();
        if (!compact) return null;
        return compact.slice(0, maxLength || 220);
      }

      function nodeLabel(node) {
        if (!node) return 'unknown';
        if (node.nodeType === Node.ELEMENT_NODE) {
          var tag = node.tagName ? node.tagName.toLowerCase() : 'element';
          var id = node.id ? '#' + node.id : '';
          var className = '';
          if (typeof node.className === 'string' && node.className.trim()) {
            className = '.' + node.className.trim().split(/\\s+/).slice(0, 2).join('.');
          }
          return '<' + tag + id + className + '>';
        }
        if (node.nodeType === Node.TEXT_NODE) {
          return '#text';
        }
        if (node.nodeType === Node.COMMENT_NODE) {
          return '<!-- -->';
        }
        if (node.nodeType === Node.DOCUMENT_TYPE_NODE) {
          return '<!doctype>';
        }
        return node.nodeName || 'node';
      }

      function selectorPath(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
        var parts = [];
        var current = node;

        while (current && current.nodeType === Node.ELEMENT_NODE) {
          var tag = current.tagName ? current.tagName.toLowerCase() : 'element';
          var selector = tag;
          var parent = current.parentElement;
          if (parent) {
            var sameTagSiblings = Array.prototype.filter.call(parent.children, function(child) {
              return child.tagName === current.tagName;
            });
            selector += ':nth-of-type(' + (sameTagSiblings.indexOf(current) + 1) + ')';
          }

          parts.unshift(selector);
          current = current.parentElement;
        }

        return parts.join(' > ');
      }

      function getPath(node) {
        if (!node || node === document.documentElement) return '';
        var parts = [];
        var current = node;
        while (current && current !== document.documentElement) {
          var parent = current.parentNode;
          if (!parent || !parent.childNodes) break;
          var index = Array.prototype.indexOf.call(parent.childNodes, current);
          if (index < 0) break;
          parts.unshift(String(index));
          current = parent;
        }
        return parts.join('.');
      }

      function getNodeByPath(path) {
        if (!path) return document.documentElement;
        var node = document.documentElement;
        var parts = String(path).split('.');
        for (var i = 0; i < parts.length; i++) {
          var index = Number(parts[i]);
          if (!node || !node.childNodes || Number.isNaN(index) || index < 0 || index >= node.childNodes.length) {
            return null;
          }
          node = node.childNodes[index];
        }
        return node;
      }

      function getAttributes(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE || !node.attributes) return [];
        return Array.prototype.slice.call(node.attributes, 0, 12).map(function(attribute) {
          return {
            name: attribute.name,
            value: String(attribute.value).slice(0, 240)
          };
        });
      }

      function getInlineStyleProperties(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE || !node.style) return [];
        return Array.prototype.slice.call(node.style, 0).map(function(name) {
          return {
            name: name,
            value: node.style.getPropertyValue(name)
          };
        });
      }

      function getDirectTextContent(node) {
        if (!node) return null;
        if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE) {
          return node.nodeValue || '';
        }
        if (node.nodeType !== Node.ELEMENT_NODE || !node.childNodes) return null;
        return Array.prototype.slice.call(node.childNodes)
          .filter(function(child) {
            return child.nodeType === Node.TEXT_NODE;
          })
          .map(function(child) {
            return child.nodeValue || '';
          })
          .join('');
      }

      function getBreadcrumbs(node) {
        var crumbs = [];
        var current = node;
        while (current) {
          crumbs.unshift({
            path: getPath(current),
            label: nodeLabel(current)
          });
          if (current === document.documentElement) break;
          current = current.parentNode;
        }
        return crumbs;
      }

      function serializeChild(node) {
        return {
          path: getPath(node),
          label: nodeLabel(node),
          nodeType: nodeTypeName(node),
          childCount: node && node.children ? node.children.length : 0,
          hasChildren: !!(node && node.children && node.children.length > 0),
          textPreview: textPreview(getDirectTextContent(node), 180)
        };
      }

      function getDeclaredStyles(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return [];

        var declared = [];
        var seen = Object.create(null);

        function pushStyle(name, value, source) {
          if (!name || !value) return;
          declared.push({
            name: name,
            value: value,
            source: source
          });
          seen[name] = true;
        }

        try {
          for (var sheetIndex = 0; sheetIndex < document.styleSheets.length; sheetIndex++) {
            var sheet = document.styleSheets[sheetIndex];
            var rules;

            try {
              rules = sheet.cssRules || sheet.rules;
            } catch (error) {
              continue;
            }

            if (!rules) continue;

            for (var ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
              var rule = rules[ruleIndex];
              if (!rule || rule.type !== CSSRule.STYLE_RULE || !rule.selectorText) continue;

              try {
                if (!node.matches(rule.selectorText)) continue;
              } catch (error) {
                continue;
              }

              for (var styleIndex = 0; styleIndex < rule.style.length; styleIndex++) {
                var styleName = rule.style[styleIndex];
                var styleValue = rule.style.getPropertyValue(styleName);
                if (styleValue) {
                  pushStyle(styleName, styleValue, rule.selectorText);
                }
              }
            }
          }
        } catch (error) {}

        if (node.style) {
          for (var inlineIndex = 0; inlineIndex < node.style.length; inlineIndex++) {
            var inlineName = node.style[inlineIndex];
            var inlineValue = node.style.getPropertyValue(inlineName);
            if (inlineValue) {
              pushStyle(inlineName, inlineValue, 'inline');
            }
          }
        }

        var finalByName = Object.create(null);
        declared.forEach(function(entry) {
          finalByName[entry.name] = entry;
        });

        return Object.keys(finalByName)
          .sort()
          .map(function(name) {
            return finalByName[name];
          });
      }

      function snapshotNode(node) {
        var declaredStyles = [];
        var inlineStyle = null;
        var inlineStyleProperties = [];
        var directTextContent = null;
        var sourceContent = null;

        if (node.nodeType === Node.ELEMENT_NODE) {
          inlineStyle = node.getAttribute('style');
          inlineStyleProperties = getInlineStyleProperties(node);
          declaredStyles = getDeclaredStyles(node);
          directTextContent = getDirectTextContent(node);
          sourceContent = typeof node.outerHTML === 'string' ? node.outerHTML.slice(0, 16000) : null;
        } else if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE) {
          directTextContent = node.nodeValue ? String(node.nodeValue) : '';
          sourceContent = node.nodeValue ? String(node.nodeValue).slice(0, 16000) : null;
        }

        return {
          path: getPath(node),
          label: nodeLabel(node),
          nodeType: nodeTypeName(node),
          tagName: node.tagName ? node.tagName.toLowerCase() : null,
          selectorPath: selectorPath(node),
          attributes: getAttributes(node),
          inlineStyle: inlineStyle,
          inlineStyleProperties: inlineStyleProperties,
          directTextContent: directTextContent,
          sourceContent: sourceContent,
          declaredStyles: declaredStyles,
          childCount: node && node.children ? node.children.length : 0,
          textPreview: node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE
            ? textPreview(node.nodeValue, 300)
            : textPreview(node.textContent, 300),
          breadcrumbs: getBreadcrumbs(node),
          children: Array.prototype.slice.call(node.children || [], 0, 200).map(serializeChild)
        };
      }

      var inspectOverlay = null;
      var inspectCleanup = null;

      function ensureInspectOverlay() {
        if (inspectOverlay && inspectOverlay.parentNode) return inspectOverlay;
        var overlay = document.createElement('div');
        overlay.setAttribute('data-lunel-devsole-inspect', 'true');
        overlay.style.position = 'fixed';
        overlay.style.pointerEvents = 'none';
        overlay.style.zIndex = '2147483647';
        overlay.style.border = '2px solid rgba(60, 130, 246, 0.95)';
        overlay.style.background = 'rgba(60, 130, 246, 0.12)';
        overlay.style.boxSizing = 'border-box';
        overlay.style.borderRadius = '6px';
        overlay.style.display = 'none';
        document.documentElement.appendChild(overlay);
        inspectOverlay = overlay;
        return overlay;
      }

      function hideInspectOverlay() {
        if (inspectOverlay) {
          inspectOverlay.style.display = 'none';
        }
      }

      function highlightNode(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) {
          hideInspectOverlay();
          return;
        }

        var rect = node.getBoundingClientRect();
        if (!rect || (!rect.width && !rect.height)) {
          hideInspectOverlay();
          return;
        }

        var overlay = ensureInspectOverlay();
        overlay.style.display = 'block';
        overlay.style.left = rect.left + 'px';
        overlay.style.top = rect.top + 'px';
        overlay.style.width = rect.width + 'px';
        overlay.style.height = rect.height + 'px';
      }

      function elementFromEvent(event) {
        if (!event) return null;

        if (event.touches && event.touches[0]) {
          return document.elementFromPoint(event.touches[0].clientX, event.touches[0].clientY);
        }

        if (typeof event.clientX === 'number' && typeof event.clientY === 'number') {
          return document.elementFromPoint(event.clientX, event.clientY);
        }

        return event.target && event.target.nodeType === Node.ELEMENT_NODE ? event.target : null;
      }

      function stopInspectMode() {
        if (inspectCleanup) {
          inspectCleanup();
          inspectCleanup = null;
        }
        hideInspectOverlay();
      }

      window.__LUNEL_DEVSOLE_ELEMENTS__ = {
        requestSnapshot: function(path) {
          try {
            var node = getNodeByPath(path);
            if (!node) {
              post({
                snapshot: null,
                error: 'Node not found'
              });
              return;
            }

            post({
              snapshot: snapshotNode(node),
              error: null
            });
          } catch (error) {
            post({
              snapshot: null,
              error: error && error.message ? error.message : String(error)
            });
          }
        },
        applyDeclaredStyles: function(path, styles) {
          try {
            var node = getNodeByPath(path);
            if (!node || node.nodeType !== Node.ELEMENT_NODE) return;

            var entries = Array.isArray(styles) ? styles : [];

            function applyToRuleSource(source, name, value) {
              for (var sheetIndex = 0; sheetIndex < document.styleSheets.length; sheetIndex++) {
                var sheet = document.styleSheets[sheetIndex];
                var rules;

                try {
                  rules = sheet.cssRules || sheet.rules;
                } catch (error) {
                  continue;
                }

                if (!rules) continue;

                for (var ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
                  var rule = rules[ruleIndex];
                  if (!rule || rule.type !== CSSRule.STYLE_RULE || rule.selectorText !== source) {
                    continue;
                  }

                  try {
                    if (!node.matches(rule.selectorText)) continue;
                  } catch (error) {
                    continue;
                  }

                  rule.style.setProperty(name, value);
                  return true;
                }
              }

              return false;
            }

            entries.forEach(function(entry) {
              if (!entry || !entry.name) return;
              var name = String(entry.name).trim();
              var value = String(entry.value || '').trim();
              var source = entry.source ? String(entry.source) : 'inline';
              if (!name) return;

              if (source === 'inline') {
                if (value) {
                  node.style.setProperty(name, value);
                } else {
                  node.style.removeProperty(name);
                }
                return;
              }

              if (value && applyToRuleSource(source, name, value)) {
                return;
              }

              if (value) {
                node.style.setProperty(name, value);
              } else {
                node.style.removeProperty(name);
              }
            });

            post({
              snapshot: snapshotNode(node),
              error: null
            });
          } catch (error) {
            post({
              snapshot: null,
              error: error && error.message ? error.message : String(error)
            });
          }
        },
        setDirectTextContent: function(path, value) {
          try {
            var node = getNodeByPath(path);
            if (!node) return;

            if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE) {
              node.nodeValue = String(value || '');
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              var childNodes = Array.prototype.slice.call(node.childNodes || []);
              childNodes.forEach(function(child) {
                if (child.nodeType === Node.TEXT_NODE) {
                  node.removeChild(child);
                }
              });

              var nextValue = String(value || '');
              if (nextValue) {
                var textNode = document.createTextNode(nextValue);
                if (node.firstChild) {
                  node.insertBefore(textNode, node.firstChild);
                } else {
                  node.appendChild(textNode);
                }
              }
            }

            post({
              snapshot: snapshotNode(node),
              error: null
            });
          } catch (error) {
            post({
              snapshot: null,
              error: error && error.message ? error.message : String(error)
            });
          }
        },
        applyAttributes: function(path, attributes) {
          try {
            var node = getNodeByPath(path);
            if (!node || node.nodeType !== Node.ELEMENT_NODE) return;

            var entries = Array.isArray(attributes) ? attributes : [];
            entries.forEach(function(entry) {
              if (!entry) return;
              var name = String(entry.name || '').trim();
              var value = String(entry.value || '');
              if (!name) return;

              if (value === '') {
                node.removeAttribute(name);
              } else {
                node.setAttribute(name, value);
              }
            });

            post({
              snapshot: snapshotNode(node),
              error: null
            });
          } catch (error) {
            post({
              snapshot: null,
              error: error && error.message ? error.message : String(error)
            });
          }
        },
        beginInspect: function() {
          try {
            stopInspectMode();

            var lastHoveredNode = null;

            var blockEvent = function(event) {
              if (event.preventDefault) event.preventDefault();
              if (event.stopPropagation) event.stopPropagation();
              if (event.stopImmediatePropagation) event.stopImmediatePropagation();
            };

            var onTouchMove = function(event) {
              blockEvent(event);
              lastHoveredNode = elementFromEvent(event);
              highlightNode(lastHoveredNode);
            };

            var onTouchStart = function(event) {
              blockEvent(event);
              lastHoveredNode = elementFromEvent(event);
              highlightNode(lastHoveredNode);
            };

            var onTouchEnd = function(event) {
              blockEvent(event);
              var node = elementFromEvent(event) || lastHoveredNode;
              if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
              stopInspectMode();
              postInspectPicked(getPath(node));
            };

            var onMouseMove = function(event) {
              lastHoveredNode = elementFromEvent(event);
              highlightNode(lastHoveredNode);
            };

            var onMouseDown = function(event) {
              blockEvent(event);
              lastHoveredNode = elementFromEvent(event);
              highlightNode(lastHoveredNode);
            };

            var onMouseUp = function(event) {
              blockEvent(event);
              var node = elementFromEvent(event) || lastHoveredNode;
              if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
              stopInspectMode();
              postInspectPicked(getPath(node));
            };

            var onClick = function(event) {
              blockEvent(event);
            };

            document.addEventListener('mousemove', onMouseMove, true);
            document.addEventListener('mousedown', onMouseDown, true);
            document.addEventListener('mouseup', onMouseUp, true);
            document.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
            document.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
            document.addEventListener('touchend', onTouchEnd, { capture: true, passive: false });
            document.addEventListener('click', onClick, true);

            inspectCleanup = function() {
              document.removeEventListener('mousemove', onMouseMove, true);
              document.removeEventListener('mousedown', onMouseDown, true);
              document.removeEventListener('mouseup', onMouseUp, true);
              document.removeEventListener('touchstart', onTouchStart, true);
              document.removeEventListener('touchmove', onTouchMove, true);
              document.removeEventListener('touchend', onTouchEnd, true);
              document.removeEventListener('click', onClick, true);
            };
          } catch (error) {}
        },
        cancelInspect: function() {
          stopInspectMode();
        }
      };
    })();
    true;
  `;

  const devsoleResourcesBootstrapScript = `
    (function() {
      if (window.__LUNEL_DEVSOLE_RESOURCES__) return;

      function post(payload) {
        try {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'devsole-resources',
            payload: payload
          }));
        } catch (error) {}
      }

      function serializeStorage(areaName, storage) {
        var items = [];
        try {
          for (var index = 0; index < storage.length; index++) {
            var key = storage.key(index);
            if (key == null) continue;
            var value = storage.getItem(key);
            items.push({
              id: areaName + ':' + key,
              area: areaName,
              key: String(key),
              value: value == null ? '' : String(value)
            });
          }
        } catch (error) {}
        items.sort(function(a, b) {
          return a.key.localeCompare(b.key);
        });
        return items;
      }

      function serializeCookies() {
        var raw = '';
        try {
          raw = document.cookie || '';
        } catch (error) {}

        if (!raw.trim()) return [];

        return raw.split(/;\\s*/).filter(Boolean).map(function(entry, index) {
          var separatorIndex = entry.indexOf('=');
          var name = separatorIndex === -1 ? entry : entry.slice(0, separatorIndex);
          var value = separatorIndex === -1 ? '' : entry.slice(separatorIndex + 1);
          return {
            id: 'cookie:' + name + ':' + index,
            name: String(name || '').trim(),
            value: String(value || '')
          };
        }).filter(function(cookie) {
          return !!cookie.name;
        });
      }

      function snapshot() {
        return {
          url: String(window.location.href || ''),
          title: String(document.title || ''),
          userAgent: String(navigator.userAgent || ''),
          localStorage: serializeStorage('localStorage', window.localStorage),
          sessionStorage: serializeStorage('sessionStorage', window.sessionStorage),
          cookies: serializeCookies()
        };
      }

      window.__LUNEL_DEVSOLE_RESOURCES__ = {
        requestSnapshot: function() {
          try {
            post({
              snapshot: snapshot(),
              error: null
            });
          } catch (error) {
            post({
              snapshot: null,
              error: error && error.message ? error.message : String(error)
            });
          }
        },
        setStorageItem: function(areaName, key, value) {
          try {
            var storage = areaName === 'sessionStorage' ? window.sessionStorage : window.localStorage;
            storage.setItem(String(key || ''), String(value || ''));
            post({
              snapshot: snapshot(),
              error: null
            });
          } catch (error) {
            post({
              snapshot: null,
              error: error && error.message ? error.message : String(error)
            });
          }
        },
        removeStorageItem: function(areaName, key) {
          try {
            var storage = areaName === 'sessionStorage' ? window.sessionStorage : window.localStorage;
            storage.removeItem(String(key || ''));
            post({
              snapshot: snapshot(),
              error: null
            });
          } catch (error) {
            post({
              snapshot: null,
              error: error && error.message ? error.message : String(error)
            });
          }
        },
        clearStorageArea: function(areaName) {
          try {
            var storage = areaName === 'sessionStorage' ? window.sessionStorage : window.localStorage;
            storage.clear();
            post({
              snapshot: snapshot(),
              error: null
            });
          } catch (error) {
            post({
              snapshot: null,
              error: error && error.message ? error.message : String(error)
            });
          }
        },
        setCookie: function(name, value) {
          try {
            document.cookie = String(name || '') + '=' + String(value || '') + '; path=/';
            post({
              snapshot: snapshot(),
              error: null
            });
          } catch (error) {
            post({
              snapshot: null,
              error: error && error.message ? error.message : String(error)
            });
          }
        },
        removeCookie: function(name) {
          try {
            document.cookie = String(name || '') + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
            post({
              snapshot: snapshot(),
              error: null
            });
          } catch (error) {
            post({
              snapshot: null,
              error: error && error.message ? error.message : String(error)
            });
          }
        }
      };
    })();
    true;
  `;

  const devsoleInfoBootstrapScript = `
    (function() {
      if (window.__LUNEL_DEVSOLE_INFO__) return;

      function post(payload) {
        try {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'devsole-info',
            payload: payload
          }));
        } catch (error) {}
      }

      function safeValue(value) {
        if (value == null) return '—';
        return String(value);
      }

      function storageAvailable(kind) {
        try {
          var storage = window[kind];
          var key = '__devsole_test__';
          storage.setItem(key, '1');
          storage.removeItem(key);
          return 'Yes';
        } catch (error) {
          return 'No';
        }
      }

      function snapshot() {
        var nav = performance && performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
        var memory = performance && performance.memory ? performance.memory : null;
        var viewport = window.visualViewport || null;

        return {
          fields: [
            { section: 'Page', label: 'URL', value: safeValue(window.location.href) },
            { section: 'Page', label: 'Title', value: safeValue(document.title || 'Untitled') },
            { section: 'Page', label: 'Referrer', value: safeValue(document.referrer || '—') },
            { section: 'Page', label: 'Origin', value: safeValue(window.location.origin || '—') },
            { section: 'Page', label: 'Ready State', value: safeValue(document.readyState) },
            { section: 'Page', label: 'Online', value: navigator.onLine ? 'Yes' : 'No' },
            { section: 'Viewport', label: 'Viewport', value: safeValue(window.innerWidth + ' x ' + window.innerHeight) },
            { section: 'Viewport', label: 'Screen', value: safeValue(screen.width + ' x ' + screen.height) },
            { section: 'Viewport', label: 'Visual Viewport', value: viewport ? safeValue(Math.round(viewport.width) + ' x ' + Math.round(viewport.height)) : '—' },
            { section: 'Viewport', label: 'DPR', value: safeValue(window.devicePixelRatio || 1) },
            { section: 'Viewport', label: 'Orientation', value: safeValue(screen.orientation && screen.orientation.type ? screen.orientation.type : (window.innerWidth > window.innerHeight ? 'landscape' : 'portrait')) },
            { section: 'Viewport', label: 'Color Scheme', value: window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' },
            { section: 'Runtime', label: 'User Agent', value: safeValue(navigator.userAgent) },
            { section: 'Runtime', label: 'Platform', value: safeValue(navigator.platform || '—') },
            { section: 'Runtime', label: 'Language', value: safeValue(navigator.language || '—') },
            { section: 'Runtime', label: 'Timezone', value: safeValue(Intl.DateTimeFormat().resolvedOptions().timeZone || '—') },
            { section: 'Runtime', label: 'Cookies Enabled', value: navigator.cookieEnabled ? 'Yes' : 'No' },
            { section: 'Runtime', label: 'Local Storage', value: storageAvailable('localStorage') },
            { section: 'Runtime', label: 'Session Storage', value: storageAvailable('sessionStorage') },
            { section: 'Performance', label: 'Navigation Type', value: nav ? safeValue(nav.type) : '—' },
            { section: 'Performance', label: 'DOM Complete', value: nav ? safeValue(Math.round(nav.domComplete) + ' ms') : '—' },
            { section: 'Performance', label: 'Load End', value: nav ? safeValue(Math.round(nav.loadEventEnd) + ' ms') : '—' },
            { section: 'Performance', label: 'JS Heap Used', value: memory ? safeValue(Math.round(memory.usedJSHeapSize / 1024 / 1024) + ' MB') : '—' },
          ]
        };
      }

      window.__LUNEL_DEVSOLE_INFO__ = {
        requestSnapshot: function() {
          try {
            post({
              snapshot: snapshot(),
              error: null
            });
          } catch (error) {
            post({
              snapshot: null,
              error: error && error.message ? error.message : String(error)
            });
          }
        }
      };
    })();
    true;
  `;

  const injectDevsoleConsole = (tabId: string) => {
    webViewRefs.current[tabId]?.injectJavaScript([
      devsoleConsoleBootstrapScript,
      devsoleNetworkBootstrapScript,
      devsoleElementsBootstrapScript,
      devsoleResourcesBootstrapScript,
      devsoleInfoBootstrapScript,
    ].join("\n"));
  };

  const requestElementsSnapshot = (tabId: string, path = "") => {
    webViewRefs.current[tabId]?.injectJavaScript(`
      (function() {
        try {
          if (window.__LUNEL_DEVSOLE_ELEMENTS__) {
            window.__LUNEL_DEVSOLE_ELEMENTS__.requestSnapshot(${JSON.stringify(path)});
          }
        } catch (error) {}
      })();
      true;
    `);
  };

  const requestElementsPathChain = (tabId: string, path: string) => {
    const paths = [""];
    if (path) {
      const segments = path.split(".");
      let currentPath = "";
      segments.forEach((segment) => {
        currentPath = currentPath ? `${currentPath}.${segment}` : segment;
        paths.push(currentPath);
      });
    }

    paths.forEach((nextPath) => {
      requestElementsSnapshot(tabId, nextPath);
    });
  };

  const startElementsPickMode = (tabId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setElementsInspectingByTab((current) => ({
      ...current,
      [tabId]: true,
    }));
    setDevsoleStateByTab((current) => ({
      ...current,
      [tabId]: {
        ...(current[tabId] || getDefaultDevsoleState()),
        open: false,
        section: "elements",
      },
    }));
    webViewRefs.current[tabId]?.injectJavaScript(`
      (function() {
        try {
          if (window.__LUNEL_DEVSOLE_ELEMENTS__) {
            window.__LUNEL_DEVSOLE_ELEMENTS__.beginInspect();
          }
        } catch (error) {}
      })();
      true;
    `);
  };

  const updateElementsDeclaredStyles = (
    tabId: string,
    path: string,
    styles: { name: string; value: string; source?: string }[]
  ) => {
    webViewRefs.current[tabId]?.injectJavaScript(`
      (function() {
        try {
          if (window.__LUNEL_DEVSOLE_ELEMENTS__) {
            window.__LUNEL_DEVSOLE_ELEMENTS__.applyDeclaredStyles(
              ${JSON.stringify(path)},
              ${JSON.stringify(styles)}
            );
          }
        } catch (error) {}
      })();
      true;
    `);
  };

  const updateElementsDirectTextContent = (tabId: string, path: string, value: string) => {
    webViewRefs.current[tabId]?.injectJavaScript(`
      (function() {
        try {
          if (window.__LUNEL_DEVSOLE_ELEMENTS__) {
            window.__LUNEL_DEVSOLE_ELEMENTS__.setDirectTextContent(
              ${JSON.stringify(path)},
              ${JSON.stringify(value)}
            );
          }
        } catch (error) {}
      })();
      true;
    `);
  };

  const updateElementsAttributes = (
    tabId: string,
    path: string,
    attributes: { name: string; value: string }[]
  ) => {
    webViewRefs.current[tabId]?.injectJavaScript(`
      (function() {
        try {
          if (window.__LUNEL_DEVSOLE_ELEMENTS__) {
            window.__LUNEL_DEVSOLE_ELEMENTS__.applyAttributes(
              ${JSON.stringify(path)},
              ${JSON.stringify(attributes)}
            );
          }
        } catch (error) {}
      })();
      true;
    `);
  };

  const requestResourcesSnapshot = (tabId: string) => {
    webViewRefs.current[tabId]?.injectJavaScript(`
      (function() {
        try {
          if (window.__LUNEL_DEVSOLE_RESOURCES__) {
            window.__LUNEL_DEVSOLE_RESOURCES__.requestSnapshot();
          }
        } catch (error) {}
      })();
      true;
    `);
  };

  const setResourceStorageItem = (
    tabId: string,
    area: "localStorage" | "sessionStorage",
    key: string,
    value: string
  ) => {
    webViewRefs.current[tabId]?.injectJavaScript(`
      (function() {
        try {
          if (window.__LUNEL_DEVSOLE_RESOURCES__) {
            window.__LUNEL_DEVSOLE_RESOURCES__.setStorageItem(
              ${JSON.stringify(area)},
              ${JSON.stringify(key)},
              ${JSON.stringify(value)}
            );
          }
        } catch (error) {}
      })();
      true;
    `);
  };

  const removeResourceStorageItem = (
    tabId: string,
    area: "localStorage" | "sessionStorage",
    key: string
  ) => {
    webViewRefs.current[tabId]?.injectJavaScript(`
      (function() {
        try {
          if (window.__LUNEL_DEVSOLE_RESOURCES__) {
            window.__LUNEL_DEVSOLE_RESOURCES__.removeStorageItem(
              ${JSON.stringify(area)},
              ${JSON.stringify(key)}
            );
          }
        } catch (error) {}
      })();
      true;
    `);
  };

  const clearResourceStorageArea = (
    tabId: string,
    area: "localStorage" | "sessionStorage"
  ) => {
    webViewRefs.current[tabId]?.injectJavaScript(`
      (function() {
        try {
          if (window.__LUNEL_DEVSOLE_RESOURCES__) {
            window.__LUNEL_DEVSOLE_RESOURCES__.clearStorageArea(
              ${JSON.stringify(area)}
            );
          }
        } catch (error) {}
      })();
      true;
    `);
  };

  const setResourceCookie = (tabId: string, name: string, value: string) => {
    webViewRefs.current[tabId]?.injectJavaScript(`
      (function() {
        try {
          if (window.__LUNEL_DEVSOLE_RESOURCES__) {
            window.__LUNEL_DEVSOLE_RESOURCES__.setCookie(
              ${JSON.stringify(name)},
              ${JSON.stringify(value)}
            );
          }
        } catch (error) {}
      })();
      true;
    `);
  };

  const removeResourceCookie = (tabId: string, name: string) => {
    webViewRefs.current[tabId]?.injectJavaScript(`
      (function() {
        try {
          if (window.__LUNEL_DEVSOLE_RESOURCES__) {
            window.__LUNEL_DEVSOLE_RESOURCES__.removeCookie(
              ${JSON.stringify(name)}
            );
          }
        } catch (error) {}
      })();
      true;
    `);
  };

  const requestInfoSnapshot = (tabId: string) => {
    webViewRefs.current[tabId]?.injectJavaScript(`
      (function() {
        try {
          if (window.__LUNEL_DEVSOLE_INFO__) {
            window.__LUNEL_DEVSOLE_INFO__.requestSnapshot();
          }
        } catch (error) {}
      })();
      true;
    `);
  };

  const createNewTab = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    const newId = Date.now().toString();
    const newTab: Tab = {
      id: newId,
      url: "https://www.google.com",
      title: "New Tab",
      loading: false,
      ready: false,
    };
    setTabs([...tabs, newTab]);
    setActiveTabId(newId);
    setUrlInput("https://www.google.com");
    setConsoleEntriesByTab((current) => ({ ...current, [newId]: [] }));
    setNetworkEntriesByTab((current) => ({ ...current, [newId]: [] }));
    setElementsSnapshotByTab((current) => ({ ...current, [newId]: null }));
    setResourcesSnapshotByTab((current) => ({ ...current, [newId]: null }));
    setInfoSnapshotByTab((current) => ({ ...current, [newId]: null }));
    setElementsInspectingByTab((current) => ({ ...current, [newId]: false }));
    setElementsFocusByTab((current) => ({ ...current, [newId]: null }));
    setDevsoleStateByTab((current) => ({
      ...current,
      [newId]: getDefaultDevsoleState(),
    }));
    pageUrlByTabRef.current[newId] = newTab.url;

    InteractionManager.runAfterInteractions(() => {
      setTabs((prev) =>
        prev.map((t) => (t.id === newId ? { ...t, ready: true } : t))
      );
    });
  };

  const closeTab = (tabId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    const wasActiveTab = activeTabId === tabId;
    const newTabs = tabs.filter((tab) => tab.id !== tabId);
    setTabs(newTabs);

    if (wasActiveTab) {
      if (newTabs.length > 0) {
        const index = tabs.findIndex((t) => t.id === tabId);
        const newActiveTab = newTabs[Math.max(0, index - 1)];
        setActiveTabId(newActiveTab.id);
        setUrlInput(displayUrl(newActiveTab.url));
      } else {
        setActiveTabId("");
        setUrlInput("");
      }
    }

    delete webViewRefs.current[tabId];
    setConsoleEntriesByTab((current) => {
      const next = { ...current };
      delete next[tabId];
      return next;
    });
    setNetworkEntriesByTab((current) => {
      const next = { ...current };
      delete next[tabId];
      return next;
    });
    setElementsSnapshotByTab((current) => {
      const next = { ...current };
      delete next[tabId];
      return next;
    });
    setResourcesSnapshotByTab((current) => {
      const next = { ...current };
      delete next[tabId];
      return next;
    });
    setInfoSnapshotByTab((current) => {
      const next = { ...current };
      delete next[tabId];
      return next;
    });
    setElementsInspectingByTab((current) => {
      const next = { ...current };
      delete next[tabId];
      return next;
    });
    setElementsFocusByTab((current) => {
      const next = { ...current };
      delete next[tabId];
      return next;
    });
    setDevsoleStateByTab((current) => {
      const next = { ...current };
      delete next[tabId];
      return next;
    });
    delete pageUrlByTabRef.current[tabId];
  };

  const handleUrlSubmit = () => {
    let url = urlInput.trim();
    if (!url) return;

    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      if (url.includes(".") && !url.includes(" ")) {
        url = "https://" + url;
      } else {
        url = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
      }
    }

    setTabs(
      tabs.map((tab) => (tab.id === activeTabId ? { ...tab, url } : tab))
    );
    setUrlInput(displayUrl(url));
    setIsFocused(false);
  };

  const toggleDevsole = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setDevsoleStateByTab((current) => ({
      ...current,
      [activeTabId]: {
        ...(current[activeTabId] || getDefaultDevsoleState()),
        open: !(current[activeTabId]?.open ?? false),
      },
    }));
  };

  const toggleDevsoleExpanded = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setDevsoleStateByTab((current) => ({
      ...current,
      [activeTabId]: {
        ...(current[activeTabId] || getDefaultDevsoleState()),
        expanded: !(current[activeTabId]?.expanded ?? false),
      },
    }));
  };

  const clearActiveConsole = () => {
    setConsoleEntriesByTab((current) => ({
      ...current,
      [activeTabId]: [],
    }));
  };

  const clearActiveNetwork = () => {
    setNetworkEntriesByTab((current) => ({
      ...current,
      [activeTabId]: [],
    }));
  };

  const executeConsoleInput = (code: string) => {
    const serializedCode = JSON.stringify(code);
    webViewRefs.current[activeTabId]?.injectJavaScript(`
      (function() {
        try {
          var __devsoleResult = eval(${serializedCode});
          if (__devsoleResult && typeof __devsoleResult.then === 'function') {
            __devsoleResult.then(function(value) {
              console.log(value);
            }).catch(function(error) {
              console.error(error);
            });
          } else {
            console.log(__devsoleResult);
          }
        } catch (error) {
          console.error(error);
        }
      })();
      true;
    `);
  };

  const handlePageChange = (tabId: string, nextUrl: string) => {
    const previousUrl = pageUrlByTabRef.current[tabId];
    if (previousUrl && previousUrl !== nextUrl) {
      setConsoleEntriesByTab((current) => ({
        ...current,
        [tabId]: [],
      }));
      setNetworkEntriesByTab((current) => ({
        ...current,
        [tabId]: [],
      }));
      setElementsSnapshotByTab((current) => ({
        ...current,
        [tabId]: null,
      }));
      setResourcesSnapshotByTab((current) => ({
        ...current,
        [tabId]: null,
      }));
      setInfoSnapshotByTab((current) => ({
        ...current,
        [tabId]: null,
      }));
      setElementsInspectingByTab((current) => ({
        ...current,
        [tabId]: false,
      }));
      setElementsFocusByTab((current) => ({
        ...current,
        [tabId]: null,
      }));
    }
    pageUrlByTabRef.current[tabId] = nextUrl;
  };

  const extractFavicon = (tabId: string) => {
    const script = `
      (function() {
        const links = document.querySelectorAll('link[rel*="icon"]');
        let favicon = null;
        let fallbackFavicon = null;

        for (let link of links) {
          const media = link.getAttribute('media');
          const href = link.getAttribute('href');

          if (!href) continue;

          if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches && media && media.includes('dark')) {
            favicon = href;
            break;
          }
          else if ((!window.matchMedia || !window.matchMedia('(prefers-color-scheme: dark)').matches) && media && media.includes('light')) {
            favicon = href;
            break;
          }
          else if (!media && !fallbackFavicon) {
            fallbackFavicon = href;
          }
        }

        const finalFavicon = favicon || fallbackFavicon;

        if (finalFavicon) {
          try {
            const url = new URL(finalFavicon, window.location.href);
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'favicon',
              favicon: url.href
            }));
          } catch (e) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'favicon',
              favicon: finalFavicon
            }));
          }
        }
      })();
      true;
    `;

    webViewRefs.current[tabId]?.injectJavaScript(script);
  };

  useEffect(() => {
    if (!devsoleOpen || activeDevsoleSection !== "elements" || !activeTabId) return;
    requestElementsSnapshot(activeTabId, "");
  }, [activeDevsoleSection, activeTabId, devsoleOpen]);

  useEffect(() => {
    if (!devsoleOpen || activeDevsoleSection !== "resources" || !activeTabId) return;
    requestResourcesSnapshot(activeTabId);
  }, [activeDevsoleSection, activeTabId, devsoleOpen]);

  useEffect(() => {
    if (!devsoleOpen || activeDevsoleSection !== "info" || !activeTabId) return;
    requestInfoSnapshot(activeTabId);
  }, [activeDevsoleSection, activeTabId, devsoleOpen]);

  useEffect(() => {
    if (!devsoleOpen || activeDevsoleSection !== "proxies") return;
    setProxySectionError(null);
    refreshProxyState().catch((error) => {
      setProxySectionError(error instanceof Error ? error.message : String(error));
    });
  }, [activeDevsoleSection, devsoleOpen, refreshProxyState]);

  const handleRefreshProxyState = useCallback(() => {
    setProxySectionError(null);
    refreshProxyState().catch((error) => {
      setProxySectionError(error instanceof Error ? error.message : String(error));
    });
  }, [refreshProxyState]);

  const handleTrackProxyPort = useCallback(async (port: number) => {
    setProxyMutationPending(true);
    setProxySectionError(null);
    try {
      await trackProxyPort(port);
    } catch (error) {
      setProxySectionError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setProxyMutationPending(false);
    }
  }, [trackProxyPort]);

  const handleUntrackProxyPort = useCallback(async (port: number) => {
    setProxyMutationPending(true);
    setProxySectionError(null);
    try {
      await untrackProxyPort(port);
    } catch (error) {
      setProxySectionError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setProxyMutationPending(false);
    }
  }, [untrackProxyPort]);

  const handleTabPress = useCallback(
    (tabId: string) => {
      setActiveTabId(tabId);
      const tab = tabs.find((t) => t.id === tabId);
      if (tab) {
        setUrlInput(displayUrl(tab.url));
      }
    },
    [tabs]
  );

  useEffect(() => {
    register('browser', {
      sessions: tabs,
      activeSessionId: activeTabId || null,
      onSessionPress: handleTabPress,
      onSessionClose: closeTab,
      onCreateSession: createNewTab,
    });
  }, [tabs, activeTabId, register, handleTabPress, closeTab, createNewTab]);

  useEffect(() => () => unregister('browser'), [unregister]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg.base }}>
      {/* Header */}
      <PluginHeader
        title={activeTab?.title || "Browser"}
        colors={colors}
        showBottomBorder={false}

      />

      <View
        style={{ flex: 1, position: "relative", paddingTop: headerHeight }}
        onLayout={(event) => {
          setBrowserViewportHeight(event.nativeEvent.layout.height);
        }}
      >
        {/* Navigation Bar */}
        {tabs.length > 0 && (
          <View
            style={{
              height: 55,
              paddingHorizontal: 10,
              paddingTop: 0,
              paddingBottom: 0,
              flexDirection: "row",
              alignItems: "flex-start",
              justifyContent: "flex-start",
              borderBottomWidth: 0.5,
              borderBottomColor: colors.border.secondary,
              gap: 6,
            }}
          >
            <TouchableOpacity
              onPress={() => {
                if (isFocused) {
                  setIsFocused(false);
                  urlInputRef.current?.blur();
                } else {
                  webViewRefs.current[activeTabId]?.goBack();
                }
              }}
              disabled={!isFocused && !activeTab?.canGoBack}
              style={{
                width: 40,
                height: 40,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: isFocused ? 10 : 999,
                opacity: isFocused || activeTab?.canGoBack ? 1 : 0.3,
              }}
            >
              <ArrowLeft
                size={20}
                color={colors.fg.default}
                strokeWidth={2}
              />
            </TouchableOpacity>

            {!isFocused && (
              <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
                <TouchableOpacity
                  onPress={() => webViewRefs.current[activeTabId]?.goForward()}
                  disabled={!activeTab?.canGoForward}
                  style={{
                    width: 40,
                    height: 40,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 999,
                    opacity: activeTab?.canGoForward ? 1 : 0.3,
                  }}
                >
                  <ArrowRight
                    size={20}
                    color={colors.fg.default}
                    strokeWidth={2}
                  />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => webViewRefs.current[activeTabId]?.reload()}
                  style={{
                    width: 40,
                    height: 40,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 10,
                  }}
                >
                  <RotateCw size={18} color={colors.fg.default} strokeWidth={2} />
                </TouchableOpacity>
              </View>
            )}

            <View
              style={{
                flex: 1,
                height: 40,
                backgroundColor: colors.bg.raised,
                borderRadius: 10,
                flexDirection: "row",
                alignItems: "center",
                paddingLeft: 12,
                paddingRight: 9,
                gap: 8,
              }}
            >
              <Search
                size={17}
                color={colors.fg.muted}
                strokeWidth={2}
              />

              <TextInput
                ref={urlInputRef}
                value={urlInput}
                onChangeText={setUrlInput}
                onSubmitEditing={handleUrlSubmit}
                onFocus={() => {
                  setIsFocused(true);
                  setFocusSelection({ start: urlInput.length, end: urlInput.length });
                  setTimeout(() => setFocusSelection(undefined), 50);
                }}
                onBlur={() => setIsFocused(false)}
                placeholder="Search or enter website name"
                placeholderTextColor={colors.fg.muted}
                style={
                  {
                    flex: 1,
                    color: colors.fg.default,
                    fontSize: typography.body,
                    fontFamily: 'IBMPlexSans_400Regular',
                    outline: "none",
                  } as any
                }
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                selection={isFocused ? focusSelection : { start: 0, end: 0 }}
                inputAccessoryViewID={Platform.OS === "ios" ? "browser_url_input" : undefined}
              />

              {Platform.OS === "ios" && (
                <InputAccessoryView
                  nativeID="browser_url_input"
                  backgroundColor={colors.bg.base}
                >
                  <View style={{ height: 0 }} />
                </InputAccessoryView>
              )}

              {isFocused && urlInput.length > 0 && (
                <TouchableOpacity
                  onPress={() => setUrlInput("")}
                  style={{
                    width: 28,
                    height: 28,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: radius.full,
                    backgroundColor: colors.bg.base,
                  }}
                >
                  <X size={17} color={colors.fg.default} strokeWidth={2} />
                </TouchableOpacity>
              )}
            </View>

            {!isFocused && <TouchableOpacity
              onPress={toggleDevsole}
              activeOpacity={0.85}
              style={{
                width: 40,
                height: 40,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 10,
                backgroundColor: devsoleOpen ? colors.accent.default : colors.bg.raised,
              }}
            >
              <Code
                size={18}
                color={devsoleOpen ? colors.fg.default : colors.fg.muted}
                strokeWidth={2}
              />
            </TouchableOpacity>}
          </View>
        )}

        {/* WebView Container */}
        {tabs.length === 0 ? (
          <View
            style={{
              flex: 1,
              justifyContent: "center",
              alignItems: "center",
              gap: 20,
            }}
          >
            <View style={{ alignItems: "center", gap: 8 }}>
              <SquareMousePointer size={48} color={colors.fg.muted} strokeWidth={1.5} />
              <Text style={{ color: colors.fg.muted, fontSize: 16, fontFamily: fonts.sans.regular }}>
                No tabs open
              </Text>
            </View>
            <TouchableOpacity
              onPress={createNewTab}
              style={{
                alignItems: "center",
                backgroundColor: colors.bg.raised,
                paddingHorizontal: 16,
                paddingVertical: 10,
                borderRadius: 10,
              }}
            >
              <Text
                style={{
                  color: colors.fg.default,
                  fontSize: 14,
                  fontFamily: fonts.sans.medium,
                }}
              >
                Open New Tab
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          tabs.map((tab) => (
            <View
              key={tab.id}
              style={{
                flex: 1,
                display: activeTabId === tab.id ? "flex" : "none",
              }}
            >
              {tab.ready === false ? (
                <Loading />
              ) : (
                <WebView
                  ref={(ref) => {
                    webViewRefs.current[tab.id] = ref;
                  }}
                  source={{ uri: tab.url }}
                  style={{ flex: 1 }}
                  forceDarkOn={isDark}
                  injectedJavaScriptBeforeContentLoaded={`
                    (function() {
                      var meta = document.createElement('meta');
                      meta.name = 'color-scheme';
                      meta.content = '${isDark ? 'dark' : 'light'}';
                      document.head.appendChild(meta);
                    })();
                    true;
                  `}
                  textZoom={90}
                  cacheEnabled={false}
                  cacheMode="LOAD_NO_CACHE"
                  originWhitelist={["*"]}
                  setSupportMultipleWindows={false}
                  hideKeyboardAccessoryView={true}
                  onShouldStartLoadWithRequest={() => true}
                  onNavigationStateChange={(navState) => {
                    handlePageChange(tab.id, navState.url);
                    if (tab.id === activeTabId && !isFocused) {
                      setUrlInput(displayUrl(navState.url));
                    }
                    setTabs((currentTabs) =>
                      currentTabs.map((t) =>
                        t.id === tab.id
                          ? {
                              ...t,
                              url: navState.url,
                              title: navState.title || t.title,
                              canGoBack: navState.canGoBack,
                              canGoForward: navState.canGoForward,
                              loading: navState.loading,
                            }
                          : t
                      )
                    );
                  }}
                  onLoadStart={() => {
                    setTabs((currentTabs) =>
                      currentTabs.map((t) =>
                        t.id === tab.id ? { ...t, loading: true } : t
                      )
                    );
                  }}
                  onLoadEnd={() => {
                    setTabs((currentTabs) =>
                      currentTabs.map((t) =>
                        t.id === tab.id ? { ...t, loading: false } : t
                      )
                    );
                    injectDevsoleConsole(tab.id);
                    if (
                      devsoleStateByTab[tab.id]?.open &&
                      devsoleStateByTab[tab.id]?.section === "elements"
                    ) {
                      requestElementsSnapshot(tab.id, "");
                    }
                    if (
                      devsoleStateByTab[tab.id]?.open &&
                      devsoleStateByTab[tab.id]?.section === "resources"
                    ) {
                      requestResourcesSnapshot(tab.id);
                    }
                    if (
                      devsoleStateByTab[tab.id]?.open &&
                      devsoleStateByTab[tab.id]?.section === "info"
                    ) {
                      requestInfoSnapshot(tab.id);
                    }
                    extractFavicon(tab.id);
                  }}
                  onMessage={(event) => {
                    try {
                      const data = JSON.parse(event.nativeEvent.data);
                      if (data.type === "favicon" && data.favicon) {
                        setTabs((currentTabs) => {
                          const currentTab = currentTabs.find((t) => t.id === tab.id);
                          if (!currentTab || currentTab.favicon === data.favicon) {
                            return currentTabs;
                          }
                          return currentTabs.map((t) =>
                            t.id === tab.id
                              ? { ...t, favicon: data.favicon }
                              : t
                          );
                        });
                        return;
                      }

                      if (data.type === "devsole-console" && data.payload) {
                        const entry = data.payload as DevsoleConsoleEntry;
                        setConsoleEntriesByTab((current) => {
                          const existing = current[tab.id] || [];
                          const nextEntries = [...existing, entry].slice(-500);
                          return {
                            ...current,
                            [tab.id]: nextEntries,
                          };
                        });
                        return;
                      }

                      if (data.type === "devsole-network" && data.payload) {
                        const entry = data.payload as DevsoleNetworkEntry;
                        setNetworkEntriesByTab((current) => {
                          const existing = current[tab.id] || [];
                          const index = existing.findIndex((item) => item.id === entry.id);
                          const nextEntries = [...existing];

                          if (index === -1) {
                            nextEntries.push(entry);
                          } else {
                            nextEntries[index] = { ...nextEntries[index], ...entry };
                          }

                          return {
                            ...current,
                            [tab.id]: nextEntries.slice(0, 300),
                          };
                        });
                        return;
                      }

                      if (data.type === "devsole-elements" && data.payload) {
                        setElementsSnapshotByTab((current) => ({
                          ...current,
                          [tab.id]: data.payload.snapshot || null,
                        }));
                        return;
                      }

                      if (data.type === "devsole-elements-picked" && data.payload?.path != null) {
                        const pickedPath = String(data.payload.path || "");
                        setElementsInspectingByTab((current) => ({
                          ...current,
                          [tab.id]: false,
                        }));
                        setElementsFocusByTab((current) => ({
                          ...current,
                          [tab.id]: {
                            path: pickedPath,
                            token: Date.now(),
                          },
                        }));
                        setDevsoleStateByTab((current) => ({
                          ...current,
                          [tab.id]: {
                            ...(current[tab.id] || getDefaultDevsoleState()),
                            open: true,
                            section: "elements",
                          },
                        }));
                        requestElementsPathChain(tab.id, pickedPath);
                        return;
                      }

                      if (data.type === "devsole-resources" && data.payload) {
                        setResourcesSnapshotByTab((current) => ({
                          ...current,
                          [tab.id]: data.payload.snapshot || null,
                        }));
                        return;
                      }

                      if (data.type === "devsole-info" && data.payload) {
                        setInfoSnapshotByTab((current) => ({
                          ...current,
                          [tab.id]: data.payload.snapshot || null,
                        }));
                        return;
                      }

                    } catch {
                      // Ignore parsing errors
                    }
                  }}
                  injectedJavaScriptBeforeContentLoaded={[
                    trustedTypesSetupScript.trim(),
                    devsoleConsoleBootstrapScript.trim(),
                    devsoleNetworkBootstrapScript.trim(),
                    devsoleElementsBootstrapScript.trim(),
                    devsoleResourcesBootstrapScript.trim(),
                    devsoleInfoBootstrapScript.trim(),
                  ].join("\n")}
                  javaScriptEnabled={true}
                  domStorageEnabled={true}
                  allowsInlineMediaPlayback={true}
                  mediaPlaybackRequiresUserAction={false}
                  startInLoadingState={true}
                  renderLoading={() => (
                    <View
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: colors.bg.base,
                      }}
                    >
                      <Loading />
                    </View>
                  )}
                />
              )}
            </View>
          ))
        )}

        {devsoleOpen && (
          <Animated.View
            style={[
              {
                position: "absolute",
                left: 8,
                right: 8,
                bottom: 8,
                zIndex: 20,
                minHeight: 280,
                backgroundColor: colors.bg.base,
                borderRadius: radius.xl,
                borderWidth: 1,
                borderColor: colors.border.secondary,
                overflow: "hidden",
              },
              devsoleAnimatedStyle,
            ]}
          >
            <View
              style={{
                paddingHorizontal: 12,
                paddingTop: 10,
                paddingBottom: 10,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: colors.border.secondary,
                backgroundColor: colors.bg.raised,
              }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={{ flex: 1 }}
                  contentContainerStyle={{ gap: 6, paddingRight: 4 }}
                >
                  <View style={{ flexDirection: "row", gap: 6 }}>
                  {DEVSOLE_SECTIONS.map((section) => {
                    const isActive = section.id === activeDevsoleSection;

                    return (
                      <TouchableOpacity
                        key={section.id}
                        onPress={() =>
                          setDevsoleStateByTab((current) => ({
                            ...current,
                            [activeTabId]: {
                              ...(current[activeTabId] || {
                                open: false,
                                section: "console" as DevsoleSectionId,
                                expanded: false,
                              }),
                              section: section.id,
                            },
                          }))
                        }
                        activeOpacity={0.85}
                        style={{
                          paddingHorizontal: 10,
                          paddingVertical: 7,
                          borderRadius: radius.full,
                          backgroundColor: isActive ? colors.accent.default : colors.bg.base,
                          borderWidth: 1,
                          borderColor: isActive ? colors.accent.default : colors.border.secondary,
                        }}
                      >
                        <Text
                          style={{
                            color: isActive ? '#ffffff' : colors.fg.default,
                            fontSize: 11,
                            fontFamily: isActive ? fonts.sans.semibold : fonts.sans.medium,
                          }}
                        >
                          {section.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                  </View>
                </ScrollView>

                <TouchableOpacity
                  onPress={toggleDevsoleExpanded}
                  style={{
                    width: 28,
                    height: 28,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: radius.full,
                    backgroundColor: colors.bg.base,
                    borderWidth: 1,
                    borderColor: colors.border.secondary,
                  }}
                >
                  {devsoleExpanded ? (
                    <Minimize2 size={14} color={colors.fg.default} strokeWidth={2} />
                  ) : (
                    <Maximize2 size={14} color={colors.fg.default} strokeWidth={2} />
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={toggleDevsole}
                  style={{
                    width: 28,
                    height: 28,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: radius.full,
                    backgroundColor: colors.bg.base,
                    borderWidth: 1,
                    borderColor: colors.border.secondary,
                  }}
                >
                  <X size={14} color={colors.fg.default} strokeWidth={2} />
                </TouchableOpacity>
              </View>
            </View>

            {activeDevsoleSection === "console" ? (
              <View style={{ flex: 1, padding: 10 }}>
                <ConsoleSection
                  entries={activeConsoleEntries}
                  onClear={clearActiveConsole}
                  onExecute={executeConsoleInput}
                  listKey={activeTabId}
                />
              </View>
            ) : activeDevsoleSection === "network" ? (
              <View style={{ flex: 1, padding: 10 }}>
                <NetworkSection
                  entries={activeNetworkEntries}
                  onClear={clearActiveNetwork}
                  listKey={activeTabId}
                />
              </View>
            ) : activeDevsoleSection === "elements" ? (
              <View style={{ flex: 1, padding: 10 }}>
                <ElementsSection
                  snapshot={activeElementsSnapshot}
                  listKey={activeTabId}
                  focusPath={activeElementsFocus?.path || null}
                  focusToken={activeElementsFocus?.token || 0}
                  isPicking={activeElementsInspecting}
                  onStartPickElement={() => startElementsPickMode(activeTabId)}
                  onRefresh={(path) => requestElementsSnapshot(activeTabId, path)}
                  onRequestPath={(path) => requestElementsSnapshot(activeTabId, path)}
                  onSaveInlineStyle={(path, styles) =>
                    updateElementsDeclaredStyles(activeTabId, path, styles)
                  }
                  onSaveDirectTextContent={(path, value) =>
                    updateElementsDirectTextContent(activeTabId, path, value)
                  }
                  onSaveAttribute={(path, attributes) =>
                    updateElementsAttributes(activeTabId, path, attributes)
                  }
                />
              </View>
            ) : activeDevsoleSection === "resources" ? (
              <View style={{ flex: 1, padding: 10 }}>
                <ResourcesSection
                  snapshot={activeResourcesSnapshot}
                  listKey={activeTabId}
                  onRefresh={() => requestResourcesSnapshot(activeTabId)}
                  onSetStorageItem={(area, key, value) =>
                    setResourceStorageItem(activeTabId, area, key, value)
                  }
                  onRemoveStorageItem={(area, key) =>
                    removeResourceStorageItem(activeTabId, area, key)
                  }
                  onClearStorageArea={(area) =>
                    clearResourceStorageArea(activeTabId, area)
                  }
                  onSetCookie={(name, value) =>
                    setResourceCookie(activeTabId, name, value)
                  }
                  onRemoveCookie={(name) =>
                    removeResourceCookie(activeTabId, name)
                  }
                />
              </View>
            ) : activeDevsoleSection === "info" ? (
              <View style={{ flex: 1, padding: 10 }}>
                <InfoSection
                  snapshot={activeInfoSnapshot}
                  listKey={activeTabId}
                  onRefresh={() => requestInfoSnapshot(activeTabId)}
                />
              </View>
            ) : activeDevsoleSection === "proxies" ? (
              <View style={{ flex: 1, padding: 10 }}>
                <ProxiesSection
                  trackedPorts={trackedProxyPorts}
                  openPorts={discoveredProxyPorts}
                  isSubmitting={proxyMutationPending}
                  error={proxySectionError}
                  onRefresh={handleRefreshProxyState}
                  onTrackPort={handleTrackProxyPort}
                  onUntrackPort={handleUntrackProxyPort}
                />
              </View>
            ) : (
              <ScrollView
                contentContainerStyle={{
                  padding: 10,
                  gap: 14,
                }}
                showsVerticalScrollIndicator={false}
              >
                <>
              <View
                style={{
                  padding: 16,
                  borderRadius: radius.xl,
                  backgroundColor: colors.bg.raised,
                  gap: 10,
                }}
              >
                <Text
                  style={{
                    color: colors.accent.default,
                    fontSize: 11,
                    fontFamily: fonts.sans.medium,
                    letterSpacing: 0.5,
                  }}
                >
                  {activeDevsoleStub.eyebrow.toUpperCase()}
                </Text>
                <Text
                  style={{
                    color: colors.fg.default,
                    fontSize: 18,
                    lineHeight: 24,
                    fontFamily: fonts.sans.semibold,
                  }}
                >
                  {activeDevsoleStub.title}
                </Text>
                <Text
                  style={{
                    color: colors.fg.muted,
                    fontSize: 13,
                    lineHeight: 20,
                    fontFamily: fonts.sans.regular,
                  }}
                >
                  {activeDevsoleStub.description}
                </Text>
              </View>

              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                {activeDevsoleStub.metrics.map((metric) => (
                  <View
                    key={metric.label}
                    style={{
                      minWidth: 96,
                      paddingHorizontal: 12,
                      paddingVertical: 10,
                      borderRadius: radius.lg,
                      backgroundColor: colors.bg.raised,
                      borderWidth: 1,
                      borderColor: colors.bg.raised,
                      gap: 3,
                    }}
                  >
                    <Text
                      style={{
                        color: colors.fg.subtle,
                        fontSize: 10,
                        fontFamily: fonts.sans.medium,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                      }}
                    >
                      {metric.label}
                    </Text>
                    <Text
                      style={{
                        color: colors.fg.default,
                        fontSize: 14,
                        fontFamily: fonts.mono.medium,
                      }}
                    >
                      {metric.value}
                    </Text>
                  </View>
                ))}
              </View>

              <View
                style={{
                  padding: 16,
                  borderRadius: radius.xl,
                  backgroundColor: colors.bg.base,
                  borderWidth: 1,
                  borderColor: colors.bg.raised,
                  gap: 12,
                }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <Text
                    style={{
                      color: colors.fg.default,
                      fontSize: 15,
                      fontFamily: fonts.sans.semibold,
                    }}
                  >
                    Planned behavior
                  </Text>
                  <Text
                    style={{
                      color: colors.fg.subtle,
                      fontSize: 11,
                      fontFamily: fonts.sans.medium,
                    }}
                  >
                    STUB UI
                  </Text>
                </View>

                {activeDevsoleStub.bullets.map((item) => (
                  <View
                    key={item}
                    style={{
                      flexDirection: "row",
                      alignItems: "flex-start",
                      gap: 10,
                    }}
                  >
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        marginTop: 7,
                        borderRadius: 999,
                        backgroundColor: colors.accent.default,
                      }}
                    />
                    <Text
                      style={{
                        flex: 1,
                        color: colors.fg.muted,
                        fontSize: 13,
                        lineHeight: 19,
                        fontFamily: fonts.sans.regular,
                      }}
                    >
                      {item}
                    </Text>
                  </View>
                ))}
              </View>

              <View style={{ flexDirection: "row", gap: 10 }}>
                <View
                  style={{
                    flex: 1,
                    padding: 14,
                    borderRadius: radius.lg,
                    backgroundColor: colors.bg.raised,
                    gap: 4,
                  }}
                >
                  <Text
                    style={{
                      color: colors.fg.subtle,
                      fontSize: 10,
                      fontFamily: fonts.sans.medium,
                      textTransform: "uppercase",
                    }}
                  >
                    Active page
                  </Text>
                  <Text
                    numberOfLines={2}
                    style={{
                      color: colors.fg.default,
                      fontSize: 12,
                      lineHeight: 18,
                      fontFamily: fonts.mono.regular,
                    }}
                  >
                    {displayUrl(activeTab?.url || "about:blank")}
                  </Text>
                </View>

                <View
                  style={{
                    flex: 1,
                    padding: 14,
                    borderRadius: radius.lg,
                    backgroundColor: colors.bg.raised,
                    gap: 4,
                  }}
                >
                  <Text
                    style={{
                      color: colors.fg.subtle,
                      fontSize: 10,
                      fontFamily: fonts.sans.medium,
                      textTransform: "uppercase",
                    }}
                  >
                    Current focus
                  </Text>
                  <Text
                    style={{
                      color: colors.fg.default,
                      fontSize: 12,
                      lineHeight: 18,
                      fontFamily: fonts.sans.medium,
                    }}
                  >
                    {DEVSOLE_SECTIONS.find((section) => section.id === activeDevsoleSection)?.hint}
                  </Text>
                </View>
              </View>
                </>
              </ScrollView>
            )}
          </Animated.View>
        )}
      </View>
    </View>
  );
}
