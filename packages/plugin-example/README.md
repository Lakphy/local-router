# local-router-plugin-example

local-router 示例插件，演示插件开发的最佳实践。

## 功能

- **onRequest**: 在请求头中注入 `x-plugin-timestamp` 和 `x-plugin-tag`
- **onResponse**: 在 JSON 响应中注入 `_plugin_meta` 元数据字段
- **onSSEResponse**: 在每个 SSE chunk 后追加注释行
- **onError**: 将错误信息输出到 console
- **dispose**: 输出处理统计并清理

## 配置

```json5
{
  providers: {
    "my-provider": {
      // ...
      plugins: [
        { "package": "./packages/plugin-example", "params": { "tag": "demo" } }
      ]
    }
  }
}
```

## 参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `tag` | `string` | `"example"` | 注入到请求头和响应元数据中的标记 |
