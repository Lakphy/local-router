import type { LogEvent } from './logger';

export interface PublishedLogEvent {
  id: string;
  date: string;
  filePath: string;
  offset: number;
  event: LogEvent;
}

type LogTailSubscriber = (event: PublishedLogEvent) => void;

const subscribers = new Set<LogTailSubscriber>();

export function publishLogEvent(event: PublishedLogEvent): void {
  for (const subscriber of subscribers) {
    try {
      subscriber(event);
    } catch {
      // 单个 SSE 客户端异常不能影响日志写入和其他订阅者。
    }
  }
}

export function subscribeLogEvents(subscriber: LogTailSubscriber): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function getLogTailSubscriberCount(): number {
  return subscribers.size;
}
