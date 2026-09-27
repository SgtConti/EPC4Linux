// Tray menu labels, reproduced from the vendor table `Gf` (01 §5, work/app-pretty/main/index.js:12723-12804).
// Only the entries the Linux tray shows are kept: "Check for Updates" and "Feedback" are online
// features and "Log in" was never built into the 1.13.0 menu. The first item, "Precision Center",
// is not translated by the vendor either.

export const TRAY_LANGUAGES = ['en', 'zh-cn', 'zh-tw', 'ja', 'ko', 'ru', 'es', 'pt', 'fr', 'de'] as const;
export type TrayLanguage = (typeof TRAY_LANGUAGES)[number];

export interface TrayLabels {
  Rescan: string;
  Settings: string;
  Exit: string;
}

export const TRAY_TITLE = 'Precision Center';

export const TRAY_LABELS: Readonly<Record<TrayLanguage, TrayLabels>> = {
  en: { Rescan: 'Rescan', Settings: 'Settings', Exit: 'Exit' },
  'zh-cn': { Rescan: '重新扫描', Settings: '设置', Exit: '退出' },
  'zh-tw': { Rescan: '重新掃描', Settings: '設置', Exit: '退出' },
  ja: { Rescan: '再スキャン', Settings: 'Settings（設定）', Exit: '終了' },
  ko: { Rescan: '다시 검색', Settings: '설정', Exit: '종료' },
  ru: { Rescan: 'Повторное сканирование', Settings: 'Настройки', Exit: 'Выход' },
  es: { Rescan: 'Volver a explorar', Settings: 'Configuración', Exit: 'Cerrar' },
  pt: { Rescan: 'Reanalisar', Settings: 'Definições', Exit: 'Sair' },
  fr: { Rescan: 'Nouvelle analyse', Settings: 'Paramètres', Exit: 'Fermer' },
  de: { Rescan: 'Erneut scannen', Settings: 'Einstellungen', Exit: 'Beenden' },
};

function isTrayLanguage(v: string): v is TrayLanguage {
  return (TRAY_LANGUAGES as readonly string[]).includes(v);
}

/**
 * Vendor constructor logic (01 §3.2): lower-case, "zh" → "zh-cn", anything unsupported → "en".
 * Returns the normalized code and whether the stored value had to change.
 */
export function normalizeLanguage(stored: unknown): { language: TrayLanguage; changed: boolean } {
  const raw = typeof stored === 'string' ? stored : '';
  let lang = raw.toLowerCase();
  if (lang === 'zh') lang = 'zh-cn';
  if (!isTrayLanguage(lang)) return { language: 'en', changed: raw !== 'en' };
  return { language: lang, changed: lang !== raw };
}

/** Vendor `Jf`: unknown codes fall back to English. */
export function trayLabels(language: string): TrayLabels {
  return isTrayLanguage(language) ? TRAY_LABELS[language] : TRAY_LABELS.en;
}
