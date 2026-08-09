-- Previous versions activated an account whenever its email matched a payment
-- record. A new account can be created before an email is verified, so that
-- automatic match is not proof of ownership. Use migration 019's code flow.
DROP TRIGGER IF EXISTS trigger_check_pending_activation ON public.profiles;
DROP TRIGGER IF EXISTS trigger_pending_activation_insert ON public.pending_activations;
DROP FUNCTION IF EXISTS public.check_pending_activation();
DROP FUNCTION IF EXISTS public.handle_pending_activation_insert();

NOTIFY pgrst, 'reload schema';
