-- The call queue view follows the tables' access rules (locked unless using a server-side key),
-- and the public API keys can't read it.
alter view call_queue set (security_invoker = true);
revoke all on call_queue from anon, authenticated;
