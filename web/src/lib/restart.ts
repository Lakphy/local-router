import { toast } from 'sonner';
import { type ApplyResult, restartServer } from './api';

function isWildcardHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '0:0:0:0:0:0:0:0';
}

async function triggerRestart(listen?: { host: string; port: number }): Promise<void> {
  try {
    const target = await restartServer();
    const dest = listen ?? target;
    const port = dest?.port ?? Number(window.location.port);
    // 管理面板由 daemon 自身托管：监听地址变化后当前页面所在端口会失效，
    // 重启完成后跳转到新地址。通配监听地址（0.0.0.0/::）回退为当前浏览主机名。
    const host = !dest || isWildcardHost(dest.host) ? window.location.hostname : dest.host;
    const url = `${window.location.protocol}//${host}:${port}/admin/`;
    toast.info('服务正在重启，约 2 秒后跳转到新地址…');
    window.setTimeout(() => {
      window.location.href = url;
    }, 2000);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : '重启失败');
  }
}

/**
 * 当 apply 结果表明监听地址变化（host/port/idleTimeout）时，提示用户重启。
 * 这些字段只能通过重新绑定 Bun.serve 生效，无法热更新。
 */
export function promptRestartIfNeeded(result: ApplyResult | null): void {
  if (!result?.restartRequired) return;

  if (!result.canRestart) {
    toast.warning('监听地址已更改，需要手动重启服务后生效', {
      description: '请在终端执行 local-router restart',
      duration: 8000,
    });
    return;
  }

  const listen = result.listen;
  toast.warning('监听地址已更改，需要重启服务才能生效', {
    description: listen ? `重启后服务将监听 ${listen.host}:${listen.port}` : undefined,
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: '立即重启',
      onClick: () => {
        void triggerRestart(listen);
      },
    },
  });
}
