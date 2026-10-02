export default {
  "resolve": {
    "alias": {
      "@shared": "C:\\Users\\20136\\Documents\\ChatGPT\\云监控\\页面注入迁移资料\\工具\\离线测试工程\\src\\shared",
      "vitest": "D:\\云监控\\app\\node_modules\\vitest\\dist\\index.js"
    }
  },
  "root": "C:\\Users\\20136\\Documents\\ChatGPT\\云监控\\页面注入迁移资料\\工具\\离线测试工程",
  "test": {
    "reporters": [
      "default",
      "json"
    ],
    "env": {
      "PDD_HOOK_AUTO_REPLY": "false",
      "PDD_ORDER_SHAPE_CAPTURE_PATH": "",
      "PDD_SEND_CONTEXT": "guest",
      "DY_HOOK_AUTO_REPLY": "false",
      "YZS_SCHEMA_CAPTURE_PATH": ""
    },
    "environment": "node",
    "include": [
      "src/main/integration/pdd*.test.ts",
      "src/main/integration/douyin*.test.ts",
      "src/main/integration/messageSchemaCapture.test.ts"
    ],
    "outputFile": {
      "json": "C:\\Users\\20136\\Documents\\ChatGPT\\云监控\\页面注入迁移资料\\离线测试结果.json"
    }
  },
  "cacheDir": "C:\\Users\\20136\\Documents\\ChatGPT\\云监控\\页面注入迁移资料\\工具\\测试缓存",
  "esbuild": {
    "tsconfigRaw": {
      "compilerOptions": {
        "useDefineForClassFields": true,
        "experimentalDecorators": false,
        "target": "ES2022"
      }
    }
  }
};