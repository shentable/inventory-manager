const { defineConfig } = require('@playwright/test');
const targetBase = process.env.SANDWICH_E2E_BASE_URL;
if (!targetBase) throw new Error('SANDWICH_E2E_BASE_URL is required');
const resolveIp = process.env.SANDWICH_E2E_RESOLVE_IP;
const proxyBase = 'http://127.0.0.1:18767';

module.exports = defineConfig({
  testDir: './web/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: resolveIp ? proxyBase : targetBase,
    viewport: { width: 390, height: 844 },
    locale: 'zh-CN',
    trace: 'retain-on-failure'
  },
  webServer: resolveIp ? {
    command: 'node scripts/vps-e2e-proxy.js',
    url: `${proxyBase}/api/health`,
    reuseExistingServer: false,
    timeout: 15000,
    env: {
      ...process.env,
      SANDWICH_E2E_TARGET: targetBase,
      SANDWICH_E2E_RESOLVE_IP: resolveIp
    }
  } : undefined
});
