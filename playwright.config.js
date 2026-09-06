const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './web/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:18765',
    viewport: { width: 390, height: 844 },
    // 前端按浏览器语言嗅探默认界面语言；测试固定中文环境以保证中文文本断言稳定
    locale: 'zh-CN',
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'server/.venv/bin/python web/e2e/seed.py && cd server && DATABASE_URL=sqlite:///data/e2e.db AUTO_SEED=0 SECRET_KEY=e2e-secret-key-long-enough .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 18765',
    url: 'http://127.0.0.1:18765/api/health',
    reuseExistingServer: false,
    timeout: 30000
  }
});
