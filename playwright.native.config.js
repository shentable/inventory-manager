const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './web/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: { baseURL: 'http://127.0.0.1:18766', viewport: { width: 390, height: 844 }, locale: 'zh-CN', trace: 'retain-on-failure' },
  webServer: {
    command: 'server/.venv/bin/python web/e2e/seed.py && native-server/target/debug/sandwich-server serve --db server/data/e2e.db --secret-file native-server/test-secret.txt --listen 127.0.0.1:18766 --app-version e2e',
    url: 'http://127.0.0.1:18766/api/health',
    reuseExistingServer: false,
    timeout: 30000
  }
});
