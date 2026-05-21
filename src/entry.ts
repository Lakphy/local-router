import { createDefaultAppFromProcessArgs } from './index';
import { REMOTE_ADDRESS_ENV_KEY } from './network-access';

const app = await createDefaultAppFromProcessArgs();

export default {
  hostname: process.env.HOST ?? '0.0.0.0',
  port: Number.parseInt(process.env.PORT ?? '4099', 10),
  fetch(request: Request, server: { requestIP(request: Request): { address: string } | null }) {
    const remoteAddress = server.requestIP(request)?.address ?? null;
    return app.fetch(request, {
      [REMOTE_ADDRESS_ENV_KEY]: remoteAddress,
    });
  },
};
