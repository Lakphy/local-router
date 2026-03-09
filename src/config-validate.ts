import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { AppConfig } from './config';
import { getBundledSchemaPath } from './runtime-assets';

export function validateBusinessRules(config: AppConfig): void {
  for (const [routeType, modelMap] of Object.entries(config.routes)) {
    if (!modelMap['*']) {
      throw new Error(`路由 "${routeType}" 缺少 "*" 兜底规则`);
    }
    for (const target of Object.values(modelMap)) {
      if (!config.providers[target.provider]) {
        throw new Error(`路由 "${routeType}" 引用了不存在的 provider "${target.provider}"`);
      }
    }
  }
}

export function validateConfigOrThrow(config: AppConfig): void {
  validateBusinessRules(config);

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schemaJson = JSON.parse(readFileSync(getBundledSchemaPath(), 'utf-8')) as Record<string, unknown>;
  const validateBySchema = ajv.compile(schemaJson);
  const valid = validateBySchema(config);
  if (!valid) {
    const firstError = validateBySchema.errors?.[0];
    const path = firstError?.instancePath || '(root)';
    const message = firstError?.message ?? 'unknown schema validation error';
    throw new Error(`Schema 校验失败: ${path} ${message}`);
  }
}
