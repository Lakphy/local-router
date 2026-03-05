export const openAPISpec = {
  openapi: '3.0.0',
  info: {
    title: 'local-router API',
    version: '1.0.0',
    description: 'AI 模型路由服务 - 支持 OpenAI 和 Anthropic API 协议的统一转发网关',
  },
  servers: [
    {
      url: 'http://localhost:4099',
      description: '本地开发服务器',
    },
  ],
  tags: [
    { name: 'Health', description: '健康检查' },
    { name: 'OpenAI', description: 'OpenAI 兼容 API' },
    { name: 'Anthropic', description: 'Anthropic 兼容 API' },
  ],
  paths: {
    '/': {
      get: {
        tags: ['Health'],
        summary: '服务运行状态',
        description: '返回 local-router 服务是否正常运行',
        responses: {
          '200': {
            description: '服务正常运行',
            content: {
              'text/plain': {
                schema: { type: 'string', example: 'local-router is running' },
              },
            },
          },
        },
      },
    },
    '/api/health': {
      get: {
        tags: ['Health'],
        summary: '健康检查 API',
        description: '返回服务的健康状态',
        responses: {
          '200': {
            description: '健康状态',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    service: { type: 'string', example: 'local-router' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/metrics/logs': {
      get: {
        tags: ['Health'],
        summary: '日志聚合指标',
        description: '读取最近窗口内的事件日志并返回聚合运行指标',
        parameters: [
          {
            name: 'window',
            in: 'query',
            required: false,
            schema: {
              type: 'string',
              enum: ['1h', '6h', '24h'],
              default: '24h',
            },
            description: '统计窗口',
          },
          {
            name: 'refresh',
            in: 'query',
            required: false,
            schema: {
              type: 'string',
              enum: ['0', '1'],
              default: '0',
            },
            description: '是否绕过缓存立即重算',
          },
        ],
        responses: {
          '200': {
            description: '日志统计结果',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    window: { type: 'string', example: '24h' },
                    from: { type: 'string', format: 'date-time' },
                    to: { type: 'string', format: 'date-time' },
                    generatedAt: { type: 'string', format: 'date-time' },
                    source: {
                      type: 'object',
                      properties: {
                        logEnabled: { type: 'boolean' },
                        baseDir: { type: ['string', 'null'] },
                        filesScanned: { type: 'integer' },
                        linesScanned: { type: 'integer' },
                        partial: { type: 'boolean' },
                      },
                    },
                    summary: {
                      type: 'object',
                      properties: {
                        totalRequests: { type: 'integer' },
                        successRequests: { type: 'integer' },
                        errorRequests: { type: 'integer' },
                        successRate: { type: 'number' },
                        avgLatencyMs: { type: 'integer' },
                        p95LatencyMs: { type: 'integer' },
                        totalRequestBytes: { type: 'integer' },
                        totalResponseBytes: { type: 'integer' },
                      },
                    },
                    series: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          ts: { type: 'string', format: 'date-time' },
                          requests: { type: 'integer' },
                          errors: { type: 'integer' },
                          avgLatencyMs: { type: 'integer' },
                        },
                      },
                    },
                    topProviders: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          key: { type: 'string' },
                          requests: { type: 'integer' },
                          errorRate: { type: 'number' },
                          avgLatencyMs: { type: 'integer' },
                        },
                      },
                    },
                    topRouteTypes: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          key: { type: 'string' },
                          requests: { type: 'integer' },
                          errorRate: { type: 'number' },
                        },
                      },
                    },
                    statusClasses: {
                      type: 'object',
                      properties: {
                        '2xx': { type: 'integer' },
                        '4xx': { type: 'integer' },
                        '5xx': { type: 'integer' },
                        network_error: { type: 'integer' },
                      },
                    },
                    warnings: {
                      type: 'array',
                      items: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          '400': {
            description: '请求参数错误',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
          '500': {
            description: '日志统计读取失败',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/logs/events': {
      get: {
        tags: ['Health'],
        summary: '日志事件检索',
        description: '按时间窗口与过滤条件检索事件日志，支持游标分页',
        parameters: [
          {
            name: 'window',
            in: 'query',
            required: false,
            schema: {
              type: 'string',
              enum: ['1h', '6h', '24h'],
              default: '24h',
            },
            description: '时间窗口（当未提供 from/to 时生效）',
          },
          {
            name: 'from',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'date-time' },
            description: '起始时间（ISO）',
          },
          {
            name: 'to',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'date-time' },
            description: '结束时间（ISO）',
          },
          {
            name: 'levels',
            in: 'query',
            required: false,
            schema: { type: 'string', example: 'info,error' },
            description: '日志级别，逗号分隔',
          },
          {
            name: 'provider',
            in: 'query',
            required: false,
            schema: { type: 'string', example: 'openai' },
            description: 'provider 过滤（支持逗号分隔）',
          },
          {
            name: 'routeType',
            in: 'query',
            required: false,
            schema: { type: 'string', example: 'openai-completions' },
            description: 'routeType 过滤（支持逗号分隔）',
          },
          {
            name: 'model',
            in: 'query',
            required: false,
            schema: { type: 'string', example: 'gpt-4o-mini' },
            description: 'model 过滤（支持逗号分隔）',
          },
          {
            name: 'statusClass',
            in: 'query',
            required: false,
            schema: { type: 'string', example: '2xx,5xx' },
            description: '状态分类过滤（2xx/4xx/5xx/network_error）',
          },
          {
            name: 'hasError',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['true', 'false', '1', '0'] },
            description: '是否仅返回错误',
          },
          {
            name: 'q',
            in: 'query',
            required: false,
            schema: { type: 'string', maxLength: 200 },
            description: '关键词检索',
          },
          {
            name: 'sort',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['time_desc', 'time_asc'], default: 'time_desc' },
            description: '时间排序',
          },
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            description: '每页数量',
          },
          {
            name: 'cursor',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: '游标',
          },
        ],
        responses: {
          '200': {
            description: '日志事件分页结果',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          ts: { type: 'string', format: 'date-time' },
                          level: { type: 'string', enum: ['info', 'error'] },
                          provider: { type: 'string' },
                          routeType: { type: 'string' },
                          model: { type: 'string' },
                          path: { type: 'string' },
                          requestId: { type: 'string' },
                          latencyMs: { type: 'integer' },
                          upstreamStatus: { type: 'integer' },
                          statusClass: {
                            type: 'string',
                            enum: ['2xx', '4xx', '5xx', 'network_error'],
                          },
                          hasError: { type: 'boolean' },
                          message: { type: 'string' },
                          errorType: { type: ['string', 'null'] },
                        },
                      },
                    },
                    nextCursor: { type: ['string', 'null'] },
                    hasMore: { type: 'boolean' },
                    stats: {
                      type: 'object',
                      properties: {
                        total: { type: 'integer' },
                        errorCount: { type: 'integer' },
                        errorRate: { type: 'number' },
                        avgLatencyMs: { type: 'integer' },
                        p95LatencyMs: { type: 'integer' },
                      },
                    },
                    meta: {
                      type: 'object',
                      properties: {
                        scannedFiles: { type: 'integer' },
                        scannedLines: { type: 'integer' },
                        parseErrors: { type: 'integer' },
                        truncated: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': {
            description: '请求参数错误',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
          '500': {
            description: '日志检索失败',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/logs/events/{id}': {
      get: {
        tags: ['Health'],
        summary: '日志事件详情',
        description: '获取单条日志详情（已脱敏）与原始定位信息',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: '日志事件 ID',
          },
        ],
        responses: {
          '200': {
            description: '日志详情',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    summary: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        ts: { type: 'string', format: 'date-time' },
                        level: { type: 'string', enum: ['info', 'error'] },
                        provider: { type: 'string' },
                        routeType: { type: 'string' },
                        requestId: { type: 'string' },
                        latencyMs: { type: 'integer' },
                        upstreamStatus: { type: 'integer' },
                        statusClass: {
                          type: 'string',
                          enum: ['2xx', '4xx', '5xx', 'network_error'],
                        },
                        hasError: { type: 'boolean' },
                        model: { type: 'string' },
                      },
                    },
                    request: {
                      type: 'object',
                      properties: {
                        method: { type: 'string' },
                        path: { type: 'string' },
                        contentType: { type: ['string', 'null'] },
                        requestHeadersMasked: {
                          type: 'object',
                          additionalProperties: { type: 'string' },
                        },
                        requestBody: { type: ['object', 'array', 'string', 'number', 'boolean', 'null'] },
                      },
                    },
                    response: {
                      type: 'object',
                      properties: {
                        upstreamStatus: { type: 'integer' },
                        contentType: { type: ['string', 'null'] },
                        responseHeaders: {
                          type: 'object',
                          additionalProperties: { type: 'string' },
                        },
                        responseBody: { type: ['string', 'null'] },
                      },
                    },
                    upstream: {
                      type: 'object',
                      properties: {
                        targetUrl: { type: 'string' },
                        providerRequestId: { type: ['string', 'null'] },
                        errorType: { type: ['string', 'null'] },
                        errorMessage: { type: ['string', 'null'] },
                        isStream: { type: 'boolean' },
                        streamFile: { type: ['string', 'null'] },
                        streamContent: { type: ['string', 'null'] },
                      },
                    },
                    capture: {
                      type: 'object',
                      properties: {
                        bodyPolicy: { type: 'string', enum: ['off', 'masked', 'full', 'unknown'] },
                        requestBodyAvailable: { type: 'boolean' },
                        responseBodyAvailable: { type: 'boolean' },
                        streamCaptured: { type: 'boolean' },
                        truncatedHints: {
                          type: 'array',
                          items: { type: 'string' },
                        },
                      },
                    },
                    rawEvent: { type: 'object' },
                    location: {
                      type: 'object',
                      properties: {
                        date: { type: 'string' },
                        line: { type: 'integer' },
                        file: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': {
            description: '请求参数错误',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { error: { type: 'string' } },
                },
              },
            },
          },
          '404': {
            description: '日志不存在',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { error: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    '/api/logs/export': {
      get: {
        tags: ['Health'],
        summary: '导出日志',
        description: '按当前筛选条件导出日志子集（受服务端上限保护）',
        parameters: [
          {
            name: 'format',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: ['csv', 'json'] },
            description: '导出格式',
          },
          {
            name: 'window',
            in: 'query',
            required: false,
            schema: {
              type: 'string',
              enum: ['1h', '6h', '24h'],
              default: '24h',
            },
            description: '时间窗口',
          },
          {
            name: 'from',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'date-time' },
          },
          {
            name: 'to',
            in: 'query',
            required: false,
            schema: { type: 'string', format: 'date-time' },
          },
          {
            name: 'levels',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'provider',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'routeType',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'model',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'statusClass',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'hasError',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['true', 'false', '1', '0'] },
          },
          {
            name: 'q',
            in: 'query',
            required: false,
            schema: { type: 'string', maxLength: 200 },
          },
          {
            name: 'sort',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['time_desc', 'time_asc'], default: 'time_desc' },
          },
        ],
        responses: {
          '200': {
            description: '导出成功',
            content: {
              'text/csv': {
                schema: {
                  type: 'string',
                  format: 'binary',
                },
              },
              'application/json': {
                schema: {
                  type: 'string',
                  format: 'binary',
                },
              },
            },
          },
          '400': {
            description: '请求参数错误',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { error: { type: 'string' } },
                },
              },
            },
          },
          '500': {
            description: '导出失败',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { error: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    '/api/logs/tail': {
      get: {
        tags: ['Health'],
        summary: '实时日志追踪 (SSE)',
        description: '按过滤条件持续推送新增日志摘要（可选能力）',
        parameters: [
          {
            name: 'window',
            in: 'query',
            required: false,
            schema: {
              type: 'string',
              enum: ['1h', '6h', '24h'],
              default: '1h',
            },
          },
          {
            name: 'levels',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'provider',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'routeType',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'model',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'statusClass',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'hasError',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['true', 'false', '1', '0'] },
          },
          {
            name: 'q',
            in: 'query',
            required: false,
            schema: { type: 'string', maxLength: 200 },
          },
          {
            name: 'sort',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['time_desc', 'time_asc'], default: 'time_desc' },
          },
        ],
        responses: {
          '200': {
            description: 'SSE 实时流',
            content: {
              'text/event-stream': {
                schema: {
                  type: 'string',
                  description: 'SSE 事件流（ready/events/heartbeat/error）',
                },
              },
            },
          },
          '400': {
            description: '请求参数错误',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { error: { type: 'string' } },
                },
              },
            },
          },
          '500': {
            description: '实时流建立失败',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { error: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    '/openai-completions/v1/chat/completions': {
      post: {
        tags: ['OpenAI'],
        summary: 'OpenAI 聊天完成',
        description: 'OpenAI 兼容的聊天完成接口，支持流式和非流式响应',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['model', 'messages'],
                properties: {
                  model: {
                    type: 'string',
                    description: '模型名称或别名（在配置中定义）',
                    example: 'your-model-alias-or-name',
                  },
                  messages: {
                    type: 'array',
                    description: '聊天消息列表',
                    items: {
                      type: 'object',
                      required: ['role', 'content'],
                      properties: {
                        role: {
                          type: 'string',
                          enum: ['system', 'user', 'assistant'],
                          description: '消息角色',
                        },
                        content: {
                          type: 'string',
                          description: '消息内容',
                        },
                      },
                    },
                    example: [{ role: 'user', content: '请回复 ok' }],
                  },
                  stream: {
                    type: 'boolean',
                    description: '是否使用流式响应',
                    default: false,
                  },
                  temperature: {
                    type: 'number',
                    description: '采样温度（0-2）',
                    minimum: 0,
                    maximum: 2,
                  },
                  max_tokens: {
                    type: 'integer',
                    description: '最大生成 token 数',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: '成功响应',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    object: { type: 'string' },
                    created: { type: 'integer' },
                    model: { type: 'string' },
                    choices: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          index: { type: 'integer' },
                          message: {
                            type: 'object',
                            properties: {
                              role: { type: 'string' },
                              content: { type: 'string' },
                            },
                          },
                          finish_reason: { type: 'string' },
                        },
                      },
                    },
                    usage: {
                      type: 'object',
                      properties: {
                        prompt_tokens: { type: 'integer' },
                        completion_tokens: { type: 'integer' },
                        total_tokens: { type: 'integer' },
                      },
                    },
                  },
                },
              },
              'text/event-stream': {
                schema: {
                  type: 'string',
                  description: '流式响应（SSE 格式）',
                },
              },
            },
          },
          '400': {
            description: '请求错误',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
          '404': {
            description: '模型路由未找到',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/openai-responses/v1/responses': {
      post: {
        tags: ['OpenAI'],
        summary: 'OpenAI 响应 API',
        description: 'OpenAI 响应接口，用于获取模型响应',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['model', 'input'],
                properties: {
                  model: {
                    type: 'string',
                    description: '模型名称或别名',
                    example: 'your-model-alias-or-name',
                  },
                  input: {
                    type: 'string',
                    description: '输入文本',
                    example: '请回复 ok',
                  },
                  stream: {
                    type: 'boolean',
                    description: '是否使用流式响应',
                    default: false,
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: '成功响应',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    model: { type: 'string' },
                    output: { type: 'string' },
                  },
                },
              },
            },
          },
          '400': {
            description: '请求错误',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
          '404': {
            description: '模型路由未找到',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/anthropic-messages/v1/messages': {
      post: {
        tags: ['Anthropic'],
        summary: 'Anthropic 消息 API',
        description: 'Anthropic Claude 消息接口，支持流式和非流式响应',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['model', 'messages', 'max_tokens'],
                properties: {
                  model: {
                    type: 'string',
                    description: '模型名称或别名',
                    example: 'sonnet',
                  },
                  messages: {
                    type: 'array',
                    description: '聊天消息列表',
                    items: {
                      type: 'object',
                      required: ['role', 'content'],
                      properties: {
                        role: {
                          type: 'string',
                          enum: ['user', 'assistant'],
                          description: '消息角色',
                        },
                        content: {
                          type: 'string',
                          description: '消息内容',
                        },
                      },
                    },
                    example: [{ role: 'user', content: '请回复 ok' }],
                  },
                  max_tokens: {
                    type: 'integer',
                    description: '最大生成 token 数',
                    example: 64,
                  },
                  stream: {
                    type: 'boolean',
                    description: '是否使用流式响应',
                    default: false,
                  },
                  temperature: {
                    type: 'number',
                    description: '采样温度（0-1）',
                    minimum: 0,
                    maximum: 1,
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: '成功响应',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    type: { type: 'string' },
                    role: { type: 'string' },
                    model: { type: 'string' },
                    content: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          type: { type: 'string' },
                          text: { type: 'string' },
                        },
                      },
                    },
                    usage: {
                      type: 'object',
                      properties: {
                        input_tokens: { type: 'integer' },
                        output_tokens: { type: 'integer' },
                      },
                    },
                  },
                },
              },
              'text/event-stream': {
                schema: {
                  type: 'string',
                  description: '流式响应（SSE 格式）',
                },
              },
            },
          },
          '400': {
            description: '请求错误',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
          '404': {
            description: '模型路由未找到',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
