import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');

describe('internal API secret isolation', () => {
  it('does not let monitor credentials authorize support automation actions', () => {
    const automation = fs.readFileSync(
      path.join(root, 'src/app/api/internal/support-automation/route.ts'),
      'utf8'
    );
    const monitor = fs.readFileSync(
      path.join(root, 'src/app/api/monitor/coaching/route.ts'),
      'utf8'
    );

    const automationValidation = automation.slice(
      automation.indexOf('function validateAutomationAuthorization'),
      automation.indexOf('function toSafeText')
    );
    const monitorValidation = monitor.slice(
      monitor.indexOf('function validateMonitorAuthorization'),
      monitor.indexOf('function getBaseUrl')
    );

    expect(automationValidation).toContain('process.env.SUPPORT_AUTOMATION_SECRET');
    expect(automationValidation).not.toContain('MONITORING_CRON_SECRET');
    expect(automationValidation).not.toContain('CRON_SECRET');
    expect(monitorValidation).not.toContain('SUPPORT_AUTOMATION_SECRET');
  });
});
