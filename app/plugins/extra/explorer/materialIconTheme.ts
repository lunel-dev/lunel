import { generateManifest } from 'material-icon-theme';

type ExplorerEntryLike = {
  name: string;
  type: 'file' | 'directory';
};

const ICON_THEME_VERSION = '5.33.1';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/material-icon-theme@${ICON_THEME_VERSION}/icons/`;
const ICONS_PREFIX = './../icons/';

const manifest = generateManifest();
const fileNameToIconKey: Record<string, string> = Object.fromEntries(
  Object.entries(manifest.fileNames ?? {}).map(([name, iconKey]) => [name.toLowerCase(), iconKey])
);
const extensionToIconKey: Record<string, string> = Object.fromEntries(
  Object.entries(manifest.fileExtensions ?? {}).map(([extension, iconKey]) => [extension.toLowerCase(), iconKey])
);

const extensionFallbacks: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  html: 'html',
  shtml: 'html',
  yaml: 'yaml',
  yml: 'yaml',
  m: 'objective-c',
  mm: 'objective-cpp',
  xcscheme: 'settings',
  xcconfig: 'settings',
  xcworkspacedata: 'settings',
  xcfilelist: 'settings',
  xcuserstate: 'settings',
  xcprivacy: 'settings',
  pbxproj: 'settings',
  entitlements: 'settings',
  storyboard: 'xml',
  modulemap: 'c',
  pch: 'c',
  plist: 'xml',
};
const fileNameFallbacks: Record<string, string> = {
  podfile: 'ruby',
};

const getIconKeyFromEntry = (entry: ExplorerEntryLike): string => {
  const fileNameLower = entry.name.toLowerCase();

  if (entry.type === 'directory') {
    return manifest.folder;
  }

  const exactFileKey = fileNameToIconKey[fileNameLower] ?? fileNameFallbacks[fileNameLower];
  if (exactFileKey) return exactFileKey;

  const parts = fileNameLower.split('.');
  if (parts.length > 1) {
    for (let i = 1; i < parts.length; i += 1) {
      const extension = parts.slice(i).join('.');
      const extensionKey = extensionToIconKey[extension];
      if (extensionKey) return extensionKey;
    }

    for (let i = parts.length - 1; i >= 1; i -= 1) {
      const extension = parts[i];
      const extensionKey = extensionToIconKey[extension];
      if (extensionKey) return extensionKey;
    }

    const lastExtension = parts[parts.length - 1];

    const directIconKey = manifest.iconDefinitions?.[lastExtension] ? lastExtension : undefined;
    if (directIconKey) return directIconKey;

    const fallbackKey = extensionFallbacks[lastExtension];
    if (fallbackKey) return fallbackKey;
  }

  return manifest.file;
};

export const resolveMaterialIconUri = (entry: ExplorerEntryLike): string | null => {
  const iconKey = getIconKeyFromEntry(entry);
  const iconPath = manifest.iconDefinitions?.[iconKey]?.iconPath;
  if (!iconPath) return null;
  const normalized = iconPath.startsWith(ICONS_PREFIX) ? iconPath.slice(ICONS_PREFIX.length) : iconPath;
  return `${CDN_BASE}${normalized}`;
};
