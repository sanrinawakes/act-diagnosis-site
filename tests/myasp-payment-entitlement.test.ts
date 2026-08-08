import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const paymentSource = fs.readFileSync(
  path.join(root, 'src/app/api/myasp/payment/route.ts'),
  'utf8'
);

describe('MyASP payment entitlement handling', () => {
  it('records payment entitlement without creating an account, sending a password, or activating an email match', () => {
    expect(paymentSource).toContain("action: 'pending_verification'");
    expect(paymentSource).toContain(".from('pending_activations')");
    expect(paymentSource).not.toContain('auth.admin.createUser');
    expect(paymentSource).not.toContain('sendWelcomeEmail');
    expect(paymentSource).not.toContain("subscription_status: 'active'");
    expect(paymentSource).not.toContain('password');
  });

  it('removes legacy automatic activation triggers from fresh and upgraded databases', () => {
    const legacySignup = fs.readFileSync(
      path.join(root, 'supabase/migrations/006_add_pending_activations.sql'),
      'utf8'
    );
    const legacyPayment = fs.readFileSync(
      path.join(root, 'supabase/migrations/010_auto_activate_on_pending_insert.sql'),
      'utf8'
    );
    const upgrade = fs.readFileSync(
      path.join(root, 'supabase/migrations/023_remove_unsafe_auto_activation.sql'),
      'utf8'
    );

    expect(legacySignup).not.toContain('CREATE TRIGGER trigger_check_pending_activation');
    expect(legacyPayment).not.toContain('create trigger trigger_pending_activation_insert');
    expect(upgrade).toContain('DROP TRIGGER IF EXISTS trigger_check_pending_activation');
    expect(upgrade).toContain('DROP TRIGGER IF EXISTS trigger_pending_activation_insert');
  });
});
