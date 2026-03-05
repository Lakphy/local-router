import { create } from 'zustand';
import type { AppConfig } from '@/types/config';
import {
  fetchConfig,
  saveConfig as apiSaveConfig,
  applyConfig as apiApplyConfig,
} from '@/lib/api';

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

interface ConfigState {
  /** 服务端已保存的配置（基线） */
  config: AppConfig | null;
  /** 用户编辑中的草稿 */
  draft: AppConfig | null;
  /** 正在加载配置 */
  loading: boolean;
  /** 正在保存 */
  saving: boolean;
  /** 正在应用 */
  applying: boolean;
  /** 加载错误 */
  error: string | null;
}

interface ConfigActions {
  loadConfig: () => Promise<void>;
  updateDraft: (updater: (prev: AppConfig) => AppConfig) => void;
  setDraft: (config: AppConfig) => void;
  save: (overrideDraft?: AppConfig) => Promise<boolean>;
  apply: () => Promise<boolean>;
  saveAndApply: (overrideDraft?: AppConfig) => Promise<boolean>;
  reset: () => void;
}

export type ConfigStore = ConfigState & ConfigActions;

export const useConfigStore = create<ConfigStore>((set, get) => ({
  config: null,
  draft: null,
  loading: true,
  saving: false,
  applying: false,
  error: null,

  loadConfig: async () => {
    set({ loading: true, error: null });
    try {
      const cfg = await fetchConfig();
      set({ config: cfg, draft: deepClone(cfg), loading: false });
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '加载配置失败',
        loading: false,
      });
    }
  },

  updateDraft: (updater) => {
    const { draft } = get();
    if (draft) {
      set({ draft: updater(deepClone(draft)) });
    }
  },

  setDraft: (config) => {
    set({ draft: deepClone(config) });
  },

  save: async (overrideDraft?) => {
    const draftToSave = overrideDraft ?? get().draft;
    if (!draftToSave) return false;
    set({ saving: true });
    try {
      await apiSaveConfig(draftToSave);
      const next = deepClone(draftToSave);
      set({ config: next, draft: deepClone(next), saving: false });
      return true;
    } catch (err) {
      set({ saving: false });
      throw err;
    }
  },

  apply: async () => {
    set({ applying: true });
    try {
      await apiApplyConfig();
      set({ applying: false });
      return true;
    } catch (err) {
      set({ applying: false });
      throw err;
    }
  },

  saveAndApply: async (overrideDraft?) => {
    const saved = await get().save(overrideDraft);
    if (!saved) return false;
    return get().apply();
  },

  reset: () => {
    const { config } = get();
    if (config) set({ draft: deepClone(config) });
  },
}));

/** 选择器：草稿是否与基线不同 */
export const selectIsDirty = (s: ConfigStore) =>
  s.config !== null && s.draft !== null && !deepEqual(s.config, s.draft);
