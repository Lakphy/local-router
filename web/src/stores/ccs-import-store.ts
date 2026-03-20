import { create } from 'zustand';
import { fetchCCSProviders, importCCSProviders } from '@/lib/api';
import type { CCSProviderInfo } from '@/types/config';

interface CCSImportState {
  providers: CCSProviderInfo[];
  dbExists: boolean;
  loading: boolean;
  error: string | null;
  importing: boolean;
  importResult: { imported: string[]; skipped: string[] } | null;
}

interface CCSImportActions {
  fetchProviders: (db?: string) => Promise<void>;
  importSelected: (ids: string[], db?: string) => Promise<void>;
  clearResult: () => void;
}

export type CCSImportStore = CCSImportState & CCSImportActions;

export const useCCSImportStore = create<CCSImportStore>((set) => ({
  providers: [],
  dbExists: false,
  loading: false,
  error: null,
  importing: false,
  importResult: null,

  fetchProviders: async (db) => {
    set({ loading: true, error: null });
    try {
      const data = await fetchCCSProviders(db);
      set({ providers: data.providers, dbExists: data.dbExists, loading: false });
    } catch (err) {
      set({
        loading: false,
        dbExists: false,
        error: err instanceof Error ? err.message : '获取 CCS 供应商列表失败',
      });
    }
  },

  importSelected: async (ids, db) => {
    set({ importing: true, error: null, importResult: null });
    try {
      const result = await importCCSProviders(ids, db);
      set({ importing: false, importResult: result });
    } catch (err) {
      set({
        importing: false,
        error: err instanceof Error ? err.message : '导入失败',
      });
    }
  },

  clearResult: () => {
    set({ importResult: null });
  },
}));
