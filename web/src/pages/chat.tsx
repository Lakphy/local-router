import {
  ExpandIcon,
  LoaderCircle,
  SparklesIcon,
  ShrinkIcon,
  SendIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useConfigStore } from "@/stores/config-store";
import type { ProviderConfig } from "@/types/config";

type ChatRole = "user" | "assistant";

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  provider: string;
  model: string;
  error?: boolean;
}

interface ProviderOption {
  key: string;
  config: ProviderConfig;
  models: string[];
}

function createMessageId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function isProviderUsable(provider: ProviderConfig) {
  return (
    provider.base.trim().length > 0 &&
    provider.apiKey.trim().length > 0 &&
    Object.keys(provider.models ?? {}).length > 0
  );
}

export function ChatPage() {
  const config = useConfigStore((s) => s.draft ?? s.config);
  const providerOptions = useMemo<ProviderOption[]>(
    () =>
      Object.entries(config?.providers ?? {})
        .filter(([, provider]) => isProviderUsable(provider))
        .map(([key, provider]) => ({
          key,
          config: provider,
          models: Object.keys(provider.models).sort((a, b) =>
            a.localeCompare(b),
          ),
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    [config],
  );

  const [provider, setProvider] = useState<string>(
    providerOptions[0]?.key ?? "",
  );
  const activeProvider =
    providerOptions.find((item) => item.key === provider) ?? providerOptions[0];
  const modelOptions = useMemo(
    () => activeProvider?.models ?? [],
    [activeProvider],
  );
  const [model, setModel] = useState<string>(modelOptions[0] ?? "");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!activeProvider) {
      setProvider("");
      setModel("");
      return;
    }

    if (activeProvider.key !== provider) {
      setProvider(activeProvider.key);
    }
  }, [activeProvider, provider]);

  useEffect(() => {
    if (modelOptions.includes(model)) return;
    setModel(modelOptions[0] ?? "");
  }, [model, modelOptions]);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [messages, isSending]);

  const canSend =
    !isSending && input.trim().length > 0 && !!activeProvider && !!model;

  async function handleSend() {
    const prompt = input.trim();
    if (!prompt || !activeProvider || !model || isSending) return;

    const userMessage: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content: prompt,
      provider: activeProvider.key,
      model,
    };
    const assistantMessageId = createMessageId();

    setMessages((current) => [
      ...current,
      userMessage,
      {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        provider: activeProvider.key,
        model,
      },
    ]);
    setInput("");
    setIsSending(true);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const history = [...messages, userMessage].map((message) => ({
        role: message.role,
        content: message.content,
      }));

      const response = await fetch("/api/chat/proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider: activeProvider.key,
          model,
          messages: history,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `请求失败: ${response.status}`);
      }

      if (!response.body) {
        throw new Error("代理接口未返回流");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantMessageId
              ? { ...message, content: text }
              : message,
          ),
        );
      }

      text += decoder.decode();
      const finalText = text.trim() || " ";
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantMessageId
            ? { ...message, content: finalText }
            : message,
        ),
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantMessageId
              ? { ...message, content: message.content || "已停止生成" }
              : message,
          ),
        );
        return;
      }

      const message = error instanceof Error ? error.message : "请求失败";
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessageId
            ? {
                ...item,
                content: item.content || `请求失败：${message}`,
                error: true,
              }
            : item,
        ),
      );
      toast.error(message);
    } finally {
      abortControllerRef.current = null;
      setIsSending(false);
    }
  }

  function handleStop() {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }

  function handleClear() {
    if (isSending) {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    }
    setMessages([]);
  }

  return (
    <div className="h-full">
      <div className="flex h-full flex-col">
        <div className="flex-1 min-h-0">
          <ScrollArea className="h-full" viewportRef={scrollViewportRef}>
            <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-4 px-1 py-4">
              {messages.length === 0 ? (
                <div className="flex flex-1 items-center justify-center">
                  <div className="w-full rounded-[2rem] border bg-linear-to-br from-background via-muted/10 to-muted/30 p-6 shadow-xs">
                    <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
                      <div className="max-w-2xl">
                        <div className="mb-4 inline-flex items-center gap-2 rounded-full border bg-background/80 px-3 py-1 text-xs text-muted-foreground">
                          <SparklesIcon className="size-3.5" />
                          Chat Playground
                        </div>
                        <h2 className="text-3xl font-semibold tracking-tight">
                          直接开始一轮真实对话
                        </h2>
                        <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
                          当前聊天页通过本地代理统一转发到你配置的 provider。
                          不做消息持久化，适合临时验证模型、路由和响应体验。
                        </p>

                        <div className="mt-5 flex flex-wrap gap-2">
                          <div className="rounded-full border bg-background px-3 py-1.5 text-xs text-muted-foreground">
                            Provider
                            <span className="ml-2 font-medium text-foreground">
                              {activeProvider?.key || "未配置"}
                            </span>
                          </div>
                          <div className="rounded-full border bg-background px-3 py-1.5 text-xs text-muted-foreground">
                            Model
                            <span className="ml-2 font-medium text-foreground">
                              {model || "未选择"}
                            </span>
                          </div>
                        </div>
                      </div>

                    </div>
                  </div>
                </div>
              ) : (
                messages.map((message) => (
                  <div
                    key={message.id}
                    className={cn(
                      "w-full px-1 py-1",
                      message.role === "user"
                        ? "rounded-3xl border border-primary/20 bg-primary/5 px-4 py-3"
                        : "px-4 py-3",
                      message.error && "border-destructive/40",
                    )}
                  >
                    {message.role === "assistant" ? (
                      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span>Assistant</span>
                        <span>{message.provider}</span>
                        <span>/</span>
                        <span>{message.model}</span>
                      </div>
                    ) : null}
                    <div className="whitespace-pre-wrap break-words text-sm leading-6">
                      {message.content ||
                        (isSending && message.role === "assistant"
                          ? "..."
                          : "")}
                    </div>
                    {message.role === "user" ? (
                      <div className="mt-2 text-right text-[11px] text-muted-foreground">
                        {message.provider} / {message.model}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
        </div>

        <div className="mx-auto w-full max-w-4xl px-1">
          <div className="rounded-3xl border p-2">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSend();
                }
              }}
              disabled={!activeProvider || !model}
              className={cn(
                "w-full resize-none bg-transparent px-1 focus:outline-none",
                expanded ? "h-28" : "h-10",
              )}
              placeholder={
                activeProvider
                  ? `发消息给 ${activeProvider.key} / ${model || "未选择模型"}`
                  : "先配置可用 provider"
              }
            />
            <TooltipProvider>
              <div className="flex items-center gap-2">
                <Select
                  value={provider}
                  onValueChange={setProvider}
                  disabled={providerOptions.length === 0}
                >
                  <SelectTrigger className="h-9 w-64 rounded-full">
                    <SelectValue placeholder="选择 Provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {providerOptions.map((item) => (
                      <SelectItem key={item.key} value={item.key}>
                        {item.key}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={model}
                  onValueChange={setModel}
                  disabled={!activeProvider}
                >
                  <SelectTrigger className="h-9 w-48 rounded-full">
                    <SelectValue placeholder="选择 Model" />
                  </SelectTrigger>
                  <SelectContent>
                    {modelOptions.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex-1 "></div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="rounded-full"
                      onClick={() => setExpanded((value) => !value)}
                    >
                      {expanded ? (
                        <ShrinkIcon className="w-4 h-4" />
                      ) : (
                        <ExpandIcon className="w-4 h-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {expanded ? "收起输入框" : "展开输入框"}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="rounded-full"
                      onClick={handleClear}
                      disabled={messages.length === 0 && !isSending}
                    >
                      <Trash2Icon className="w-4 h-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">清空消息</TooltipContent>
                </Tooltip>
                {isSending ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="rounded-full"
                        onClick={handleStop}
                      >
                        <SquareIcon className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">停止生成</TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="default"
                        size="icon"
                        className="rounded-full"
                        onClick={() => void handleSend()}
                        disabled={!canSend}
                      >
                        {isSending ? (
                          <LoaderCircle className="w-4 h-4 animate-spin" />
                        ) : (
                          <SendIcon className="w-4 h-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">发送消息</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </TooltipProvider>
          </div>
        </div>
      </div>
    </div>
  );
}
