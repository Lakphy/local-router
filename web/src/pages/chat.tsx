import { ExpandIcon, SendIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const MOCK_PROVIDER_MODELS: Record<string, string[]> = {
  openai: ["gpt-4o-mini", "gpt-4.1"],
  anthropic: ["claude-3-5-sonnet", "claude-3-7-sonnet"],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
};

export function ChatPage() {
  const providerOptions = Object.keys(MOCK_PROVIDER_MODELS);
  const [provider, setProvider] = useState<string>(providerOptions[0] ?? "");
  const modelOptions = useMemo(
    () => MOCK_PROVIDER_MODELS[provider] ?? [],
    [provider],
  );
  const [model, setModel] = useState<string>(modelOptions[0] ?? "");

  useEffect(() => {
    setModel(modelOptions[0] ?? "");
  }, [modelOptions]);

  return (
    <div className="h-full">
      <div className="flex flex-col h-full">
        <div className="flex-1">chat history</div>
        <div className="rounded-3xl border p-2">
          <textarea
            className="w-full h-10 resize-none mx-1 focus:outline-none"
            placeholder="Think Different..."
          />
          <div className="flex items-center gap-2">
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger className="h-9 w-40 rounded-full">
                <SelectValue placeholder="选择 Provider" />
              </SelectTrigger>
              <SelectContent>
                {providerOptions.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={model} onValueChange={setModel}>
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
            <div className="flex-1" />
            <Button variant="outline" size="icon" className="rounded-full">
              <ExpandIcon className="w-4 h-4" />
            </Button>
            <Button variant="default" size="icon" className="rounded-full">
              <SendIcon className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
