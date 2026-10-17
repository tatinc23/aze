-- Newer Supabase projects don't auto-grant table privileges to API roles. The server uses the secret
-- (service_role) key only; anon/authenticated get nothing (RLS is on with no policies as a second lock).
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;

-- Check (expect true, true):
select has_table_privilege('service_role', 'public.settings', 'select') as settings_ok,
       has_table_privilege('service_role', 'public.notes', 'insert') as notes_ok;
