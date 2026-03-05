export type NormalizedMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type NormalizedContentBlock =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'image';
      url?: string;
      mimeType?: string;
      detail?: string;
      data?: string;
    }
  | {
      type: 'tool_use';
      id?: string;
      name?: string;
      input?: unknown;
      rawInput?: string;
      partial?: boolean;
    }
  | {
      type: 'tool_result';
      toolUseId?: string;
      content?: unknown;
      isError?: boolean;
    }
  | {
      type: 'thinking';
      thinking: string;
      signature?: string;
    }
  | {
      type: 'unknown';
      raw: unknown;
      label?: string;
    };

export interface NormalizedChatMessage {
  role: NormalizedMessageRole;
  blocks: NormalizedContentBlock[];
  source: 'request' | 'response' | 'stream';
  meta?: {
    model?: string;
    stopReason?: string | null;
    usage?: unknown;
    parseWarnings?: string[];
    partial?: boolean;
  };
}

export interface ParsedChatHistory {
  messages: NormalizedChatMessage[];
  warnings: string[];
  stats: {
    inputCount: number;
    outputCount: number;
    streamEventCount: number;
    streamPartial: boolean;
  };
}

export interface RouteParseResult {
  inputMessages: NormalizedChatMessage[];
  outputMessages: NormalizedChatMessage[];
  warnings: string[];
  streamEventCount: number;
  partial: boolean;
}
