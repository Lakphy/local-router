import { create } from 'zustand';
import { fetchConfigSchema } from '@/lib/api';

export type DiffMode = 'view' | 'save' | 'saveAndApply';

interface DialogState {
  diffOpen: boolean;
  diffMode: DiffMode;
  rawOpen: boolean;
  rawValue: string;
  rawParseError: string | null;
  schema: Record<string, unknown> | null;
}

interface DialogActions {
  openDiff: (mode: DiffMode) => void;
  setDiffOpen: (open: boolean) => void;
  openRaw: (jsonValue: string) => void;
  setRawOpen: (open: boolean) => void;
  setRawValue: (value: string) => void;
  setRawParseError: (error: string | null) => void;
  loadSchema: () => Promise<void>;
}

export type DialogStore = DialogState & DialogActions;

export const useDialogStore = create<DialogStore>((set) => ({
  diffOpen: false,
  diffMode: 'view',
  rawOpen: false,
  rawValue: '{}',
  rawParseError: null,
  schema: null,

  openDiff: (mode) => set({ diffOpen: true, diffMode: mode }),

  setDiffOpen: (open) => set({ diffOpen: open }),

  openRaw: (jsonValue) =>
    set({ rawOpen: true, rawValue: jsonValue, rawParseError: null }),

  setRawOpen: (open) => set({ rawOpen: open }),

  setRawValue: (value) => set({
    rawValue: value,
    rawParseError: null,
  }),

  setRawParseError: (error) => set({ rawParseError: error }),

  loadSchema: async () => {
    try {
      const schema = await fetchConfigSchema();
      set({ schema });
    } catch (err) {
      console.warn('加载 JSON Schema 失败：', err);
    }
  },
}));
